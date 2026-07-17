import { Router } from 'express';
import { z } from 'zod';
import { createHash } from 'crypto';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound, ApiError } from '../lib/http.js';
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

// Импорт прихода из Excel/CSV (admin). По умолчанию действует правило «стоп при
// ошибках»: если хоть одна строка с ошибкой — НЕ грузим ничего (чтобы позиции не
// терялись молча), возвращаем ошибки. Сотрудник может осознанно догрузить корректные
// строки, повторив запрос с allowPartial. Повторная загрузка блокируется по точному
// файлу (importHash) и по составу (contentHash), пока не подтверждён override.
router.post(
  '/import',
  requireAdmin,
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

    const receiptId = await prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          date,
          source: 'import',
          supplier: supplier ?? null,
          importHash,
          contentHash,
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
      await writeAudit(
        req,
        { action: 'create', entity: 'receipt', entityId: receipt.id, after: { imported: rows.length, source: 'import', partial: errors.length > 0 } },
        tx,
      );
      return receipt.id;
    });

    res.json({ imported: rows.length, valid: rows.length, blocked: false, blockReason: null, errors, warnings, header, receiptId });
  }),
);

// Отмена прихода (admin): удаляет документ и его партии целиком — например, чтобы
// исправить ошибочный файл импорта и загрузить заново. Разрешено ТОЛЬКО пока из
// партий ничего не списывали: иначе удаление исказило бы себестоимость прошлых
// списаний (FIFO/FEFO). Данные сохраняются в аудите (before) на случай разбора.
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const receipt = await prisma.receipt.findFirst({
      where: { id, deletedAt: null },
      include: {
        batches: {
          include: { allocations: { select: { id: true } }, nomenclature: { select: { nameDisplay: true } } },
        },
      },
    });
    if (!receipt) throw notFound('Приход не найден');

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
      await tx.receipt.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);

export default router;
