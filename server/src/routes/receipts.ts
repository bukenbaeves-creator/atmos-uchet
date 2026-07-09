import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { serialize } from '../lib/serialize.js';
import { requiredDate, optionalDate, optionalString, moneyAmount } from '../schemas.js';
import { matchOrCreateNomenclature } from '../services/nomenclature-match.service.js';
import { stripCost } from '../services/expense-visibility.service.js';

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

export default router;
