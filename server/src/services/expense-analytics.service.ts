import { prisma } from '../lib/prisma.js';
import { round2 } from './compute.js';

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface AnalyticsPeriod {
  from?: Date;
  toExclusive?: Date;
}

// Ключ месяца в UTC (согласованно с хранением дат из <input type=date>).
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface Bucket {
  name: string;
  qty: number;
  cost: number;
}

// Аналитика расхода материалов за период. Стоимостные показатели (cost/totalCost)
// включаются только для администратора.
export async function expenseAnalytics(period: AnalyticsPeriod, isAdmin: boolean) {
  const dateFilter =
    period.from || period.toExclusive
      ? { date: { ...(period.from ? { gte: period.from } : {}), ...(period.toExclusive ? { lt: period.toExclusive } : {}) } }
      : {};

  const items = await prisma.expenseWriteoff.findMany({
    where: { deletedAt: null, patient: { is: { deletedAt: null } }, ...dateFilter },
    include: {
      patient: { select: { fio: true } },
      nomenclature: { select: { nameDisplay: true } },
      category: { select: { name: true } },
    },
  });

  const byCategoryMap = new Map<string, Bucket>();
  const byNomMap = new Map<string, Bucket>();
  const byPatientMap = new Map<string, Bucket>();
  const byMonthMap = new Map<string, Bucket>();
  const positions = new Set<number>();
  let totalQty = 0;
  let totalCost = 0;

  const add = (map: Map<string, Bucket>, key: string, qty: number, cost: number) => {
    const b = map.get(key) ?? { name: key, qty: 0, cost: 0 };
    b.qty = round2(b.qty + qty);
    b.cost = round2(b.cost + cost);
    map.set(key, b);
  };

  for (const w of items) {
    const qty = num(w.qty);
    const cost = num(w.costTotal);
    totalQty = round2(totalQty + qty);
    totalCost = round2(totalCost + cost);
    positions.add(w.nomenclatureId);
    add(byCategoryMap, w.category.name, qty, cost);
    add(byNomMap, w.nomenclature.nameDisplay, qty, cost);
    add(byPatientMap, w.patient.fio, qty, cost);
    if (w.date) add(byMonthMap, monthKey(new Date(w.date)), qty, cost);
  }

  // Убираем стоимость для не-администратора
  const shape = (b: Bucket) => (isAdmin ? { name: b.name, qty: b.qty, cost: b.cost } : { name: b.name, qty: b.qty });
  const topByQty = (map: Map<string, Bucket>, n: number) =>
    [...map.values()].sort((a, b) => b.qty - a.qty).slice(0, n).map(shape);

  return {
    kpi: {
      writeoffs: items.length,
      positions: positions.size,
      totalQty,
      ...(isAdmin ? { totalCost } : {}),
    },
    byCategory: [...byCategoryMap.values()].sort((a, b) => b.qty - a.qty).map(shape),
    byNomenclature: topByQty(byNomMap, 10),
    byPatient: topByQty(byPatientMap, 10),
    byMonth: [...byMonthMap.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => (isAdmin ? { month: b.name, qty: b.qty, cost: b.cost } : { month: b.name, qty: b.qty })),
  };
}
