import { Router } from 'express';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';

// Выгрузки модуля расходов в Excel. Доступны медсестре и администратору.
// Стоимостные колонки (себестоимость, цена, стоимость остатка) добавляются
// ТОЛЬКО для роли admin — для 1С. Медсестра получает количественную выгрузку.
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

const EXPIRY_SOON_DAYS = 30;

interface Column {
  header: string;
  key: string;
  width?: number;
}
type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null ? 0 : Number(v));
const d = (v: Date | null | undefined) => (v ? new Date(v).toLocaleDateString('ru-RU') : '');

// Период выгрузки: ?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД (обе границы включительно).
// Применяется к отчёту «Списания» (по дате списания); отчёты остатков/сроков —
// это срез на текущий момент, период к ним не применяется.
interface ExportPeriod {
  from?: string;
  to?: string;
}
function parseDay(v: string): Date {
  const day = new Date(v + 'T00:00:00.000Z');
  if (isNaN(day.getTime())) throw badRequest('Некорректная дата периода выгрузки (нужен формат ГГГГ-ММ-ДД)');
  return day;
}
function dateWhere(p: ExportPeriod): Record<string, Date> | undefined {
  const range: Record<string, Date> = {};
  if (p.from) range.gte = parseDay(p.from);
  if (p.to) {
    const toExclusive = parseDay(p.to);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    range.lt = toExclusive;
  }
  return Object.keys(range).length ? range : undefined;
}

// Считает складские позиции с остатком, дефицитом и сроками (как /api/stock).
async function stockRows(isAdmin: boolean) {
  const noms = await prisma.nomenclature.findMany({
    where: { deletedAt: null, status: 'active' },
    include: { batches: { where: { qtyRemaining: { gt: 0 } } } },
    orderBy: { nameDisplay: 'asc' },
  });
  const now = Date.now();
  const soon = now + EXPIRY_SOON_DAYS * 24 * 60 * 60 * 1000;
  return noms.map((n) => {
    const stock = n.batches.reduce((s, b) => s.add(b.qtyRemaining), new Prisma.Decimal(0));
    const nearest = n.batches.filter((b) => b.expiryDate).map((b) => b.expiryDate as Date).sort((a, b) => a.getTime() - b.getTime())[0];
    const hasExpired = n.batches.some((b) => b.expiryDate && (b.expiryDate as Date).getTime() < now);
    const expiringSoon = n.batches.some((b) => {
      if (!b.expiryDate) return false;
      const t = (b.expiryDate as Date).getTime();
      return t >= now && t <= soon;
    });
    const deficit = Number(Prisma.Decimal.max(n.minStock.sub(stock), new Prisma.Decimal(0)));
    const totalCost = isAdmin
      ? Number(n.batches.reduce((s, b) => s.add(b.qtyRemaining.mul(b.purchasePrice)), new Prisma.Decimal(0)))
      : 0;
    // Последняя цена закупа — для списка к закупу (admin)
    const lastBatch = [...n.batches].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];
    return {
      name: n.nameDisplay,
      type: n.type === 'drug' ? 'Препарат' : 'Расходник',
      unit: n.unitWriteoff ?? '',
      stock: Number(stock),
      minStock: Number(n.minStock),
      deficit,
      belowMin: stock.lt(n.minStock),
      nearest: nearest ?? null,
      status: hasExpired ? 'просрочено' : expiringSoon ? 'скоро истекает' : 'ок',
      totalCost,
      lastPrice: isAdmin && lastBatch ? Number(lastBatch.purchasePrice) : 0,
    };
  });
}

async function buildReport(report: string, isAdmin: boolean, period: ExportPeriod): Promise<{ sheet: string; columns: Column[]; rows: Row[] }> {
  switch (report) {
    case 'stock': {
      const rows = await stockRows(isAdmin);
      const columns: Column[] = [
        { header: 'Позиция', key: 'name', width: 32 },
        { header: 'Тип', key: 'type', width: 14 },
        { header: 'Ед.', key: 'unit', width: 8 },
        { header: 'Остаток', key: 'stock', width: 12 },
        { header: 'Минимум', key: 'minStock', width: 12 },
        { header: 'Дефицит', key: 'deficit', width: 12 },
        { header: 'Ближайший срок', key: 'nearest', width: 16 },
        { header: 'Статус', key: 'status', width: 16 },
        ...(isAdmin ? [{ header: 'Стоимость остатка', key: 'totalCost', width: 18 }] : []),
      ];
      return {
        sheet: 'Остатки',
        columns,
        rows: rows.map((r) => ({ ...r, nearest: r.nearest ? d(r.nearest) : 'бессрочный' })),
      };
    }
    case 'purchase-list': {
      const rows = (await stockRows(isAdmin)).filter((r) => r.belowMin);
      const columns: Column[] = [
        { header: 'Позиция', key: 'name', width: 32 },
        { header: 'Ед.', key: 'unit', width: 8 },
        { header: 'Остаток', key: 'stock', width: 12 },
        { header: 'Минимум', key: 'minStock', width: 12 },
        { header: 'Нужно докупить', key: 'deficit', width: 16 },
        ...(isAdmin ? [{ header: 'Последняя цена закупа', key: 'lastPrice', width: 20 }] : []),
      ];
      return { sheet: 'К закупу', columns, rows };
    }
    case 'expiry': {
      const rows = (await stockRows(isAdmin)).filter((r) => r.status !== 'ок');
      const columns: Column[] = [
        { header: 'Позиция', key: 'name', width: 32 },
        { header: 'Ед.', key: 'unit', width: 8 },
        { header: 'Остаток', key: 'stock', width: 12 },
        { header: 'Ближайший срок', key: 'nearest', width: 16 },
        { header: 'Статус', key: 'status', width: 16 },
      ];
      return { sheet: 'Сроки годности', columns, rows: rows.map((r) => ({ ...r, nearest: r.nearest ? d(r.nearest) : '' })) };
    }
    case 'writeoffs': {
      const range = dateWhere(period);
      const items = await prisma.expenseWriteoff.findMany({
        where: { deletedAt: null, ...(range ? { date: range } : {}) },
        include: {
          patient: { select: { fio: true } },
          nomenclature: { select: { nameDisplay: true, unitWriteoff: true } },
          category: { select: { name: true } },
          // Вид операции: из самого списания, при отсутствии — из привязанной операции.
          operation: { select: { opType: true, dateOp: true } },
        },
        orderBy: { date: 'desc' },
      });
      const columns: Column[] = [
        { header: 'Дата', key: 'date', width: 14 },
        { header: 'Дата записи', key: 'createdAt', width: 14 },
        { header: 'Пациент', key: 'patient', width: 28 },
        { header: 'Позиция', key: 'position', width: 30 },
        { header: 'Кол-во', key: 'qty', width: 10 },
        { header: 'Ед.', key: 'unit', width: 8 },
        { header: 'Вид операции', key: 'opType', width: 24 },
        { header: 'Дата операции', key: 'dateOp', width: 14 },
        { header: 'Категория', key: 'category', width: 18 },
        { header: 'Нехватка', key: 'shortage', width: 10 },
        ...(isAdmin ? [{ header: 'Себестоимость', key: 'costTotal', width: 16 }] : []),
      ];
      return {
        sheet: 'Списания',
        columns,
        rows: items.map((w) => ({
          date: d(w.date),
          createdAt: d(w.createdAt),
          patient: w.patient.fio,
          position: w.nomenclature.nameDisplay,
          qty: num(w.qty),
          unit: w.nomenclature.unitWriteoff ?? '',
          opType: w.opType ?? w.operation?.opType ?? '',
          dateOp: d(w.operation?.dateOp),
          category: w.category.name,
          shortage: w.isShortage ? 'да' : '',
          costTotal: num(w.costTotal),
        })),
      };
    }
    default:
      throw badRequest('Неизвестный отчёт для выгрузки');
  }
}

router.get(
  '/:report',
  asyncHandler(async (req, res) => {
    const report = req.params.report.replace(/\.xlsx$/, '');
    const isAdmin = req.user!.role === 'admin';
    const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const period: ExportPeriod = {
      from: isDate(req.query.from) ? req.query.from : undefined,
      to: isDate(req.query.to) ? req.query.to : undefined,
    };
    const { sheet, columns, rows } = await buildReport(report, isAdmin, period);

    await writeAudit(req, {
      action: 'export',
      entity: `expense_${report}`,
      after: { rows: rows.length, from: period.from ?? null, to: period.to ?? null },
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // Только ASCII: кириллица в заголовке Content-Disposition недопустима.
    const suffix = period.from && period.to ? `_${period.from}--${period.to}` : period.from ? `_since-${period.from}` : period.to ? `_until-${period.to}` : '';
    res.setHeader('Content-Disposition', `attachment; filename="${report}${suffix}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

export default router;
