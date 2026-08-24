import type { PrismaClientOrTx } from '../lib/prisma.js';
import { round2 } from './compute.js';
import {
  calcPayout,
  lowestAnesthesiaRate,
  type CalcComponentInput,
  type CalcScheme,
  type AcquiringRateInput,
  type AnesthesiaTariffInput,
} from './payout-calc.service.js';
import { getSchemeForDate } from './payout-scheme.service.js';

// ===================== Событийный движок начислений (Э2-2) =====================
// Начисление — событие поступления денег, а не строка за месяц. Для каждого платежа
// пересчитываем «должно быть начислено всего» = amountFull(платежи до события) × коэффициент
// оплаты и оформляем разницу отдельным начислением. Идемпотентно: повторный пересчёт не
// плодит дублей (начисления привязаны к triggerPaymentId).

const toNum = (v: unknown): number => (v == null ? 0 : Number(v));
const toISODate = (d: Date): string => d.toISOString().slice(0, 10);
const fmtRuDate = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

type ComponentRow = { id: number; code: string; name: string; valueSource: string; direction: string; operationField: string | null };

// Собираем CalcScheme (вход чистой функции) из строк БД схемы.
export function buildCalcScheme(dbScheme: Record<string, any>, componentsById: Map<number, ComponentRow>): CalcScheme {
  const shareBySource: Record<string, number> = {};
  for (const sv of dbScheme.shareValues ?? []) shareBySource[sv.key] = Number(sv.share);
  const components: CalcComponentInput[] = (dbScheme.items ?? []).map((it: Record<string, any>) => {
    const comp = componentsById.get(it.componentId);
    if (!comp) throw new Error(`Компонент id=${it.componentId} не найден`);
    return {
      code: comp.code,
      label: comp.name,
      valueSource: comp.valueSource as CalcComponentInput['valueSource'],
      direction: comp.direction as CalcComponentInput['direction'],
      operationField: comp.operationField,
      stage: it.stage as CalcComponentInput['stage'],
      enabled: it.enabled,
      useOwnValue: it.useOwnValue,
      value: it.value == null ? null : Number(it.value),
    };
  });
  return {
    kind: dbScheme.kind,
    shareMode: dbScheme.shareMode,
    shareValue: dbScheme.shareValue == null ? null : Number(dbScheme.shareValue),
    shareBySource,
    components,
  };
}

// Начисление анестезиолога по операции: одно на операцию, по нижней ставке тарифа.
// eventDate — дата права (операция проведена + оплачена 100%).
async function syncTariffAccrual(
  tx: PrismaClientOrTx,
  op: { id: number; dateOp: Date | null },
  part: { payeeId: number; anesthesiaType: string | null },
  scheme: Record<string, any>,
  eventDate: Date,
) {
  const type = part.anesthesiaType ?? 'общий';
  const tariffs: AnesthesiaTariffInput[] = (scheme.tariffs ?? []).map((t: Record<string, any>) => ({
    anesthesiaType: t.anesthesiaType,
    minCount: t.minCount,
    maxCount: t.maxCount,
    amount: Number(t.amount),
  }));
  const lowest = lowestAnesthesiaRate(tariffs, type);
  const existing = await tx.payoutAccrual.findMany({ where: { operationId: op.id, payeeId: part.payeeId } });
  if (lowest == null) {
    for (const e of existing) if (e.status === 'free') await tx.payoutAccrual.delete({ where: { id: e.id } });
    return;
  }
  const data = {
    schemeId: scheme.id,
    schemeVersion: scheme.version,
    triggerPaymentId: null,
    eventDate,
    isCorrection: false,
    base: lowest,
    paidRatio: 1,
    sharePct: 1,
    components: [{ code: 'anesthesia_tariff', label: `Наркоз (тариф, ${type})`, stage: 'after_share', direction: 'addition', amount: lowest, anesthesiaType: type }] as unknown as object,
    amountFull: lowest,
    amount: lowest,
    calcTrace: [{ label: `Тариф «${type}» (нижняя ставка)`, value: lowest }] as unknown as object,
  };
  const ex = existing.find((e) => !e.isCorrection && e.triggerPaymentId === null);
  if (ex) {
    if (ex.status === 'free') await tx.payoutAccrual.update({ where: { id: ex.id }, data });
  } else {
    await tx.payoutAccrual.create({ data: { ...data, payeeId: part.payeeId, operationId: op.id } });
  }
  // Платёж-триггерные начисления для тарифа не нужны — убрать свободные, если появились.
  for (const e of existing) if (e.triggerPaymentId !== null && e.status === 'free') await tx.payoutAccrual.delete({ where: { id: e.id } });
}

// Преднагруженный справочный контекст для массового пересчёта («данные читать пакетно»):
// ставки и компоненты одинаковы для всех операций, поэтому их можно загрузить один раз.
export interface RecalcContext {
  acquiringRates?: AcquiringRateInput[];
  componentsById?: Map<number, ComponentRow>;
  payeesByLabel?: Map<string, number>; // dictionaryLabel → payeeId (для вывода из Operation.surgeon)
  payeeNames?: Map<number, string>; // payeeId → ФИО (для понятных причин пропуска)
  errors?: { operationId: number; message: string }[]; // причины пропуска расчёта (для сводки пересчёта)
}

// Пересчёт всех начислений по операции. Вызывать в той же транзакции, что и триггер.
export async function recalcOperation(operationId: number, tx: PrismaClientOrTx, ctx?: RecalcContext): Promise<void> {
  const op = await tx.operation.findFirst({
    where: { id: operationId, deletedAt: null },
    include: {
      participants: true,
      payments: { where: { deletedAt: null } },
      writeoffs: { where: { deletedAt: null } },
    },
  });
  if (!op) {
    await tx.payoutAccrual.deleteMany({ where: { operationId, status: 'free' } });
    return;
  }
  if (!op.dateOp) return;

  // Эффективные участники = явные OperationParticipant + выведенные из строковых полей
  // операции (Operation.surgeon / anesthesiologist) по метке справочника получателя.
  // Это позволяет считать выплаты по УЖЕ имеющимся операциям без ручного ввода участников.
  type Eff = { payeeId: number; anesthesiaType: string | null; role: string };
  const effective: Eff[] = op.participants.map((p) => ({ payeeId: p.payeeId, anesthesiaType: p.anesthesiaType, role: p.role }));
  const payeeByLabel = async (label: string | null): Promise<number | null> => {
    const key = label?.trim();
    if (!key) return null;
    if (ctx?.payeesByLabel) return ctx.payeesByLabel.get(key) ?? null;
    const p = await tx.doctorPayee.findFirst({ where: { dictionaryLabel: key, deletedAt: null, active: true }, select: { id: true } });
    return p?.id ?? null;
  };
  if (!effective.some((e) => e.role === 'surgeon')) {
    const pid = await payeeByLabel(op.surgeon);
    if (pid) effective.push({ payeeId: pid, anesthesiaType: null, role: 'surgeon' });
  }
  if (!effective.some((e) => e.role === 'anesthesiologist')) {
    const pid = await payeeByLabel(op.anesthesiologist);
    if (pid) effective.push({ payeeId: pid, anesthesiaType: null, role: 'anesthesiologist' });
  }
  // Нет ни одного получателя → снять свободные начисления и выйти (заблокированные не трогаем).
  if (effective.length === 0) {
    await tx.payoutAccrual.deleteMany({ where: { operationId, status: 'free' } });
    return;
  }

  const acquiringRates: AcquiringRateInput[] =
    ctx?.acquiringRates ??
    (await tx.acquiringRate.findMany({})).map((r) => ({
      terminal: r.terminal,
      ratePct: Number(r.ratePct),
      validFrom: toISODate(r.validFrom),
    }));
  // Факт со склада: сумма себестоимости списаний; при отсутствии списаний — null (подставится норматив).
  const materialsFact = op.writeoffs.length ? round2(op.writeoffs.reduce((s, w) => s + Number(w.costTotal), 0)) : null;
  let materialNorm: number | null = null;
  if (op.opType) {
    const norm = await tx.materialNorm.findFirst({
      where: { opType: op.opType, validFrom: { lte: op.dateOp } },
      orderBy: { validFrom: 'desc' },
    });
    materialNorm = norm ? Number(norm.amount) : null;
  }

  const componentsById =
    ctx?.componentsById ??
    new Map<number, ComponentRow>((await tx.calcComponent.findMany({})).map((c) => [c.id, c as unknown as ComponentRow]));

  // Платежи по возрастанию даты (при равенстве — по id).
  const payments = [...op.payments].sort((a, b) => {
    const da = a.date ? a.date.getTime() : 0;
    const db = b.date ? b.date.getTime() : 0;
    return da !== db ? da - db : a.id - b.id;
  });

  const operationInput = {
    cost: toNum(op.cost),
    anesthesiaCost: toNum(op.anesthesiaCost),
    implantsCost: toNum(op.implantsCost),
    assistantCost: toNum(op.assistantCost),
    zapis: op.zapis,
    opType: op.opType,
    dateOp: toISODate(op.dateOp),
  };
  const base = operationInput.cost + operationInput.anesthesiaCost;

  // ПРАВО НА ВЫПЛАТУ (правило клиники): операция ПРОВЕДЕНА и оплачена на 100%.
  // Никаких частичных начислений с предоплат: одно начисление на полную сумму.
  // Дата права = max(дата операции, дата платежа, закрывшего 100%) — поэтому
  // операция, оплаченная заранее, попадает в ведомость месяца ПРОВЕДЕНИЯ.
  const paidTotal = payments.reduce((s, p) => s + (p.direction === 'refund' ? -1 : 1) * toNum(p.amount), 0);
  // База 0 (стоимость не заполнена) — права нет: иначе фиксы схемы дают минусовые начисления.
  const fullyPaid = base > 0 && paidTotal + 0.005 >= base;
  // Причина пропуска — для сводки кнопки «Пересчитать» (чтобы было понятно, почему
  // врача нет в ведомости). Одна запись на операцию.
  if (!fullyPaid) {
    ctx?.errors?.push({
      operationId: op.id,
      message: base > 0 ? 'Операция не оплачена на 100% — права на выплату пока нет' : 'У операции не заполнена стоимость (база 0)',
    });
  }
  let closingDate: Date | null = null; // дата платежа, закрывшего 100%
  let closingId: number | null = null;
  if (fullyPaid) {
    let cum = 0;
    for (const p of payments) {
      cum += (p.direction === 'refund' ? -1 : 1) * toNum(p.amount);
      if (cum + 0.005 >= base) {
        closingDate = p.date ?? op.dateOp;
        closingId = p.id;
        break;
      }
    }
  }
  const rightDate = closingDate && closingDate.getTime() > op.dateOp.getTime() ? closingDate : op.dateOp;

  for (const part of effective) {
   try {
    const scheme = await getSchemeForDate(part.payeeId, op.dateOp, tx);
    if (!scheme) {
      // Нет действующей схемы — понятная причина в сводку пересчёта.
      let fio = ctx?.payeeNames?.get(part.payeeId);
      if (!fio) fio = (await tx.doctorPayee.findUnique({ where: { id: part.payeeId }, select: { fio: true } }))?.fio ?? `#${part.payeeId}`;
      ctx?.errors?.push({ operationId: op.id, message: `Нет действующей схемы у «${fio}» на дату операции (проверьте «Действует с»)` });
      continue;
    }

    // Анестезиолог (тариф): одно начисление на операцию по НИЖНЕЙ ставке — тоже только
    // после проведения и полной оплаты. Ступень месяца — при утверждении месячной ведомости.
    if (scheme.kind === 'tariff_based') {
      if (!fullyPaid) {
        await tx.payoutAccrual.deleteMany({ where: { operationId: op.id, payeeId: part.payeeId, status: 'free' } });
        continue;
      }
      await syncTariffAccrual(tx, op, part, scheme as unknown as Record<string, any>, rightDate);
      continue;
    }

    const calcScheme = buildCalcScheme(scheme as unknown as Record<string, any>, componentsById);

    const existing = await tx.payoutAccrual.findMany({
      where: { operationId: op.id, payeeId: part.payeeId, isCorrection: false },
    });

    let target = 0; // целевая сумма начислений по операции (0, пока право не наступило)
    let lastSharePct = 0;

    if (fullyPaid) {
      const allPayments = payments.map((x) => ({
        amount: toNum(x.amount),
        terminal: x.terminal,
        date: x.date ? toISODate(x.date) : operationInput.dateOp,
        direction: (x.direction as 'payment' | 'refund') ?? 'payment',
      }));
      const calc = calcPayout({ operation: operationInput, payments: allPayments, scheme: calcScheme, acquiringRates, materialsFact, materialNorm });
      target = round2(calc.amountFull);
      lastSharePct = calc.sharePct;

      const data = {
        schemeId: scheme.id,
        schemeVersion: scheme.version,
        triggerPaymentId: closingId,
        eventDate: rightDate,
        isCorrection: false,
        base,
        paidRatio: 1,
        sharePct: calc.sharePct,
        components: calc.components as unknown as object,
        amountFull: calc.amountFull,
        amount: target,
        calcTrace: [
          ...calc.calcTrace,
          { label: `Право на выплату: операция проведена ${fmtRuDate(op.dateOp)}, оплачена 100% ${fmtRuDate(rightDate)}` },
        ] as unknown as object,
      };

      const lockedNonCorr = existing.filter((e) => e.status !== 'free');
      const freeNonCorr = existing.filter((e) => e.status === 'free');
      if (lockedNonCorr.length === 0) {
        // Обычный путь: одно свободное начисление на полную сумму.
        if (freeNonCorr.length > 0) {
          await tx.payoutAccrual.update({ where: { id: freeNonCorr[0].id }, data });
          for (const e of freeNonCorr.slice(1)) await tx.payoutAccrual.delete({ where: { id: e.id } });
        } else {
          await tx.payoutAccrual.create({ data: { ...data, payeeId: part.payeeId, operationId: op.id } });
        }
      } else {
        // Номинал уже зафиксирован в ведомости (locked/paid) — свободные дубли убрать,
        // расхождение с целевой суммой закроет корректировка ниже.
        for (const e of freeNonCorr) await tx.payoutAccrual.delete({ where: { id: e.id } });
      }
    } else {
      // Право не наступило (не проведена / оплата неполная): свободные начисления снять.
      for (const e of existing) if (e.status === 'free') await tx.payoutAccrual.delete({ where: { id: e.id } });
    }

    // Корректировка: если целевая сумма не сходится с суммой существующих начислений
    // (например возврат после утверждённой ведомости → право отпало целиком), заводим
    // одно свободное авто-начисление-корректировку на разницу (eventDate = сегодня).
    const after = await tx.payoutAccrual.findMany({ where: { operationId: op.id, payeeId: part.payeeId } });
    const autoCorr = after.find((a) => a.isCorrection && a.triggerPaymentId === null && a.status === 'free');
    const sumExcl = after.filter((a) => a.id !== autoCorr?.id).reduce((s, a) => s + Number(a.amount), 0);
    const need = round2(target - sumExcl);
    if (Math.abs(need) >= 0.005) {
      const corrData = {
        schemeId: scheme.id,
        schemeVersion: scheme.version,
        triggerPaymentId: null,
        eventDate: new Date(),
        isCorrection: true,
        base,
        paidRatio: fullyPaid ? 1 : base > 0 ? Math.min(1, paidTotal / base) : 0,
        sharePct: lastSharePct,
        components: [] as unknown as object,
        amountFull: target,
        amount: need,
        calcTrace: [{ label: 'Корректировка по итогу пересчёта', value: need }] as unknown as object,
      };
      if (autoCorr) await tx.payoutAccrual.update({ where: { id: autoCorr.id }, data: corrData });
      else await tx.payoutAccrual.create({ data: { ...corrData, payeeId: part.payeeId, operationId: op.id } });
    } else if (autoCorr) {
      await tx.payoutAccrual.delete({ where: { id: autoCorr.id } });
    }
   } catch (e) {
     // Ошибка расчёта по участнику (нет доли для источника, нет ставки эквайринга,
     // кривая схема) НЕ должна ломать кассу/операции. Причину собираем для сводки
     // массового пересчёта, чтобы пользователь понял, почему начислений нет.
     ctx?.errors?.push({ operationId: op.id, message: e instanceof Error ? e.message : 'ошибка расчёта' });
     continue;
   }
  }
}

// Пакетная загрузка справочного контекста для массового пересчёта (Э2-4).
export async function loadRecalcContext(tx: PrismaClientOrTx): Promise<RecalcContext> {
  const acquiringRates: AcquiringRateInput[] = (await tx.acquiringRate.findMany({})).map((r) => ({
    terminal: r.terminal,
    ratePct: Number(r.ratePct),
    validFrom: toISODate(r.validFrom),
  }));
  const componentsById = new Map<number, ComponentRow>(
    (await tx.calcComponent.findMany({})).map((c) => [c.id, c as unknown as ComponentRow]),
  );
  const payeesByLabel = new Map<string, number>();
  const payeeNames = new Map<number, string>();
  for (const p of await tx.doctorPayee.findMany({ where: { deletedAt: null }, select: { id: true, fio: true, dictionaryLabel: true, active: true } })) {
    payeeNames.set(p.id, p.fio);
    if (p.active && p.dictionaryLabel) payeesByLabel.set(p.dictionaryLabel.trim(), p.id);
  }
  return { acquiringRates, componentsById, payeesByLabel, payeeNames };
}
