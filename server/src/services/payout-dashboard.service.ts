import type { SheetStatus } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { round2 } from './compute.js';

const APPROVED: SheetStatus[] = ['approved', 'paid'];

// Агрегаты дашборда выплат (Э5-1). Все считаются пакетными запросами (aggregate/groupBy),
// без цикла по врачам. Период — по датам ведомостей и событий.

const iso = (d: Date) => d.toISOString().slice(0, 7); // YYYY-MM

// Блок 8.1 — KPI за период (по утверждённым/оплаченным ведомостям) + доля в выручке.
export async function dashboardSummary(from: Date, to: Date) {
  const where = { sheet: { status: { in: APPROVED }, periodFrom: { gte: from, lte: to } } };
  const agg = await prisma.payoutSheetLine.aggregate({ where, _sum: { accruedTotal: true, toPay: true, paidTotal: true } });
  const accrued = Number(agg._sum.accruedTotal ?? 0);
  const toPay = Number(agg._sum.toPay ?? 0);
  const paid = Number(agg._sum.paidTotal ?? 0);
  const rev = await prisma.payment.aggregate({ where: { deletedAt: null, direction: 'payment', date: { gte: from, lte: to } }, _sum: { amount: true } });
  const revenue = Number(rev._sum.amount ?? 0);
  return {
    accrued: round2(accrued),
    toPay: round2(toPay),
    paid: round2(paid),
    debt: round2(toPay - paid),
    revenue: round2(revenue),
    shareOfRevenuePct: revenue > 0 ? round2((toPay / revenue) * 100) : 0,
  };
}

// Блок 8.2 — кто сколько заработал и сколько должны (по врачам).
export async function dashboardByDoctor(from: Date, to: Date) {
  const where = { sheet: { status: { in: APPROVED }, periodFrom: { gte: from, lte: to } } };
  const grouped = await prisma.payoutSheetLine.groupBy({
    by: ['payeeId'],
    where,
    _sum: { accruedTotal: true, toPay: true, paidTotal: true },
  });
  const ids = grouped.map((g) => g.payeeId);
  const payees = ids.length ? await prisma.doctorPayee.findMany({ where: { id: { in: ids } }, select: { id: true, fio: true } }) : [];
  const fio = new Map(payees.map((p) => [p.id, p.fio]));
  return grouped
    .map((g) => {
      const toPay = Number(g._sum.toPay ?? 0);
      const paid = Number(g._sum.paidTotal ?? 0);
      return { payeeId: g.payeeId, fio: fio.get(g.payeeId) ?? `#${g.payeeId}`, accrued: round2(Number(g._sum.accruedTotal ?? 0)), toPay: round2(toPay), paid: round2(paid), debt: round2(toPay - paid) };
    })
    .sort((a, b) => b.accrued - a.accrued);
}

// Блок 8.4 — динамика по месяцам (начислено по событиям, выплачено по фактам).
export async function dashboardTrend(from: Date, to: Date) {
  const [accr, pays] = await Promise.all([
    prisma.payoutAccrual.findMany({ where: { eventDate: { gte: from, lte: to } }, select: { eventDate: true, amount: true } }),
    prisma.payoutPayment.findMany({ where: { date: { gte: from, lte: to } }, select: { date: true, amount: true } }),
  ]);
  const months = new Map<string, { accrued: number; paid: number }>();
  const bump = (m: string, k: 'accrued' | 'paid', v: number) => {
    const cur = months.get(m) ?? { accrued: 0, paid: 0 };
    cur[k] += v;
    months.set(m, cur);
  };
  for (const a of accr) bump(iso(a.eventDate), 'accrued', Number(a.amount));
  for (const p of pays) bump(iso(p.date), 'paid', Number(p.amount));
  return [...months.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, v]) => ({ month, accrued: round2(v.accrued), paid: round2(v.paid) }));
}

// Блок 8.5 — сигналы и проблемы.
export async function dashboardSignals() {
  // 1. Получатели-участники без привязки к справочнику (dictionaryLabel пустая).
  const noLabel = await prisma.doctorPayee.findMany({
    where: { deletedAt: null, dictionaryLabel: null, participants: { some: {} } },
    select: { id: true, fio: true, kind: true },
  });
  // 2. Отрицательные свободные начисления (корректировки, ожидающие ведомости).
  const neg = await prisma.payoutAccrual.aggregate({ where: { status: 'free', amount: { lt: 0 } }, _sum: { amount: true }, _count: { _all: true } });
  // 3. Врачи-участники без схемы выплат (начисления не считаются).
  const partIds = (await prisma.operationParticipant.findMany({ distinct: ['payeeId'], select: { payeeId: true } })).map((p) => p.payeeId);
  const withScheme = new Set((await prisma.payoutScheme.findMany({ where: { payeeId: { in: partIds } }, distinct: ['payeeId'], select: { payeeId: true } })).map((x) => x.payeeId));
  const noSchemeIds = partIds.filter((id) => !withScheme.has(id));
  const noScheme = noSchemeIds.length ? await prisma.doctorPayee.findMany({ where: { id: { in: noSchemeIds } }, select: { id: true, fio: true } }) : [];

  const signals: { type: string; label: string; count: number; items: { id: number; fio: string }[] }[] = [];
  if (noScheme.length) signals.push({ type: 'no_scheme', label: 'Врачи-участники без схемы выплат', count: noScheme.length, items: noScheme.map((p) => ({ id: p.id, fio: p.fio })) });
  if (noLabel.length) signals.push({ type: 'no_label', label: 'Получатели без привязки к справочнику', count: noLabel.length, items: noLabel.map((p) => ({ id: p.id, fio: p.fio })) });
  if ((neg._count._all ?? 0) > 0) signals.push({ type: 'neg_accrual', label: `Отрицательные начисления к учёту (${round2(Number(neg._sum.amount ?? 0))} ₸)`, count: neg._count._all, items: [] });
  return signals;
}
