import { Router } from 'express';
import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { requireAdmin } from '../middleware/rbac.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { normalizePhone } from '../lib/phone.js';
import { computeOperation } from '../services/compute.js';
import { serialize } from '../lib/serialize.js';
import { patientSearchOR } from '../lib/search.js';
import { writeAudit } from '../services/audit.service.js';
import { requiredString, birthDateSchema } from '../schemas.js';

const schema = z.object({
  fio: requiredString('Необходимо указать ФИО', 200),
  // Валидируем ПОСЛЕ нормализации: «abc» прошёл бы min(3), но нормализуется в пусто.
  phone: z
    .string({ required_error: 'Необходимо указать телефон', invalid_type_error: 'Необходимо указать телефон' })
    .transform(normalizePhone)
    .refine((v) => v.replace(/\D/g, '').length >= 10, 'Необходимо указать корректный телефон'),
  birthDate: birthDateSchema,
  city: requiredString('Необходимо указать город', 100),
});

// Услуги пациента для списка: собираем из операций (вид операции) и консультаций
// (интересующая операция / вид, иначе «Консультация»). Свежие — первыми, дубли убираем.
function collectServices(row: Record<string, unknown>): string[] {
  const toTime = (d: unknown) => {
    const t = typeof d === 'string' ? Date.parse(d) : 0;
    return Number.isNaN(t) ? 0 : t;
  };
  const items: Array<{ label: string; date: number }> = [];
  const ops = (row.operations as Array<Record<string, unknown>> | undefined) ?? [];
  for (const o of ops) {
    const label = String(o.opType ?? '').trim();
    if (label) items.push({ label, date: toTime(o.dateOp) });
  }
  const kons = (row.consultations as Array<Record<string, unknown>> | undefined) ?? [];
  for (const k of kons) {
    const label = String(k.interestOperation ?? k.vid ?? '').trim() || 'Консультация';
    items.push({ label, date: toTime(k.dateKons) });
  }
  items.sort((a, b) => b.date - a.date);
  const services: string[] = [];
  for (const it of items) if (!services.includes(it.label)) services.push(it.label);
  return services;
}

const router = makeCrudRouter({
  entity: 'patient',
  model: prisma.patient,
  createSchema: schema,
  orderBy: { fio: 'asc' },
  search: (t) => ({ OR: patientSearchOR(t, false) }),
  // Тянем услуги для колонки «Услуга» (только нужные поля связанных записей).
  include: {
    operations: {
      where: { deletedAt: null },
      orderBy: { dateOp: 'desc' },
      select: { opType: true, dateOp: true },
    },
    consultations: {
      where: { deletedAt: null },
      orderBy: { dateKons: 'desc' },
      select: { interestOperation: true, vid: true, dateKons: true },
    },
  },
  // Схлопываем историю в список услуг, сырые массивы из ответа убираем.
  transform: (row) => {
    const services = collectServices(row);
    const rest: Record<string, unknown> = { ...row };
    delete rest.operations;
    delete rest.consultations;
    return { ...rest, services };
  },
  validate: async (d) => {
    await assertDictionaryValue('city', d.city as string | null);
  },
});

// Карточка пациента: полная история + суммарный остаток (раздел 9.2 ТЗ).
router.get(
  '/:id/card',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: { id, deletedAt: null },
      include: {
        consultations: { where: { deletedAt: null }, orderBy: { dateKons: 'desc' } },
        operations: {
          where: { deletedAt: null },
          orderBy: { dateOp: 'desc' },
          include: { payments: { where: { deletedAt: null } } },
        },
        payments: { where: { deletedAt: null }, orderBy: { date: 'desc' } },
      },
    });
    if (!patient) throw notFound('Пациент не найден');

    const operations = patient.operations.map((op) => ({
      ...serialize(op),
      ...computeOperation(op),
    }));
    const totalBalance = operations.reduce((s, o) => s + o.balance, 0);

    res.json({
      patient: serialize({ ...patient, operations: undefined, consultations: undefined, payments: undefined }),
      consultations: serialize(patient.consultations),
      operations,
      payments: serialize(patient.payments),
      totalBalance,
    });
  }),
);

// Слияние дубля пациента в основную карточку (admin). Переносит все записи
// (консультации, операции, платежи, списания), дубль помечается удалённым.
router.post(
  '/:id/merge',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { intoId } = z.object({ intoId: z.coerce.number().int().positive() }).parse(req.body);
    if (id === intoId) throw badRequest('Нельзя объединить карточку саму с собой');

    await prisma.$transaction(async (tx) => {
      const dup = await tx.patient.findFirst({ where: { id, deletedAt: null } });
      const target = await tx.patient.findFirst({ where: { id: intoId, deletedAt: null } });
      if (!dup) throw notFound('Карточка-дубль не найдена');
      if (!target) throw notFound('Основная карточка не найдена');

      await tx.consultation.updateMany({ where: { patientId: id }, data: { patientId: intoId } });
      await tx.operation.updateMany({ where: { patientId: id }, data: { patientId: intoId } });
      await tx.payment.updateMany({ where: { patientId: id }, data: { patientId: intoId } });
      await tx.expenseWriteoff.updateMany({ where: { patientId: id }, data: { patientId: intoId } });

      const updated = await tx.patient.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: req.user!.id, mergedIntoId: intoId, updatedBy: req.user!.id },
      });
      await writeAudit(req, { action: 'update', entity: 'patient', entityId: id, before: dup, after: updated }, tx);
    });
    res.json({ ok: true });
  }),
);

export default router;
