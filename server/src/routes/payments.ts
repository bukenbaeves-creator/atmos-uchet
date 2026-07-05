import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { patientInputSchema, requiredDate, requiredString } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { PREPAYMENT_SERVICE } from '../constants.js';
import { writeAudit } from '../services/audit.service.js';

// Виды услуг, для которых нужен «вид операции»
const OP_SERVICES = ['Операция', 'Консультация', PREPAYMENT_SERVICE];
const TERMINAL_METHOD = 'Через терминал';

const schema = z
  .object({
    patient: patientInputSchema,
    operationId: z.coerce.number().int().positive().optional().nullable(),
    // Стоимость операции — только для предоплаты, когда операция создаётся на лету
    operationCost: z.coerce.number().nonnegative().optional().nullable(),
    date: requiredDate('Необходимо указать дату платежа'),
    serviceType: requiredString('Необходимо указать вид услуги'),
    opType: z.string().optional().nullable(),
    amount: z.coerce
      .number({ invalid_type_error: 'Сумма должна быть числом' })
      .positive('Необходимо указать сумму'),
    payMethod: requiredString('Необходимо указать способ оплаты'),
    terminal: z.string().optional().nullable(),
    payNote: z.string().optional().nullable(),
    zapis: requiredString('Необходимо указать запись'),
    doctor: requiredString('Необходимо указать врача'),
  })
  // Вид операции обязателен для услуг «Операция/Консультация/Предоплата»
  .refine((d) => !OP_SERVICES.includes(d.serviceType) || !!d.opType, {
    message: 'Необходимо указать вид операции',
    path: ['opType'],
  })
  // Терминал обязателен при оплате «Через терминал»
  .refine((d) => d.payMethod !== TERMINAL_METHOD || !!d.terminal, {
    message: 'Необходимо указать терминал',
    path: ['terminal'],
  });

const router = makeCrudRouter({
  entity: 'payment',
  model: prisma.payment,
  createSchema: schema,
  include: { patient: true, operation: true },
  orderBy: { date: 'desc' },
  buildWhere: (q) => {
    const where: Record<string, unknown> = {};
    if (typeof q.payMethod === 'string' && q.payMethod) where.payMethod = q.payMethod;
    if (typeof q.terminal === 'string' && q.terminal) where.terminal = q.terminal;
    if (typeof q.operationId === 'string' && q.operationId) where.operationId = Number(q.operationId);
    if (typeof q.patientId === 'string' && q.patientId) where.patientId = Number(q.patientId);
    return where;
  },
  search: (t) => ({ OR: [...patientSearchOR(t, true), { payMethod: { contains: t, mode: 'insensitive' } }] }),
  validate: async (d) => {
    await assertDictionaryValue('service_type', d.serviceType as string | null);
    await assertDictionaryValue('op_type', d.opType as string | null);
    await assertDictionaryValue('pay_method', d.payMethod as string | null);
    await assertDictionaryValue('terminal', d.terminal as string | null);
    await assertDictionaryValue('doctor', d.doctor as string | null);
    await assertDictionaryValue('zapis', d.zapis as string | null);
  },
  prepareData: async (data, req) => {
    const { patient, operationCost, ...rest } = data as Record<string, unknown> & { patient: never };
    const patientId = await resolvePatient(patient, req);
    let operationId = (rest.operationId as number | null) ?? null;

    // Предоплата без выбранной операции -> создаём операцию на лету из вида операции
    if (rest.serviceType === PREPAYMENT_SERVICE && !operationId) {
      const op = await prisma.operation.create({
        data: {
          patientId,
          dateOp: (rest.date as Date) ?? new Date(),
          opType: (rest.opType as string) ?? null,
          cost: (operationCost as number) ?? 0,
          anesthesiaCost: 0,
          contractSigned: false,
          note: 'Создано из предоплаты (Касса)',
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      await writeAudit(req, { action: 'create', entity: 'operation', entityId: op.id, after: op });
      operationId = op.id;
    }

    return { ...rest, patientId, operationId };
  },
});

export default router;
