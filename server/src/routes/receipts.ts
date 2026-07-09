import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, ApiError } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { serialize } from '../lib/serialize.js';
import { requiredDate, optionalDate, optionalString, moneyAmount } from '../schemas.js';
import { matchOrCreateNomenclature } from '../services/nomenclature-match.service.js';
import { parseReceiptRows } from '../services/receipt-import.service.js';
import { stripCost } from '../services/expense-visibility.service.js';

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

// Список приходов (admin: с ценами партий; nurse обычно сюда не ходит, но роль не запрещаем на чтение)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number((req.query as Record<string, unknown>).page ?? 1));
    const pageSize = 50;
    const [rows, total] = await Promise.all([
      prisma.receipt.findMany({
        where: { deletedAt: null },
        include: { batches: { include: { nomenclature: { select: { nameDisplay: true } } } } },
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.receipt.count({ where: { deletedAt: null } }),
    ]);
    res.json({ items: stripCost(serialize(rows), req.user!.role), total, page, pageSize });
  }),
);

// Создание прихода (только admin — приход управляет ценами закупа).
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);
    const created = await prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          date: data.date,
          source: 'manual',
          supplier: data.supplier ?? null,
          note: data.note ?? null,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      for (const line of data.lines) {
        const match = await matchOrCreateNomenclature(line.name, req, tx);
        await tx.batch.create({
          data: {
            receiptId: receipt.id,
            nomenclatureId: match.nomenclatureId,
            qtyIn: line.qty,
            qtyRemaining: line.qty,
            purchasePrice: line.purchasePrice,
            series: line.series ?? null,
            expiryDate: line.expiryDate ?? null,
            receivedAt: data.date,
            createdBy: req.user!.id,
          },
        });
      }
      const full = await tx.receipt.findUnique({
        where: { id: receipt.id },
        include: { batches: { include: { nomenclature: { select: { nameDisplay: true } } } } },
      });
      await writeAudit(req, { action: 'create', entity: 'receipt', entityId: receipt.id, after: full }, tx);
      return full;
    });
    res.status(201).json(stripCost(serialize(created), req.user!.role));
  }),
);

// Шаблон для импорта прихода (admin): заголовки + пример строки.
router.get(
  '/template.xlsx',
  requireAdmin,
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
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({ name: 'Шприц 5мл', qty: 100, price: 50, series: 'S-2026-01', expiry: '01.12.2027', unit: 'шт' });
    ws.addRow({ name: 'Вата стерильная', qty: 20, price: 30, series: '', expiry: '', unit: 'уп' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="receipt-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  }),
);

// Импорт прихода из Excel/CSV (admin). Валидные строки создают партии, строки с
// ошибками возвращаются в отчёте. Повторная загрузка того же файла блокируется
// (importHash), пока не указан override.
router.post(
  '/import',
  requireAdmin,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Файл не загружен');
    const date = requiredDate('Необходимо указать дату прихода').parse(req.body?.date);
    const supplier = optionalString(200).parse(req.body?.supplier ?? null);
    const override = req.body?.override === 'true' || req.body?.override === '1';

    const importHash = createHash('sha256').update(req.file.buffer).digest('hex');
    if (!override) {
      const dup = await prisma.receipt.findFirst({ where: { importHash, deletedAt: null } });
      if (dup) throw new ApiError(409, 'Этот файл уже загружался. Для повторной загрузки подтвердите действие.');
    }

    const { rows, errors } = await parseReceiptRows(req.file.buffer, req.file.originalname);
    if (!rows.length) {
      return res.json({ imported: 0, errors, receiptId: null });
    }

    const receiptId = await prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          date,
          source: 'import',
          supplier: supplier ?? null,
          importHash,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      for (const line of rows) {
        const match = await matchOrCreateNomenclature(line.name, req, tx);
        // Единица из файла — на новую позицию (если её ещё не заполнили)
        if (line.unit) {
          await tx.nomenclature.updateMany({
            where: { id: match.nomenclatureId, unitMeasure: null },
            data: { unitMeasure: line.unit },
          });
        }
        await tx.batch.create({
          data: {
            receiptId: receipt.id,
            nomenclatureId: match.nomenclatureId,
            qtyIn: line.qty,
            qtyRemaining: line.qty,
            purchasePrice: line.purchasePrice,
            series: line.series,
            expiryDate: line.expiryDate,
            receivedAt: date,
            createdBy: req.user!.id,
          },
        });
      }
      await writeAudit(req, { action: 'create', entity: 'receipt', entityId: receipt.id, after: { imported: rows.length, source: 'import' } }, tx);
      return receipt.id;
    });

    res.json({ imported: rows.length, errors, receiptId });
  }),
);

export default router;
