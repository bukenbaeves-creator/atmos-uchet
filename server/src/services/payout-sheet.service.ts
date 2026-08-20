import type { Request } from 'express';
import { prisma, type PrismaClientOrTx } from '../lib/prisma.js';
import { round2 } from './compute.js';
import { badRequest, notFound } from '../lib/http.js';
import { writeAudit } from './audit.service.js';

// ===================== Сервис ведомостей выплат (Э3-2/Э3-3) =====================
// Жёсткие инварианты:
//  • в ведомость берутся только начисления status=free И sheetId IS NULL;
//  • заблокированные (locked) и оплаченные (paid) начисления не изменяются;
//  • повторное включение уже включённого/оплаченного начисления невозможно.

export type SheetKind = 'weekly' | 'monthly' | 'custom' | 'adhoc';

const p2 = (n: number) => String(n).padStart(2, '0');
const fmtRu = (d: Date) => `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;

interface SheetFilter {
  kind: SheetKind;
  from?: string; // YYYY-MM-DD (включительно)
  to?: string; // YYYY-MM-DD (включительно)
  payeeIds?: number[];
  accrualIds?: number[];
}

// Where-фрагмент для отбора свободных начислений по фильтру ведомости.
function freeAccrualWhere(f: SheetFilter, extra?: Record<string, unknown>): Record<string, unknown> {
  const where: Record<string, unknown> = { status: 'free', sheetId: null };
  if (f.kind === 'adhoc' || f.accrualIds?.length) {
    if (!f.accrualIds?.length) throw badRequest('Для выборочной ведомости укажите начисления (accrualIds).');
    where.id = { in: f.accrualIds };
  } else {
    if (!f.from || !f.to) throw badRequest('Укажите период ведомости (from, to).');
    where.eventDate = { gte: new Date(f.from), lte: new Date(f.to) };
  }
  if (f.payeeIds?.length) where.payeeId = { in: f.payeeIds };
  return { ...where, ...extra };
}

interface PreviewGroup {
  payeeId: number;
  fio: string;
  operationsCount: number;
  accruedTotal: number;
  accrualIds: number[];
  hasCorrections: boolean;
}

async function groupAccruals(where: Record<string, unknown>, tx: PrismaClientOrTx): Promise<PreviewGroup[]> {
  const accruals = await tx.payoutAccrual.findMany({ where, include: { payee: { select: { id: true, fio: true } } } });
  const byPayee = new Map<number, PreviewGroup & { ops: Set<number> }>();
  for (const a of accruals) {
    let g = byPayee.get(a.payeeId);
    if (!g) {
      g = { payeeId: a.payeeId, fio: a.payee?.fio ?? `#${a.payeeId}`, operationsCount: 0, accruedTotal: 0, accrualIds: [], hasCorrections: false, ops: new Set() };
      byPayee.set(a.payeeId, g);
    }
    g.accruedTotal = round2(g.accruedTotal + Number(a.amount));
    g.accrualIds.push(a.id);
    g.ops.add(a.operationId);
    if (a.isCorrection) g.hasCorrections = true;
  }
  return [...byPayee.values()].map((g) => ({ ...g, operationsCount: g.ops.size, ops: undefined as never }));
}

// Предпросмотр: свободные начисления по фильтру, сгруппированные по врачам.
export async function previewSheet(f: SheetFilter) {
  const groups = await groupAccruals(freeAccrualWhere(f), prisma);
  const warnings: string[] = [];
  for (const g of groups) {
    if (g.accruedTotal < 0) warnings.push(`У «${g.fio}» итог по ведомости отрицательный (${g.accruedTotal}) — только корректировки.`);
  }
  const totalAccrued = round2(groups.reduce((s, g) => s + g.accruedTotal, 0));
  return { groups, totalPayees: groups.length, totalAccrued, warnings };
}

// Создание черновика: резервируем отобранные начисления за ведомостью (sheetId),
// статус остаётся free до утверждения.
export async function createSheet(f: SheetFilter, note: string | null, req: Request) {
  return prisma.$transaction(async (tx) => {
    const where = freeAccrualWhere(f);
    const accruals = await tx.payoutAccrual.findMany({ where, select: { id: true } });
    if (!accruals.length) throw badRequest('Нет свободных начислений по заданному фильтру.');

    const periodFrom = f.from ? new Date(f.from) : null;
    const periodTo = f.to ? new Date(f.to) : null;
    const sheet = await tx.payoutSheet.create({
      data: { number: `ЧЕРН-${Date.now()}`, kind: f.kind, periodFrom, periodTo, status: 'draft', note, createdBy: req.user!.id, updatedBy: req.user!.id },
    });
    // Человекочитаемый черновой номер по id (temp был для уникальности до появления id).
    await tx.payoutSheet.update({ where: { id: sheet.id }, data: { number: `ЧЕРН-${sheet.id}` } });
    await tx.payoutAccrual.updateMany({ where: { id: { in: accruals.map((a) => a.id) } }, data: { sheetId: sheet.id } });
    await writeAudit(req, { action: 'create', entity: 'payoutSheet', entityId: sheet.id, after: { ...sheet, reserved: accruals.length } }, tx);
    return getSheet(sheet.id, tx);
  });
}

// Исключить начисления из черновика (вернуть в свободный пул).
export async function excludeAccruals(sheetId: number, ids: number[], req: Request) {
  return prisma.$transaction(async (tx) => {
    const sheet = await tx.payoutSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) throw notFound('Ведомость не найдена');
    if (sheet.status !== 'draft') throw badRequest('Изменять состав можно только у черновика.');
    await tx.payoutAccrual.updateMany({ where: { id: { in: ids }, sheetId, status: 'free' }, data: { sheetId: null } });
    await writeAudit(req, { action: 'update', entity: 'payoutSheet', entityId: sheetId, after: { excluded: ids } }, tx);
    return getSheet(sheetId, tx);
  });
}

// Номер ВВ-ГГГГ-ММ-NNN (NNN — сквозной за месяц по утверждённым/оплаченным ведомостям).
async function nextNumber(base: Date, tx: PrismaClientOrTx): Promise<string> {
  const prefix = `ВВ-${base.getUTCFullYear()}-${p2(base.getUTCMonth() + 1)}-`;
  const count = await tx.payoutSheet.count({ where: { number: { startsWith: prefix } } });
  return `${prefix}${String(count + 1).padStart(3, '0')}`;
}

// Утверждение: номер, снимок, строки по врачам, начисления → locked. Всё в транзакции.
export async function approveSheet(sheetId: number, req: Request) {
  return prisma.$transaction(async (tx) => {
    const sheet = await tx.payoutSheet.findUnique({ where: { id: sheetId } });
    if (!sheet) throw notFound('Ведомость не найдена');
    if (sheet.status !== 'draft') throw badRequest('Утвердить можно только черновик.');

    const groups = await groupAccruals({ sheetId, status: 'free' }, tx);
    if (!groups.length) throw badRequest('В ведомости нет начислений для утверждения.');

    const number = await nextNumber(sheet.periodFrom ?? new Date(), tx);
    for (const g of groups) {
      await tx.payoutSheetLine.create({
        data: {
          sheetId,
          payeeId: g.payeeId,
          operationsCount: g.operationsCount,
          accruedTotal: g.accruedTotal,
          withholdings: [] as unknown as object,
          toPay: g.accruedTotal,
          paidTotal: 0,
        },
      });
    }
    // Блокируем начисления: изменение locked/paid на уровне сервиса запрещено.
    await tx.payoutAccrual.updateMany({ where: { sheetId, status: 'free' }, data: { status: 'locked' } });

    const snapshot = { approvedAt: new Date().toISOString(), number, groups };
    const updated = await tx.payoutSheet.update({
      where: { id: sheetId },
      data: { number, status: 'approved', snapshot: snapshot as unknown as object, approvedBy: req.user!.id, approvedAt: new Date(), updatedBy: req.user!.id },
    });
    await writeAudit(req, { action: 'update', entity: 'payoutSheet', entityId: sheetId, before: sheet, after: updated }, tx);
    return getSheet(sheetId, tx);
  });
}

// Роспуск: только если нет ни одной выплаты. Начисления возвращаются в свободные,
// строки и сама ведомость удаляются (в enum нет статуса «распущена»).
export async function dissolveSheet(sheetId: number, reason: string, req: Request) {
  return prisma.$transaction(async (tx) => {
    const sheet = await tx.payoutSheet.findUnique({ where: { id: sheetId }, include: { lines: { include: { payments: true } } } });
    if (!sheet) throw notFound('Ведомость не найдена');
    const hasPayments = sheet.lines.some((l) => l.payments.length > 0);
    if (hasPayments) throw badRequest('Ведомость нельзя распустить: по ней уже есть зафиксированные выплаты.');

    // Начисления → free, отвязать от ведомости.
    await tx.payoutAccrual.updateMany({ where: { sheetId }, data: { status: 'free', sheetId: null } });
    await tx.payoutSheetLine.deleteMany({ where: { sheetId } });
    await writeAudit(req, { action: 'delete', entity: 'payoutSheet', entityId: sheetId, before: sheet, after: { dissolved: true, reason } }, tx);
    await tx.payoutSheet.delete({ where: { id: sheetId } });
    return { ok: true, freed: true };
  });
}

// Удержания по строке (Э3-3): ручной ввод бухгалтера, пересчёт toPay.
export async function setWithholdings(
  sheetId: number,
  lineId: number,
  withholdings: { type: string; amount: number; comment?: string | null }[],
  req: Request,
) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.payoutSheetLine.findFirst({ where: { id: lineId, sheetId }, include: { sheet: true } });
    if (!line) throw notFound('Строка ведомости не найдена');
    if (line.sheet.status === 'paid') throw badRequest('Ведомость оплачена — удержания менять нельзя.');
    const sum = round2(withholdings.reduce((s, w) => s + Number(w.amount), 0));
    const toPay = round2(Number(line.accruedTotal) - sum);
    const updated = await tx.payoutSheetLine.update({ where: { id: lineId }, data: { withholdings: withholdings as unknown as object, toPay } });
    await writeAudit(req, { action: 'update', entity: 'payoutSheetLine', entityId: lineId, before: line, after: updated }, tx);
    return getSheet(sheetId, tx);
  });
}

// Фиксация выплаты по строке (Э3-3). Когда все строки оплачены (paidTotal ≥ toPay),
// ведомость получает статус paid, а её начисления — статус paid.
export async function addLinePayment(
  sheetId: number,
  lineId: number,
  p: { date: string; amount: number; channel: string; note?: string | null },
  req: Request,
) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.payoutSheetLine.findFirst({ where: { id: lineId, sheetId }, include: { sheet: true } });
    if (!line) throw notFound('Строка ведомости не найдена');
    if (line.sheet.status === 'draft') throw badRequest('Сначала утвердите ведомость.');
    await tx.payoutPayment.create({
      data: { lineId, date: new Date(p.date), amount: p.amount, channel: p.channel, note: p.note ?? null, createdBy: req.user!.id },
    });
    const agg = await tx.payoutPayment.aggregate({ where: { lineId }, _sum: { amount: true } });
    const paidTotal = round2(Number(agg._sum.amount ?? 0));
    await tx.payoutSheetLine.update({ where: { id: lineId }, data: { paidTotal } });

    const lines = await tx.payoutSheetLine.findMany({ where: { sheetId } });
    const fullyPaid = lines.every((l) => Number(l.paidTotal) + 0.005 >= Number(l.toPay));
    if (fullyPaid && line.sheet.status !== 'paid') {
      await tx.payoutSheet.update({ where: { id: sheetId }, data: { status: 'paid', paidAt: new Date(), updatedBy: req.user!.id } });
      await tx.payoutAccrual.updateMany({ where: { sheetId }, data: { status: 'paid' } });
    }
    await writeAudit(req, { action: 'create', entity: 'payoutPayment', entityId: line.id, after: { lineId, amount: p.amount, channel: p.channel } }, tx);
    return getSheet(sheetId, tx);
  });
}

// Реестр по врачу (Э4-2): строки операций с развёрнутыми компонентами. Набор колонок
// формируется по факту начислений (calcPayout включает только компоненты, активные в
// схеме врача) — поэтому у Кулесбаева нет колонок «Импланты»/«Медсестра», но есть «Аренда
// дня». Итог реестра сходится со строкой ведомости.
export async function getSheetRegistry(sheetId: number, payeeId: number) {
  const accruals = await prisma.payoutAccrual.findMany({
    where: { sheetId, payeeId },
    include: {
      operation: { select: { id: true, dateOp: true, opType: true, patient: { select: { fio: true } } } },
      payee: { select: { fio: true } },
    },
    orderBy: [{ eventDate: 'asc' }, { id: 'asc' }],
  });

  const stageRank = (s: string) => (s === 'before_share' ? 0 : 1);
  const colMap = new Map<string, { code: string; label: string; stage: string; order: number }>();
  let order = 0;
  for (const a of accruals) {
    for (const c of (a.components as Array<{ code: string; label: string; stage: string }>) ?? []) {
      if (!colMap.has(c.code)) colMap.set(c.code, { code: c.code, label: c.label, stage: c.stage, order: order++ });
    }
  }
  const columns = [...colMap.values()].sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || a.order - b.order);

  const rows = accruals.map((a) => {
    const cmap: Record<string, number> = {};
    for (const c of (a.components as Array<{ code: string; amount: number }>) ?? []) cmap[c.code] = Number(c.amount);
    return {
      accrualId: a.id,
      operationId: a.operationId,
      dateOp: a.operation?.dateOp ?? null,
      opType: a.operation?.opType ?? null,
      patient: a.operation?.patient?.fio ?? null,
      base: Number(a.base),
      sharePct: Number(a.sharePct),
      isCorrection: a.isCorrection,
      components: cmap,
      amount: Number(a.amount),
    };
  });

  const totals: { amount: number; perComponent: Record<string, number> } = { amount: round2(rows.reduce((s, r) => s + r.amount, 0)), perComponent: {} };
  for (const col of columns) totals.perComponent[col.code] = round2(rows.reduce((s, r) => s + (r.components[col.code] ?? 0), 0));

  return { payeeId, payeeFio: accruals[0]?.payee?.fio ?? null, columns, rows, totals };
}

export async function listSheets() {
  return prisma.payoutSheet.findMany({ include: { lines: true }, orderBy: { createdAt: 'desc' } });
}

export async function getSheet(id: number, tx: PrismaClientOrTx = prisma) {
  const sheet = await tx.payoutSheet.findUnique({
    where: { id },
    include: {
      lines: { include: { payee: { select: { id: true, fio: true } }, payments: true }, orderBy: { payeeId: 'asc' } },
      accruals: { include: { payee: { select: { id: true, fio: true } } }, orderBy: [{ payeeId: 'asc' }, { eventDate: 'asc' }] },
    },
  });
  if (!sheet) throw notFound('Ведомость не найдена');
  return sheet;
}

export { fmtRu };
