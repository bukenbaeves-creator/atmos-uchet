import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound, forbidden } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, canEditRecord } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { recalcOperation } from '../services/payout-engine.service.js';
import { serialize } from '../lib/serialize.js';
import { requiredDate, requiredString, patientInputSchema } from '../schemas.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { allocateWriteoff, reverseWriteoffAllocations } from '../services/costing.service.js';
import { stripCost } from '../services/expense-visibility.service.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { patientSearchOR } from '../lib/search.js';

// Списание материалов на пациента/операцию. Основная операция медсестры.
// Себестоимость (costTotal) считается FIFO/FEFO и видна только администратору.
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

// Bulk-списание десятков позиций — одна транзакция с сотнями запросов; на проде (Neon,
// сетевые задержки) дефолтные 5с малы → P2028 «Внутренняя ошибка сервера». Поднимаем таймаут.
const TX_OPTS = { maxWait: 20_000, timeout: 120_000 };

const schema = z.object({
  patient: patientInputSchema,
  operationId: z.coerce.number().int().positive().optional().nullable(),
  opType: requiredString('Необходимо указать вид операции', 200), // из справочника op_type
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
          // phone/city/birthDate нужны форме правки (prefill PatientBlock)
          patient: { select: { id: true, fio: true, phone: true, city: true, birthDate: true } },
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
    await assertDictionaryValue('op_type', data.opType ?? null); // проверяем вид операции по справочнику

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
          opType: data.opType ?? null,
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
      if (data.operationId) await recalcOperation(data.operationId, tx); // Э2-3: себестоимость → база
      return writeoff;
    }, TX_OPTS);

    // Предупреждение о нехватке остатка — не блокирует, показывается пользователю
    const warning = result.isShortage
      ? 'Списано при нехватке остатка. Требуется корректировка прихода (дозавод партии).'
      : undefined;
    res.status(201).json({ ...stripCost(serialize(result), req.user!.role), warning });
  }),
);

// Массовое списание: несколько позиций на ОДНОГО пациента одной карточкой.
// Общие: пациент, категория, дата (и операция); по строкам — позиция + количество.
// Всё в одной транзакции: либо создаются все списания, либо ни одного.
const bulkSchema = z.object({
  patient: patientInputSchema,
  operationId: z.coerce.number().int().positive().optional().nullable(),
  opType: requiredString('Необходимо указать вид операции', 200), // общий для карточки
  categoryId: z.coerce.number().int().positive({ message: 'Выберите категорию расхода' }),
  date: requiredDate('Необходимо указать дату'),
  lines: z
    .array(
      z.object({
        nomenclatureId: z.coerce.number().int().positive({ message: 'Выберите позицию' }),
        qty: z.coerce.number({ invalid_type_error: 'Количество должно быть числом' }).positive('Количество должно быть больше нуля').max(1_000_000),
      }),
    )
    .min(1, 'Добавьте хотя бы одну позицию'),
});

router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const data = bulkSchema.parse(req.body);
    await assertDictionaryValue('op_type', data.opType ?? null); // проверяем вид операции по справочнику

    const created = await prisma.$transaction(async (tx) => {
      const cat = await tx.expenseCategory.findFirst({ where: { id: data.categoryId, isActive: true } });
      if (!cat) throw badRequest('Категория расхода не найдена');

      const patientId = await resolvePatient(data.patient, req, tx);

      if (data.operationId) {
        const op = await tx.operation.findFirst({ where: { id: data.operationId, deletedAt: null } });
        if (!op) throw badRequest('Операция не найдена');
        if (op.patientId !== patientId) throw badRequest('Операция принадлежит другому пациенту');
      }

      const rows = [];
      for (const line of data.lines) {
        const nom = await tx.nomenclature.findFirst({ where: { id: line.nomenclatureId, deletedAt: null } });
        if (!nom) throw badRequest('Позиция номенклатуры не найдена');
        if (nom.status !== 'active') throw badRequest(`Позиция «${nom.nameDisplay}» ещё не подтверждена администратором`);

        const alloc = await allocateWriteoff(line.nomenclatureId, new Prisma.Decimal(line.qty), tx);
        const writeoff = await tx.expenseWriteoff.create({
          data: {
            patientId,
            operationId: data.operationId ?? null,
            opType: data.opType ?? null,
            nomenclatureId: line.nomenclatureId,
            categoryId: data.categoryId,
            qty: line.qty,
            costTotal: alloc.costTotal,
            isShortage: alloc.isShortage,
            date: data.date,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
            allocations: { create: alloc.allocations.map((a) => ({ batchId: a.batchId, qty: a.qty, cost: a.cost })) },
          },
          include: {
            patient: { select: { id: true, fio: true } },
            nomenclature: { select: { nameDisplay: true, unitWriteoff: true } },
            category: { select: { name: true } },
          },
        });
        await writeAudit(req, { action: 'create', entity: 'writeoff', entityId: writeoff.id, after: writeoff }, tx);
        rows.push(writeoff);
      }
      if (data.operationId) await recalcOperation(data.operationId, tx); // Э2-3: все строки — одна операция
      return rows;
    }, TX_OPTS);

    // Позиции, списанные при нехватке остатка (в минус) — показываем, но не блокируем.
    const shortages = created.filter((w) => w.isShortage).map((w) => w.nomenclature?.nameDisplay ?? '—');
    res.status(201).json({ created: created.length, shortages, items: stripCost(serialize(created), req.user!.role) });
  }),
);

// Позиции из прошлого списания по виду операции — для быстрого заполнения формы.
// Возвращает уникальные активные позиции последней «сессии» (тот же пациент+дата+opType).
// БЕЗ количеств — их медсестра вводит сама.
router.get(
  '/template',
  asyncHandler(async (req, res) => {
    const opType = String(req.query.opType ?? '').trim();
    if (!opType) return res.json({ positions: [] });
    const last = await prisma.expenseWriteoff.findFirst({
      where: { opType, deletedAt: null },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    if (!last) return res.json({ positions: [] });
    const rows = await prisma.expenseWriteoff.findMany({
      where: { opType, deletedAt: null, patientId: last.patientId, date: last.date },
      include: { nomenclature: { select: { id: true, nameDisplay: true, unitWriteoff: true, status: true, deletedAt: true } } },
      orderBy: { id: 'asc' },
    });
    const seen = new Set<number>();
    const positions: { nomenclatureId: number; nameDisplay: string; unitWriteoff: string | null }[] = [];
    for (const r of rows) {
      const n = r.nomenclature;
      if (!n || n.status !== 'active' || n.deletedAt || seen.has(r.nomenclatureId)) continue;
      seen.add(r.nomenclatureId);
      positions.push({ nomenclatureId: r.nomenclatureId, nameDisplay: n.nameDisplay, unitWriteoff: n.unitWriteoff });
    }
    res.json({ positions });
  }),
);

// Общая часть include для ответа по одному списанию
const oneInclude = {
  patient: { select: { id: true, fio: true } },
  nomenclature: { select: { nameDisplay: true, unitWriteoff: true } },
  category: { select: { name: true } },
} as const;

// Правка списания (исправление ошибки). Права: админ — любую, медсестра — свою в день
// создания (canEditRecord). Остаток пересчитывается: старые аллокации возвращаются в
// партии, затем начисляются новые по актуальным позиции/количеству.
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.expenseWriteoff.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Списание не найдено');
    if (!canEditRecord(req.user!, existing)) {
      throw forbidden('Правка недоступна: доступно администратору или автору в день создания.');
    }
    const data = schema.parse(req.body);
    await assertDictionaryValue('op_type', data.opType);

    const updated = await prisma.$transaction(async (tx) => {
      const nom = await tx.nomenclature.findFirst({ where: { id: data.nomenclatureId, deletedAt: null } });
      if (!nom) throw badRequest('Позиция номенклатуры не найдена');
      if (nom.status !== 'active') throw badRequest('Позиция ещё не подтверждена администратором');
      const cat = await tx.expenseCategory.findFirst({ where: { id: data.categoryId, isActive: true } });
      if (!cat) throw badRequest('Категория расхода не найдена');
      const patientId = await resolvePatient(data.patient, req, tx);
      if (data.operationId) {
        const op = await tx.operation.findFirst({ where: { id: data.operationId, deletedAt: null } });
        if (!op) throw badRequest('Операция не найдена');
        if (op.patientId !== patientId) throw badRequest('Операция принадлежит другому пациенту');
      }

      await reverseWriteoffAllocations(id, tx); // вернуть старое количество в партии
      const alloc = await allocateWriteoff(data.nomenclatureId, new Prisma.Decimal(data.qty), tx);
      const row = await tx.expenseWriteoff.update({
        where: { id },
        data: {
          patientId,
          operationId: data.operationId ?? null,
          opType: data.opType,
          nomenclatureId: data.nomenclatureId,
          categoryId: data.categoryId,
          qty: data.qty,
          costTotal: alloc.costTotal,
          isShortage: alloc.isShortage,
          date: data.date,
          updatedBy: req.user!.id,
          allocations: { create: alloc.allocations.map((a) => ({ batchId: a.batchId, qty: a.qty, cost: a.cost })) },
        },
        include: oneInclude,
      });
      await writeAudit(req, { action: 'update', entity: 'writeoff', entityId: id, before: existing, after: row }, tx);
      // Э2-3: пересчёт по прежней и новой операции (себестоимость могла переехать).
      const opIds = new Set<number>();
      if (existing.operationId) opIds.add(existing.operationId);
      if (data.operationId) opIds.add(data.operationId);
      for (const oid of opIds) await recalcOperation(oid, tx);
      return row;
    });

    const warning = updated.isShortage ? 'Списано при нехватке остатка. Требуется корректировка прихода.' : undefined;
    res.json({ ...stripCost(serialize(updated), req.user!.role), warning });
  }),
);

// Удаление (отмена) ошибочного списания. Права как у правки. Возвращает остаток в партии.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.expenseWriteoff.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Списание не найдено');
    if (!canEditRecord(req.user!, existing)) {
      throw forbidden('Удаление недоступно: доступно администратору или автору в день создания.');
    }
    await prisma.$transaction(async (tx) => {
      await reverseWriteoffAllocations(id, tx); // вернуть материал на склад
      await tx.expenseWriteoff.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: req.user!.id } });
      await writeAudit(req, { action: 'delete', entity: 'writeoff', entityId: id, before: existing }, tx);
      if (existing.operationId) await recalcOperation(existing.operationId, tx); // Э2-3
    });
    res.status(204).end();
  }),
);

export default router;
