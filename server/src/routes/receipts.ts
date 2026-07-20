import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { prisma, type PrismaClientOrTx } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound, forbidden, ApiError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { serialize } from '../lib/serialize.js';
import { requiredDate, optionalDate, optionalString, moneyAmount } from '../schemas.js';
import { matchOrCreateNomenclature } from '../services/nomenclature-match.service.js';
import { parseReceiptRows, type ParsedLine } from '../services/receipt-import.service.js';
import { stripCost } from '../services/expense-visibility.service.js';

// Сигнатура состава прихода: нормализованные (наименование + количество), без учёта
// порядка и форматирования. Ловит повторную загрузку того же прихода из изменённого
// файла (другой хеш файла, но тот же товар).
function contentSignature(rows: ParsedLine[]): string {
  const norm = rows
    .map((r) => `${r.name.toLowerCase().replace(/\s+/g, ' ').trim()}|${r.qty}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(norm).digest('hex');
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Приход на склад. Создаёт документ и партии; наименования сопоставляются со
// справочником номенклатуры (новые попадают в draft на модерацию). Цена закупа —
// только для admin (в ответе усечена для остальных).
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

const qty = z.coerce.number({ invalid_type_error: 'Количество должно быть числом' }).positive('Количество должно быть больше нуля').max(1_000_000);

const lineSchema = z.object({
  name: z.string().trim().min(1, 'Укажите наименование позиции').max(300),
  qty,
  purchasePrice: moneyAmount(),
  series: optionalString(100),
  expiryDate: optionalDate,
});

const schema = z.object({
  date: requiredDate('Необходимо указать дату прихода'),
  supplier: optionalString(200),
  note: optionalString(500),
  lines: z.array(lineSchema).min(1, 'Добавьте хотя бы одну позицию'),
});

// Что отдаём по приходу: партии (одобренный) + строки (на согласовании).
const receiptInclude = {
  batches: { include: { nomenclature: { select: { nameDisplay: true } } } },
  lines: true,
};

// Применяет к позиции свойства из строки прихода: тип и мин.остаток (если заданы —
// приходят из Excel-импорта), единицу — только если у позиции она ещё пустая.
async function applyNomAttrs(
  tx: PrismaClientOrTx,
  nomenclatureId: number,
  attrs: { type?: 'drug' | 'consumable' | null; minStock?: number | null; unit?: string | null },
  userId: number,
) {
  const data: Record<string, unknown> = {};
  if (attrs.type) data.type = attrs.type;
  if (attrs.minStock != null) data.minStock = attrs.minStock;
  if (Object.keys(data).length) await tx.nomenclature.update({ where: { id: nomenclatureId }, data: { ...data, updatedBy: userId } });
  if (attrs.unit) await tx.nomenclature.updateMany({ where: { id: nomenclatureId, unitMeasure: null }, data: { unitMeasure: attrs.unit } });
}

// Создаёт партии из строк (одобренный приход): сопоставляет номенклатуру и применяет свойства.
async function materializeLines(
  tx: PrismaClientOrTx,
  receiptId: number,
  date: Date,
  lines: Array<{ name: string; qty: number; purchasePrice: number; series?: string | null; expiryDate?: Date | null; unit?: string | null; type?: 'drug' | 'consumable' | null; minStock?: number | null }>,
  req: Request,
) {
  for (const line of lines) {
    const match = await matchOrCreateNomenclature(line.name, req, tx);
    await applyNomAttrs(tx, match.nomenclatureId, line, req.user!.id);
    await tx.batch.create({
      data: {
        receiptId,
        nomenclatureId: match.nomenclatureId,
        qtyIn: line.qty,
        qtyRemaining: line.qty,
        purchasePrice: line.purchasePrice,
        series: line.series ?? null,
        expiryDate: line.expiryDate ?? null,
        receivedAt: date,
        createdBy: req.user!.id,
      },
    });
  }
}

// Сохраняет строки прихода «на согласовании» (партии не создаём — на остаток не влияет).
async function storeLines(
  tx: PrismaClientOrTx,
  receiptId: number,
  lines: Array<{ name: string; qty: number; purchasePrice: number; series?: string | null; expiryDate?: Date | null; unit?: string | null; type?: 'drug' | 'consumable' | null; minStock?: number | null }>,
) {
  for (const line of lines) {
    await tx.receiptLine.create({
      data: {
        receiptId,
        name: line.name,
        qty: line.qty,
        purchasePrice: line.purchasePrice,
        series: line.series ?? null,
        expiryDate: line.expiryDate ?? null,
        unit: line.unit ?? null,
        type: line.type ?? null,
        minStock: line.minStock ?? null,
      },
    });
  }
}

// Список приходов (admin: с ценами партий; nurse обычно сюда не ходит, но роль не запрещаем на чтение)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number((req.query as Record<string, unknown>).page ?? 1));
    const pageSize = 50;
    const [rows, total] = await Promise.all([
      prisma.receipt.findMany({
        where: { deletedAt: null },
        include: receiptInclude,
        orderBy: [{ status: 'desc' }, { date: 'desc' }], // pending — вверху (сначала «на согласовании»)
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.receipt.count({ where: { deletedAt: null } }),
    ]);
    res.json({ items: stripCost(serialize(rows), req.user!.role), total, page, pageSize });
  }),
);

// Создание прихода (nurse и admin). Админ создаёт сразу одобренный приход (партии
// создаются, остаток меняется). Медсестра создаёт приход «на согласовании»: строки
// сохраняются, партии НЕ создаются — на остаток не влияет, пока админ не одобрит.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const isAdmin = req.user!.role === 'admin';
    const created = await prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          date: data.date,
          source: 'manual',
          status: isAdmin ? 'approved' : 'pending',
          supplier: data.supplier ?? null,
          note: data.note ?? null,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
          ...(isAdmin ? { approvedBy: req.user!.id, approvedAt: new Date() } : {}),
        },
      });
      if (isAdmin) await materializeLines(tx, receipt.id, data.date, data.lines, req);
      else await storeLines(tx, receipt.id, data.lines);

      const full = await tx.receipt.findUnique({ where: { id: receipt.id }, include: receiptInclude });
      await writeAudit(req, { action: 'create', entity: 'receipt', entityId: receipt.id, after: { status: receipt.status, lines: data.lines.length } }, tx);
      return full;
    });
    res.status(201).json(stripCost(serialize(created), req.user!.role));
  }),
);

// Шаблон для импорта прихода (nurse и admin): заголовки + пример строки.
router.get(
  '/template.xlsx',
  asyncHandler(async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Приход');
    ws.columns = [
      { header: 'Наименование', key: 'name', width: 34 },
      { header: 'Количество', key: 'qty', width: 14 },
      { header: 'Цена закупа', key: 'price', width: 14 },
      { header: 'Серия', key: 'series', width: 16 },
      { header: 'Срок годности (дд.мм.гггг, пусто = бессрочно)', key: 'expiry', width: 40 },
      { header: 'Единица', key: 'unit', width: 12 },
      { header: 'Тип (расходник/препарат)', key: 'type', width: 24 },
      { header: 'Минимальный остаток', key: 'minStock', width: 20 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({ name: 'Шприц 5мл', qty: 100, price: 50, series: 'S-2026-01', expiry: '01.12.2027', unit: 'шт', type: 'расходник', minStock: 50 });
    ws.addRow({ name: 'Лидокаин 2%', qty: 20, price: 300, series: 'L-2026-02', expiry: '01.06.2027', unit: 'амп', type: 'препарат', minStock: 10 });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="receipt-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  }),
);

// Импорт прихода из Excel/CSV (admin). По умолчанию действует правило «стоп при
// ошибках»: если хоть одна строка с ошибкой — НЕ грузим ничего (чтобы позиции не
// терялись молча), возвращаем ошибки. Сотрудник может осознанно догрузить корректные
// строки, повторив запрос с allowPartial. Повторная загрузка блокируется по точному
// файлу (importHash) и по составу (contentHash), пока не подтверждён override.
router.post(
  '/import',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Файл не загружен');
    const date = requiredDate('Необходимо указать дату прихода').parse(req.body?.date);
    const supplier = optionalString(200).parse(req.body?.supplier ?? null);
    const override = req.body?.override === 'true' || req.body?.override === '1';
    const allowPartial = req.body?.allowPartial === 'true' || req.body?.allowPartial === '1';
    const confirmExpired = req.body?.confirmExpired === 'true' || req.body?.confirmExpired === '1';

    const { rows, errors, warnings, header } = await parseReceiptRows(req.file.buffer, req.file.originalname);

    // Нет ни одной корректной строки, либо есть ошибки и явно не разрешена частичная
    // загрузка → не грузим НИЧЕГО. Возвращаем отчёт, чтобы исправить файл и повторить.
    if (!rows.length || (errors.length > 0 && !allowPartial)) {
      return res.json({ imported: 0, valid: rows.length, blocked: true, blockReason: 'errors', errors, warnings, header, receiptId: null });
    }
    // Есть просроченные позиции — не грузим на склад, пока не подтвердят явно.
    if (warnings.length > 0 && !confirmExpired) {
      return res.json({ imported: 0, valid: rows.length, blocked: true, blockReason: 'expired', errors, warnings, header, receiptId: null });
    }

    const importHash = createHash('sha256').update(req.file.buffer).digest('hex');
    const contentHash = contentSignature(rows);
    if (!override) {
      const dupFile = await prisma.receipt.findFirst({ where: { importHash, deletedAt: null } });
      if (dupFile) throw new ApiError(409, 'Этот файл уже загружался. Для повторной загрузки подтвердите действие.');
      const dupContent = await prisma.receipt.findFirst({ where: { contentHash, deletedAt: null } });
      if (dupContent)
        throw new ApiError(409, 'Приход с такими же позициями уже загружался (возможно, изменённый файл). Для повторной загрузки подтвердите действие.');
    }

    const isAdmin = req.user!.role === 'admin';
    const receiptId = await prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          date,
          source: 'import',
          status: isAdmin ? 'approved' : 'pending',
          supplier: supplier ?? null,
          importHash,
          contentHash,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
          ...(isAdmin ? { approvedBy: req.user!.id, approvedAt: new Date() } : {}),
        },
      });
      // Админ — сразу создаём партии; медсестра — сохраняем строки на согласование.
      if (isAdmin) await materializeLines(tx, receipt.id, date, rows, req);
      else await storeLines(tx, receipt.id, rows);
      await writeAudit(
        req,
        { action: 'create', entity: 'receipt', entityId: receipt.id, after: { imported: rows.length, source: 'import', status: receipt.status, partial: errors.length > 0 } },
        tx,
      );
      return receipt.id;
    });

    res.json({ imported: rows.length, valid: rows.length, blocked: false, blockReason: null, pending: !isAdmin, errors, warnings, header, receiptId });
  }),
);

// Список поставщиков (для автоподсказки при вводе прихода).
router.get(
  '/suppliers',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.receipt.findMany({
      where: { deletedAt: null, supplier: { not: null } },
      distinct: ['supplier'],
      select: { supplier: true },
      orderBy: { supplier: 'asc' },
      take: 500,
    });
    res.json({ items: rows.map((r) => r.supplier).filter(Boolean) });
  }),
);

// Одобрение прихода «на согласовании» (admin): из строк создаются партии (влияют на
// остаток), применяются свойства позиций (тип/мин.остаток/единица), строки удаляются.
router.patch(
  '/:id/approve',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const approved = await prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
      if (!receipt) throw notFound('Приход не найден');
      if (receipt.status !== 'pending') throw badRequest('Приход уже одобрен');
      if (!receipt.lines.length) throw badRequest('В приходе нет позиций');

      const lines = receipt.lines.map((l) => ({
        name: l.name,
        qty: Number(l.qty),
        purchasePrice: Number(l.purchasePrice),
        series: l.series,
        expiryDate: l.expiryDate,
        unit: l.unit,
        type: l.type,
        minStock: l.minStock != null ? Number(l.minStock) : null,
      }));
      await materializeLines(tx, id, receipt.date, lines, req);
      await tx.receiptLine.deleteMany({ where: { receiptId: id } });
      const updated = await tx.receipt.update({
        where: { id },
        data: { status: 'approved', approvedBy: req.user!.id, approvedAt: new Date(), updatedBy: req.user!.id },
        include: receiptInclude,
      });
      await writeAudit(req, { action: 'update', entity: 'receipt', entityId: id, after: { status: 'approved', approved: lines.length } }, tx);
      return updated;
    });
    res.json(stripCost(serialize(approved), req.user!.role));
  }),
);

// Отмена/отклонение прихода. Приход «на согласовании» может отклонить админ или
// создавшая его медсестра (партий ещё нет — просто удаляем строки). Одобренный приход
// отменяет только админ и только пока из партий ничего не списывали (иначе исказится
// себестоимость прошлых списаний). Данные сохраняются в аудите (before).
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const isAdmin = req.user!.role === 'admin';
    const receipt = await prisma.receipt.findFirst({
      where: { id, deletedAt: null },
      include: {
        batches: {
          include: { allocations: { select: { id: true } }, nomenclature: { select: { nameDisplay: true } } },
        },
      },
    });
    if (!receipt) throw notFound('Приход не найден');

    // «На согласовании» — партий нет, отклоняем (удаляем строки).
    if (receipt.status === 'pending') {
      if (!isAdmin && receipt.createdBy !== req.user!.id) throw forbidden('Отклонить можно только свой приход на согласовании');
      await prisma.$transaction(async (tx) => {
        await writeAudit(req, { action: 'delete', entity: 'receipt', entityId: id, before: receipt }, tx);
        await tx.receiptLine.deleteMany({ where: { receiptId: id } });
        await tx.receipt.delete({ where: { id } });
      });
      return res.json({ ok: true });
    }

    // Одобренный приход — только админ.
    if (!isAdmin) throw forbidden('Отменять одобренный приход может только администратор');

    // Партии, из которых уже списывали (есть распределения или остаток меньше прихода).
    const consumed = receipt.batches.filter((b) => b.allocations.length > 0 || !b.qtyRemaining.equals(b.qtyIn));
    if (consumed.length) {
      const names = [...new Set(consumed.map((b) => b.nomenclature?.nameDisplay ?? '—'))].join(', ');
      throw new ApiError(409, `Нельзя отменить приход: из позиций уже есть списания (${names}). Сначала отмените списания.`);
    }

    await prisma.$transaction(async (tx) => {
      // Повторная проверка ВНУТРИ транзакции: между первой проверкой и удалением
      // из партии могли успеть списать (гонка). Здесь блокируем такой случай.
      const fresh = await tx.batch.findMany({
        where: { receiptId: id },
        include: { allocations: { select: { id: true } } },
      });
      if (fresh.some((b) => b.allocations.length > 0 || !b.qtyRemaining.equals(b.qtyIn))) {
        throw new ApiError(409, 'Нельзя отменить приход: из позиций только что появились списания.');
      }
      // Пишем аудит до удаления — со всем составом, чтобы приход можно было восстановить вручную.
      await writeAudit(req, { action: 'delete', entity: 'receipt', entityId: id, before: receipt }, tx);
      await tx.batch.deleteMany({ where: { receiptId: id } });
      await tx.receiptLine.deleteMany({ where: { receiptId: id } });
      await tx.receipt.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);

export default router;
