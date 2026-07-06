import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { patientInputSchema, requiredDate, requiredString, optionalDate } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { PREPAYMENT_SERVICE } from '../constants.js';
import { writeAudit } from '../services/audit.service.js';

// Виды услуг, для которых нужен «вид операции»
const OP_SERVICES = ['Операция', 'Консультация', PREPAYMENT_SERVICE];
// Услуги, за которые платёж относится к операции (её можно создать на лету)
const OPERATION_SERVICES = ['Операция', PREPAYMENT_SERVICE];
const TERMINAL_METHOD = 'Через терминал';

// Признак «создаётся новая операция»: услуга про операцию и не выбрана существующая
const createsOperation = (d: { serviceType: string; operationId?: number | null }) =>
  OPERATION_SERVICES.includes(d.serviceType) && !d.operationId;

const schema = z
  .object({
    patient: patientInputSchema,
    operationId: z.coerce.number().int().positive().optional().nullable(),
    // Служебные поля для создания операции на лету (не колонки Payment):
    operationCost: z.coerce.number().nonnegative().optional().nullable(),
    operationDate: optionalDate,
    manager: z.string().optional().nullable(),
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
  // При создании новой операции нужны дата операции и менеджер
  .refine((d) => !createsOperation(d) || !!d.operationDate, {
    message: 'Необходимо указать дату операции',
    path: ['operationDate'],
  })
  .refine((d) => !createsOperation(d) || !!d.manager, {
    message: 'Необходимо указать менеджера',
    path: ['manager'],
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
    await assertDictionaryValue('manager', d.manager as string | null);
  },
  prepareData: async (data, req) => {
    // operationCost / operationDate / manager — служебные, в Payment не пишем
    const { patient, operationCost, operationDate, manager, ...rest } = data as Record<
      string,
      unknown
    > & { patient: never };
    const patientId = await resolvePatient(patient, req);
    let operationId = (rest.operationId as number | null) ?? null;

    // Услуга про операцию, но операция не выбрана -> создаём её на лету, полностью
    // заполненную (дата, тип, стоимость, хирург, запись, менеджер) — чтобы корректно
    // учитывалась в отчётах и в KPI менеджеров.
    if (OPERATION_SERVICES.includes(rest.serviceType as string) && !operationId) {
      const op = await prisma.operation.create({
        data: {
          patientId,
          dateOp: (operationDate as Date) ?? (rest.date as Date) ?? new Date(),
          opType: (rest.opType as string) ?? null,
          cost: (operationCost as number) ?? 0,
          anesthesiaCost: 0,
          surgeon: (rest.doctor as string) ?? null,
          zapis: (rest.zapis as string) ?? null,
          manager: (manager as string) ?? null,
          contractSigned: false,
          note: 'Создано из Кассы',
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
