import { prisma } from '../lib/prisma.js';
import { KPI_DEFAULTS } from '../constants.js';
import { computeOperation } from './compute.js';

const KONS_ATTENDED = 'Прошёл консультацию';

export interface KpiRates {
  consultationOnline: number;
  consultationOffline: number;
  operation: number;
}

// Ставки: онлайн/офлайн консультация + операция. Если новые ключи ещё не заданы —
// берём старую единую ставку консультации (kpi_consultation_rate) как значение по
// умолчанию для обеих, чтобы при переходе ничего не сбросилось.
export async function getRates(): Promise<KpiRates> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['kpi_consultation_online_rate', 'kpi_consultation_offline_rate', 'kpi_consultation_rate', 'kpi_operation_rate'] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const legacy = map.kpi_consultation_rate ?? KPI_DEFAULTS.kpi_consultation_rate;
  return {
    consultationOnline: Number(map.kpi_consultation_online_rate ?? legacy),
    consultationOffline: Number(map.kpi_consultation_offline_rate ?? legacy),
    operation: Number(map.kpi_operation_rate ?? KPI_DEFAULTS.kpi_operation_rate),
  };
}

export async function setRates(rates: KpiRates): Promise<KpiRates> {
  const upsert = (key: string, value: number) =>
    prisma.setting.upsert({ where: { key }, update: { value: String(value) }, create: { key, value: String(value) } });
  await upsert('kpi_consultation_online_rate', rates.consultationOnline);
  await upsert('kpi_consultation_offline_rate', rates.consultationOffline);
  await upsert('kpi_operation_rate', rates.operation);
  return getRates();
}

export type Period = 'month' | 'quarter' | 'year';

// Диапазон периода в UTC (согласованно с хранением дат как UTC-полночь).
// Полуоткрытый интервал [from, toExclusive): весь конечный день входит через lt.
export function periodRange(
  period: Period,
  dateStr?: string,
): { from: Date; toExclusive: Date; label: string } {
  const ref = dateStr ? new Date(dateStr + 'T00:00:00.000Z') : new Date();
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  if (period === 'year') {
    return { from: new Date(Date.UTC(y, 0, 1)), toExclusive: new Date(Date.UTC(y + 1, 0, 1)), label: String(y) };
  }
  if (period === 'quarter') {
    const qStart = Math.floor(m / 3) * 3;
    return {
      from: new Date(Date.UTC(y, qStart, 1)),
      toExclusive: new Date(Date.UTC(y, qStart + 3, 1)),
      label: `${Math.floor(qStart / 3) + 1} кв. ${y}`,
    };
  }
  return {
    from: new Date(Date.UTC(y, m, 1)),
    toExclusive: new Date(Date.UTC(y, m + 1, 1)),
    label: `${String(m + 1).padStart(2, '0')}.${y}`,
  };
}

// Отчёт KPI по менеджерам за пресетный период (месяц/квартал/год)
export async function kpiReport(period: Period, dateStr?: string) {
  const { from, toExclusive, label } = periodRange(period, dateStr);
  return computeReward(from, toExclusive, label);
}

// Отчёт KPI по произвольному диапазону дат (общий период страницы KPI).
export async function kpiReportRange(fromStr: string, toStr: string) {
  const from = new Date(fromStr + 'T00:00:00.000Z');
  const toExclusive = new Date(toStr + 'T00:00:00.000Z');
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1); // конечный день включительно
  return computeReward(from, toExclusive, `${fromStr} — ${toStr}`);
}

// Общий расчёт вознаграждения по менеджерам за [from, toExclusive).
// В расчёт попадают только УЖЕ СОСТОЯВШИЕСЯ события (дата <= сейчас).
// Консультация учитывается, если: статус = «Прошёл консультацию», заполнен итог (stage)
// и есть оплата ЛИБО согласование админа (для бесплатных). Операция — только при 100% оплате.
// Все «выпавшие» категории возвращаются отдельными списками для прозрачности.
async function computeReward(from: Date, toExclusive: Date, label: string) {
  const rates = await getRates();
  const now = new Date();

  const patientSel = { patient: { select: { fio: true } } } as const;
  const [consAll, opsAll] = await Promise.all([
    prisma.consultation.findMany({
      where: {
        deletedAt: null,
        manager: { not: null },
        patient: { is: { deletedAt: null } },
        dateKons: { gte: from, lt: toExclusive, lte: now },
      },
      include: patientSel,
      orderBy: { dateKons: 'asc' },
    }),
    prisma.operation.findMany({
      where: {
        deletedAt: null,
        manager: { not: null },
        patient: { is: { deletedAt: null } },
        dateOp: { gte: from, lt: toExclusive, lte: now },
      },
      include: { ...patientSel, payments: { where: { deletedAt: null } } },
      orderBy: { dateOp: 'asc' },
    }),
  ]);

  const hasStage = (s: string | null) => !!s && s.trim() !== '';
  // Классификация консультаций
  const countedCons: typeof consAll = [];
  const notAttendedCons: typeof consAll = [];
  const excludedCons: typeof consAll = []; // прошёл, но без итога
  const pendingCons: typeof consAll = []; // прошёл + итог, но без оплаты и без согласования
  for (const c of consAll) {
    if (c.konsStatus !== KONS_ATTENDED) {
      notAttendedCons.push(c);
    } else if (!hasStage(c.stage)) {
      excludedCons.push(c);
    } else if (Number(c.amount ?? 0) <= 0 && !c.kpiApproved) {
      pendingCons.push(c);
    } else {
      countedCons.push(c);
    }
  }
  // Классификация операций: в расчёт только оплаченные на 100%
  const countedOps: typeof opsAll = [];
  const unpaidOps: typeof opsAll = [];
  for (const o of opsAll) {
    if (computeOperation(o as never).fullyPaid) countedOps.push(o);
    else unpaidOps.push(o);
  }

  // Счётчики по менеджеру: онлайн (vid='Онлайн') / офлайн / операции.
  const byManager = new Map<string, { manager: string; online: number; offline: number; operations: number }>();
  const ensure = (m: string) => {
    if (!byManager.has(m)) byManager.set(m, { manager: m, online: 0, offline: 0, operations: 0 });
    return byManager.get(m)!;
  };
  for (const c of countedCons) {
    if (!c.manager) continue;
    const r = ensure(c.manager);
    if (c.vid === 'Онлайн') r.online += 1;
    else r.offline += 1;
  }
  for (const o of countedOps) if (o.manager) ensure(o.manager).operations += 1;

  const rows = [...byManager.values()]
    .map((r) => ({
      manager: r.manager,
      consultationsOnline: r.online,
      consultationsOffline: r.offline,
      operations: r.operations,
      amount: r.online * rates.consultationOnline + r.offline * rates.consultationOffline + r.operations * rates.operation,
    }))
    .sort((a, b) => b.amount - a.amount);

  const totals = rows.reduce(
    (acc, r) => {
      acc.consultationsOnline += r.consultationsOnline;
      acc.consultationsOffline += r.consultationsOffline;
      acc.operations += r.operations;
      acc.amount += r.amount;
      return acc;
    },
    { consultationsOnline: 0, consultationsOffline: 0, operations: 0, amount: 0 },
  );

  // Расшифровка расчёта — конкретные записи по каждой категории.
  const consultations = countedCons.map((c) => ({
    id: c.id,
    manager: c.manager,
    patientFio: c.patient?.fio ?? null,
    dateKons: c.dateKons?.toISOString() ?? null,
    vid: c.vid,
    interestOperation: c.interestOperation,
    doctor: c.doctor,
    stage: c.stage,
    konsStatus: c.konsStatus,
    dateZapis: c.dateZapis?.toISOString() ?? null,
    amount: c.amount != null ? Number(c.amount) : null,
  }));
  const operations = countedOps.map((o) => ({
    id: o.id,
    manager: o.manager,
    patientFio: o.patient?.fio ?? null,
    dateOp: o.dateOp?.toISOString() ?? null,
    opType: o.opType,
    surgeon: o.surgeon,
    cost: o.cost != null ? Number(o.cost) : null,
  }));
  const excludedConsultations = excludedCons.map((c) => ({
    id: c.id,
    manager: c.manager,
    patientFio: c.patient?.fio ?? null,
    dateKons: c.dateKons?.toISOString() ?? null,
    interestOperation: c.interestOperation,
    doctor: c.doctor,
    dateZapis: c.dateZapis?.toISOString() ?? null,
  }));
  const notAttended = notAttendedCons.map((c) => ({
    id: c.id,
    manager: c.manager,
    patientFio: c.patient?.fio ?? null,
    dateKons: c.dateKons?.toISOString() ?? null,
    doctor: c.doctor,
    konsStatus: c.konsStatus,
  }));
  const pendingApproval = pendingCons.map((c) => ({
    id: c.id,
    manager: c.manager,
    patientFio: c.patient?.fio ?? null,
    dateKons: c.dateKons?.toISOString() ?? null,
    vid: c.vid,
    doctor: c.doctor,
    comment: c.kpiComment,
    approved: c.kpiApproved,
  }));
  const operationsUnpaid = unpaidOps.map((o) => {
    const comp = computeOperation(o as never);
    return {
      id: o.id,
      manager: o.manager,
      patientFio: o.patient?.fio ?? null,
      dateOp: o.dateOp?.toISOString() ?? null,
      opType: o.opType,
      surgeon: o.surgeon,
      cost: o.cost != null ? Number(o.cost) : null,
      paid: comp.paid,
      balance: comp.balance,
    };
  });

  return {
    label,
    from: from.toISOString(),
    to: toExclusive.toISOString(),
    rates,
    rows,
    totals,
    consultations,
    operations,
    excludedConsultations,
    excludedNoStageCount: excludedConsultations.length,
    notAttended,
    pendingApproval,
    operationsUnpaid,
  };
}
