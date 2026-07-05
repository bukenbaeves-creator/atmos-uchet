import { Router } from 'express';
import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/http.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { normalizePhone } from '../lib/phone.js';
import { computeOperation } from '../services/compute.js';
import { serialize } from '../lib/serialize.js';
import { patientSearchOR } from '../lib/search.js';
import { requiredString, optionalDate } from '../schemas.js';

const schema = z.object({
  fio: requiredString('Необходимо указать ФИО'),
  phone: z
    .string({ required_error: 'Необходимо указать телефон', invalid_type_error: 'Необходимо указать телефон' })
    .min(3, 'Необходимо указать телефон')
    .transform(normalizePhone),
  birthDate: optionalDate,
  city: requiredString('Необходимо указать город'),
});

const router = makeCrudRouter({
  entity: 'patient',
  model: prisma.patient,
  createSchema: schema,
  orderBy: { fio: 'asc' },
  search: (t) => ({ OR: patientSearchOR(t, false) }),
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

export default router;
