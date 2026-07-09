import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { serialize } from '../lib/serialize.js';
import { requiredDate, patientInputSchema } from '../schemas.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { allocateWriteoff } from '../services/costing.service.js';
import { stripCost } from '../services/expense-visibility.service.js';
import { patientSearchOR } from '../lib/search.js';

// Списание материалов на пациента/операцию. Основная операция медсестры.
// Себестоимость (costTotal) считается FIFO/FEFO и видна только администратору.
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

const schema = z.object({
  patient: patientInputSchema,
  operationId: z.coerce.number().int().positive().optional().nullable(),
  nomenclatureId: z.coerce.number().int().positive({ message: 'Выберите позицию' }),
  categoryId: z.coerce.number().int().positive({ message: 'Выберите категорию расхода' }),
  qty: z.coerce.number({ invalid_type_error: 'Количество должно быть числом' }).positive('Количество должно быть больше нуля').max(1_000_000),
  date: requiredDate('Необходимо указать дату'),
});

// Список списаний. ?shortage=1 — только списания «в минус» (для admin).
// ?patientId — по пациенту. Стоимости усечены для не-админа.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = 50;
    const where: Record<string, unknown> = { deletedAt: null };
    if (q.shortage === '1') where.isShortage = true;
    if (typeof q.patientId === 'string' && q.patientId) where.patientId = Number(q.patientId);
    if (typeof q.search === 'string' && q.search.trim()) {
      where.OR = patientSearchOR(q.search.trim(), true);
    }
    const [rows, total] = await Promise.all([
      prisma.expenseWriteoff.findMany({
        where,
        include: {
          patient: { select: { id: true, fio: true } },
          nomenclature: { select: { nameDisplay: true, unitWriteoff: true } },
          category: { select: { name: true } },
        },
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.expenseWriteoff.count({ where }),
    ]);
    res.json({ items: stripCost(serialize(rows), req.user!.role), total, page, pageSize });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = schema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      // Позиция должна быть подтверждена (active) — списывать draft нельзя
      const nom = await tx.nomenclature.findFirst({ where: { id: data.nomenclatureId, deletedAt: null } });
      if (!nom) throw badRequest('Позиция номенклатуры не найдена');
      if (nom.status !== 'active') throw badRequest('Позиция ещё не подтверждена администратором');

      const cat = await tx.expenseCategory.findFirst({ where: { id: data.categoryId, isActive: true } });
      if (!cat) throw badRequest('Категория расхода не найдена');

      const patientId = await resolvePatient(data.patient, req, tx);

      // Операция (если указана) должна принадлежать этому пациенту
      if (data.operationId) {
        const op = await tx.operation.findFirst({ where: { id: data.operationId, deletedAt: null } });
        if (!op) throw badRequest('Операция не найдена');
        if (op.patientId !== patientId) throw badRequest('Операция принадлежит другому пациенту');
      }

      const alloc = await allocateWriteoff(data.nomenclatureId, new Prisma.Decimal(data.qty), tx);

      const writeoff = await tx.expenseWriteoff.create({
        data: {
          patientId,
          operationId: data.operationId ?? null,
          nomenclatureId: data.nomenclatureId,
          categoryId: data.categoryId,
          qty: data.qty,
          costTotal: alloc.costTotal,
          isShortage: alloc.isShortage,
          date: data.date,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
          allocations: {
            create: alloc.allocations.map((a) => ({ batchId: a.batchId, qty: a.qty, cost: a.cost })),
          },
        },
        include: {
          patient: { select: { id: true, fio: true } },
          nomenclature: { select: { nameDisplay: true, unitWriteoff: true } },
          category: { select: { name: true } },
        },
      });
      await writeAudit(req, { action: 'create', entity: 'writeoff', entityId: writeoff.id, after: writeoff }, tx);
      return writeoff;
    });

    // Предупреждение о нехватке остатка — не блокирует, показывается пользователю
    const warning = result.isShortage
      ? 'Списано при нехватке остатка. Требуется корректировка прихода (дозавод партии).'
      : undefined;
    res.status(201).json({ ...stripCost(serialize(result), req.user!.role), warning });
  }),
);

export default router;
