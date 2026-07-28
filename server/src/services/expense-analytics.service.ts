import { prisma } from '../lib/prisma.js';
import { round2 } from './compute.js';

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface AnalyticsPeriod {
  from?: Date;
  toExclusive?: Date;
}

const NO_OP = 'Без операции'; // списания без привязки к виду операции

// Аналитика расхода материалов: расходы по пациентам с указанием вида операции и
// перечнем материалов. Стоимость (cost/totalCost) — только для администратора.
export async function expenseAnalytics(period: AnalyticsPeriod, isAdmin: boolean) {
  const dateFilter =
    period.from || period.toExclusive
      ? { date: { ...(period.from ? { gte: period.from } : {}), ...(period.toExclusive ? { lt: period.toExclusive } : {}) } }
      : {};

  const items = await prisma.expenseWriteoff.findMany({
    where: { deletedAt: null, patient: { is: { deletedAt: null } }, ...dateFilter },
    include: {
      patient: { select: { fio: true } },
      operation: { select: { opType: true } },
      nomenclature: { select: { nameDisplay: true } },
    },
  });

  // Группа = пациент + вид операции; внутри — материалы (наименование → количество).
  interface Group {
    patient: string;
    opType: string;
    qty: number;
    cost: number;
    positions: Set<number>;
    materials: Map<string, number>;
  }
  const groups = new Map<string, Group>();
  const byPatient = new Map<string, { name: string; qty: number; cost: number }>();
  const patients = new Set<number>();
  let totalQty = 0;
  let totalCost = 0;

  for (const w of items) {
    const qty = num(w.qty);
    const cost = num(w.costTotal);
    const opType = (w.opType ?? w.operation?.opType ?? '').trim() || NO_OP;
    const fio = w.patient.fio;
    totalQty = round2(totalQty + qty);
    totalCost = round2(totalCost + cost);
    patients.add(w.patientId);

    const key = `${w.patientId}|${opType}`;
    let g = groups.get(key);
    if (!g) {
      g = { patient: fio, opType, qty: 0, cost: 0, positions: new Set(), materials: new Map() };
      groups.set(key, g);
    }
    g.qty = round2(g.qty + qty);
    g.cost = round2(g.cost + cost);
    g.positions.add(w.nomenclatureId);
    g.materials.set(w.nomenclature.nameDisplay, round2((g.materials.get(w.nomenclature.nameDisplay) ?? 0) + qty));

    let bp = byPatient.get(fio);
    if (!bp) {
      bp = { name: fio, qty: 0, cost: 0 };
      byPatient.set(fio, bp);
    }
    bp.qty = round2(bp.qty + qty);
    bp.cost = round2(bp.cost + cost);
  }

  const metricOf = (x: { qty: number; cost: number }) => (isAdmin ? x.cost : x.qty);

  const rows = [...groups.values()]
    .sort((a, b) => metricOf(b) - metricOf(a) || a.patient.localeCompare(b.patient))
    .map((g) => {
      const materials = [...g.materials.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([n, q]) => `${n} ×${q}`)
        .join(', ');
      return isAdmin
        ? { patient: g.patient, opType: g.opType, positions: g.positions.size, qty: g.qty, cost: g.cost, materials }
        : { patient: g.patient, opType: g.opType, positions: g.positions.size, qty: g.qty, materials };
    });

  const topPatients = [...byPatient.values()]
    .sort((a, b) => metricOf(b) - metricOf(a))
    .slice(0, 10)
    .map((p) => (isAdmin ? { name: p.name, qty: p.qty, cost: p.cost } : { name: p.name, qty: p.qty }));

  return {
    metric: isAdmin ? 'cost' : 'qty',
    kpi: { writeoffs: items.length, patients: patients.size, totalQty, ...(isAdmin ? { totalCost } : {}) },
    topPatients,
    rows,
  };
}
