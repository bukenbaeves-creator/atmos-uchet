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
async function syncTariffAccrual(
  tx: PrismaClientOrTx,
  op: { id: number; dateOp: Date | null },
  part: { payeeId: number; anesthesiaType: string | null },
  scheme: Record<string, any>,
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
    eventDate: op.dateOp!,
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

  // Обрабатываем участников со схемой типа share_based. Анестезиолог (тариф) считается
  // на уровне ведомости целиком за период — здесь пропускаем.
  for (const part of effective) {
   try {
    const scheme = await getSchemeForDate(part.payeeId, op.dateOp, tx);
    if (!scheme) continue; // нет схемы → «Сигналы» (см. Э2-4/дашборд)

    // Анестезиолог (тариф): одно начисление на операцию по НИЖНЕЙ ставке. Фактическая
    // ступень и «Корректировка ставки по итогу месяца» определяются при утверждении
    // месячной ведомости (Э6-1, ТЗ 2.12/4.6).
    if (scheme.kind === 'tariff_based') {
      await syncTariffAccrual(tx, op, part, scheme as unknown as Record<string, any>);
      continue;
    }

    const calcScheme = buildCalcScheme(scheme as unknown as Record<string, any>, componentsById);

    const existing = await tx.payoutAccrual.findMany({
      where: { operationId: op.id, payeeId: part.payeeId, isCorrection: false },
    });
    const byTrigger = new Map<number, (typeof existing)[number]>();
    for (const e of existing) if (e.triggerPaymentId != null) byTrigger.set(e.triggerPaymentId, e);

    let cumulativePaid = 0;
    let priorCumulative = 0; // целевая накопленная сумма (по расчёту, независимо от блокировок)
    let lastSharePct = 0;
    const seenPaymentIds = new Set<number>();

    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      const sign = p.direction === 'refund' ? -1 : 1;
      cumulativePaid += sign * toNum(p.amount);
      seenPaymentIds.add(p.id);

      // Комиссия считается по фактически поступившим платежам → передаём платежи до события.
      const paymentsSoFar = payments.slice(0, i + 1).map((x) => ({
        amount: toNum(x.amount),
        terminal: x.terminal,
        date: x.date ? toISODate(x.date) : operationInput.dateOp,
        direction: (x.direction as 'payment' | 'refund') ?? 'payment',
      }));
      const calc = calcPayout({ operation: operationInput, payments: paymentsSoFar, scheme: calcScheme, acquiringRates, materialsFact, materialNorm });

      const ratio = base > 0 ? Math.min(1, cumulativePaid / base) : 0;
      const targetCumulative = round2(calc.amountFull * ratio);
      const delta = round2(targetCumulative - priorCumulative);
      priorCumulative = targetCumulative;
      lastSharePct = calc.sharePct;

      const data = {
        schemeId: scheme.id,
        schemeVersion: scheme.version,
        triggerPaymentId: p.id,
        eventDate: p.date ?? op.dateOp,
        isCorrection: false,
        base,
        paidRatio: ratio,
        sharePct: calc.sharePct,
        components: calc.components as unknown as object,
        amountFull: calc.amountFull,
        amount: delta,
        calcTrace: calc.calcTrace as unknown as object,
      };

      const ex = byTrigger.get(p.id);
      if (ex) {
        // Заблокированные/оплаченные не трогаем никогда (неизменность ведомости).
        if (ex.status === 'free') await tx.payoutAccrual.update({ where: { id: ex.id }, data });
      } else {
        await tx.payoutAccrual.create({ data: { ...data, payeeId: part.payeeId, operationId: op.id } });
      }
    }

    // Осиротевшие свободные начисления (платёж удалён) — убрать (только free).
    for (const e of existing) {
      if (e.triggerPaymentId != null && !seenPaymentIds.has(e.triggerPaymentId) && e.status === 'free') {
        await tx.payoutAccrual.delete({ where: { id: e.id } });
      }
    }

    // Корректировка (Э3-2, тест Т14): если из-за возврата/правки целевой итог не сходится
    // с суммой уже существующих начислений (в т.ч. заблокированных в ведомости), заводим
    // одно свободное авто-начисление-корректировку на разницу (eventDate = сегодня).
    const after = await tx.payoutAccrual.findMany({ where: { operationId: op.id, payeeId: part.payeeId } });
    const autoCorr = after.find((a) => a.isCorrection && a.triggerPaymentId === null && a.status === 'free');
    const sumExcl = after.filter((a) => a.id !== autoCorr?.id).reduce((s, a) => s + Number(a.amount), 0);
    const need = round2(priorCumulative - sumExcl);
    if (Math.abs(need) >= 0.005) {
      const corrData = {
        schemeId: scheme.id,
        schemeVersion: scheme.version,
        triggerPaymentId: null,
        eventDate: new Date(),
        isCorrection: true,
        base,
        paidRatio: base > 0 ? Math.min(1, cumulativePaid / base) : 0,
        sharePct: lastSharePct,
        components: [] as unknown as object,
        amountFull: priorCumulative,
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
  for (const p of await tx.doctorPayee.findMany({ where: { deletedAt: null, active: true, dictionaryLabel: { not: null } }, select: { id: true, dictionaryLabel: true } })) {
    if (p.dictionaryLabel) payeesByLabel.set(p.dictionaryLabel.trim(), p.id);
  }
  return { acquiringRates, componentsById, payeesByLabel };
}
