import { prisma } from '../lib/prisma.js';
import { KPI_DEFAULTS } from '../constants.js';

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
async function computeReward(from: Date, toExclusive: Date, label: string) {
  const rates = await getRates();

  const consWhere = { deletedAt: null, manager: { not: null }, patient: { is: { deletedAt: null } }, dateKons: { gte: from, lt: toExclusive } };
  // Записи удалённых пациентов не учитываем. Онлайн — vid='Онлайн', офлайн — все прочие.
  const [consTotal, consOnline, ops] = await Promise.all([
    prisma.consultation.groupBy({ by: ['manager'], where: consWhere, _count: { _all: true } }),
    prisma.consultation.groupBy({ by: ['manager'], where: { ...consWhere, vid: 'Онлайн' }, _count: { _all: true } }),
    prisma.operation.groupBy({
      by: ['manager'],
      where: { deletedAt: null, manager: { not: null }, patient: { is: { deletedAt: null } }, dateOp: { gte: from, lt: toExclusive } },
      _count: { _all: true },
    }),
  ]);

  const byManager = new Map<string, { manager: string; total: number; online: number; operations: number }>();
  const ensure = (m: string) => {
    if (!byManager.has(m)) byManager.set(m, { manager: m, total: 0, online: 0, operations: 0 });
    return byManager.get(m)!;
  };
  for (const c of consTotal) if (c.manager) ensure(c.manager).total = c._count._all;
  for (const c of consOnline) if (c.manager) ensure(c.manager).online = c._count._all;
  for (const o of ops) if (o.manager) ensure(o.manager).operations = o._count._all;

  const rows = [...byManager.values()]
    .map((r) => {
      const consultationsOnline = r.online;
      const consultationsOffline = Math.max(0, r.total - r.online);
      return {
        manager: r.manager,
        consultationsOnline,
        consultationsOffline,
        operations: r.operations,
        amount: consultationsOnline * rates.consultationOnline + consultationsOffline * rates.consultationOffline + r.operations * rates.operation,
      };
    })
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

  return {
    label,
    from: from.toISOString(),
    to: toExclusive.toISOString(),
    rates,
    rows,
    totals,
  };
}
