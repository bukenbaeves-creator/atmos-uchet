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

const NO_OP = 'Без операции'; // списания без привязки к операции

// Аналитика расхода материалов по видам операций и по месяцам. Стоимостные
// показатели (cost/totalCost) включаются только для администратора.
export async function expenseAnalytics(period: AnalyticsPeriod, isAdmin: boolean) {
  const dateFilter =
    period.from || period.toExclusive
      ? { date: { ...(period.from ? { gte: period.from } : {}), ...(period.toExclusive ? { lt: period.toExclusive } : {}) } }
      : {};

  const items = await prisma.expenseWriteoff.findMany({
    where: { deletedAt: null, patient: { is: { deletedAt: null } }, ...dateFilter },
    include: { operation: { select: { opType: true } } },
  });

  const byOpMap = new Map<string, Bucket>();
  const byMonthMap = new Map<string, Bucket>();
  // расход по месяцу в разрезе вида операции (для стека «виды операций × месяцы»)
  const monthOp = new Map<string, Map<string, { qty: number; cost: number }>>();
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
    const op = (w.opType ?? w.operation?.opType ?? '').trim() || NO_OP;
    totalQty = round2(totalQty + qty);
    totalCost = round2(totalCost + cost);
    positions.add(w.nomenclatureId);
    add(byOpMap, op, qty, cost);
    if (w.date) {
      const mk = monthKey(new Date(w.date));
      add(byMonthMap, mk, qty, cost);
      if (!monthOp.has(mk)) monthOp.set(mk, new Map());
      const mt = monthOp.get(mk)!;
      const cur = mt.get(op) ?? { qty: 0, cost: 0 };
      cur.qty = round2(cur.qty + qty);
      cur.cost = round2(cur.cost + cost);
      mt.set(op, cur);
    }
  }

  // Основная метрика зависит от роли: админ смотрит себестоимость, медсестра — количество.
  const metricOf = (b: { qty: number; cost: number }) => (isAdmin ? b.cost : b.qty);

  // Топ видов операций по метрике; остальные сводим в «Прочее» (чтобы стек читался).
  const TOP = 6;
  const opsSorted = [...byOpMap.values()].sort((a, b) => metricOf(b) - metricOf(a));
  const topNames = opsSorted.slice(0, TOP).map((b) => b.name);
  const hasOther = opsSorted.length > TOP;
  const opTypes = hasOther ? [...topNames, 'Прочее'] : topNames;
  const bucketName = (name: string) => (topNames.includes(name) ? name : 'Прочее');

  // Пивот для стека: одна строка на месяц, ключи — виды операций, значение — метрика роли.
  const months = [...byMonthMap.keys()].sort();
  const pivot = months.map((m) => {
    const row: Record<string, string | number> = { month: m };
    for (const t of opTypes) row[t] = 0;
    for (const [name, v] of monthOp.get(m)!) {
      const key = bucketName(name);
      row[key] = round2((row[key] as number) + metricOf(v));
    }
    return row;
  });

  const shapeOp = (b: Bucket) => (isAdmin ? { name: b.name, qty: b.qty, cost: b.cost } : { name: b.name, qty: b.qty });

  return {
    metric: isAdmin ? 'cost' : 'qty',
    kpi: {
      writeoffs: items.length,
      positions: positions.size,
      totalQty,
      ...(isAdmin ? { totalCost } : {}),
    },
    byOperationType: opsSorted.map(shapeOp),
    byMonth: [...byMonthMap.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => (isAdmin ? { month: b.name, qty: b.qty, cost: b.cost } : { month: b.name, qty: b.qty })),
    opTypes,
    pivot,
  };
}
