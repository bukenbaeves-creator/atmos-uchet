import { prisma } from '../lib/prisma.js';
import { KPI_DEFAULTS } from '../constants.js';

export interface KpiRates {
  consultation: number;
  operation: number;
}

export async function getRates(): Promise<KpiRates> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['kpi_consultation_rate', 'kpi_operation_rate'] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    consultation: Number(map.kpi_consultation_rate ?? KPI_DEFAULTS.kpi_consultation_rate),
    operation: Number(map.kpi_operation_rate ?? KPI_DEFAULTS.kpi_operation_rate),
  };
}

export async function setRates(rates: KpiRates): Promise<KpiRates> {
  await prisma.setting.upsert({
    where: { key: 'kpi_consultation_rate' },
    update: { value: String(rates.consultation) },
    create: { key: 'kpi_consultation_rate', value: String(rates.consultation) },
  });
  await prisma.setting.upsert({
    where: { key: 'kpi_operation_rate' },
    update: { value: String(rates.operation) },
    create: { key: 'kpi_operation_rate', value: String(rates.operation) },
  });
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

// Отчёт KPI по менеджерам за период
export async function kpiReport(period: Period, dateStr?: string) {
  const { from, toExclusive, label } = periodRange(period, dateStr);
  const rates = await getRates();

  // Записи удалённых пациентов не учитываем в KPI.
  const [cons, ops] = await Promise.all([
    prisma.consultation.groupBy({
      by: ['manager'],
      where: {
        deletedAt: null,
        manager: { not: null },
        patient: { is: { deletedAt: null } },
        dateKons: { gte: from, lt: toExclusive },
      },
      _count: { _all: true },
    }),
    prisma.operation.groupBy({
      by: ['manager'],
      where: {
        deletedAt: null,
        manager: { not: null },
        patient: { is: { deletedAt: null } },
        dateOp: { gte: from, lt: toExclusive },
      },
      _count: { _all: true },
    }),
  ]);

  const byManager = new Map<string, { manager: string; consultations: number; operations: number }>();
  const ensure = (m: string) => {
    if (!byManager.has(m)) byManager.set(m, { manager: m, consultations: 0, operations: 0 });
    return byManager.get(m)!;
  };
  for (const c of cons) if (c.manager) ensure(c.manager).consultations = c._count._all;
  for (const o of ops) if (o.manager) ensure(o.manager).operations = o._count._all;

  const rows = [...byManager.values()]
    .map((r) => ({
      ...r,
      amount: r.consultations * rates.consultation + r.operations * rates.operation,
    }))
    .sort((a, b) => b.amount - a.amount);

  const totals = rows.reduce(
    (acc, r) => {
      acc.consultations += r.consultations;
      acc.operations += r.operations;
      acc.amount += r.amount;
      return acc;
    },
    { consultations: 0, operations: 0, amount: 0 },
  );

  return {
    period,
    label,
    from: from.toISOString(),
    to: toExclusive.toISOString(),
    rates,
    rows,
    totals,
  };
}
