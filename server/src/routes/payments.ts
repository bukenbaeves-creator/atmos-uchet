import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { badRequest } from '../lib/http.js';
import { assertDictionaryValue, ensureDictionaryValue } from '../services/dictionary.service.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import {
  patientInputSchema,
  requiredDate,
  requiredString,
  optionalString,
  optionalDate,
  moneyAmount,
} from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { PREPAYMENT_SERVICE } from '../constants.js';
import { writeAudit } from '../services/audit.service.js';

// Виды услуг, для которых нужен «вид операции»
const OP_SERVICES = ['Операция', 'Консультация', PREPAYMENT_SERVICE];
// Услуги, за которые платёж относится к операции (её можно создать на лету)
const OPERATION_SERVICES = ['Операция', PREPAYMENT_SERVICE];
const KONS_SERVICE = 'Консультация';
const TERMINAL_METHOD = 'Через терминал';

// Признак «создаётся новая операция»: услуга про операцию и не выбрана существующая
const createsOperation = (d: { serviceType: string; operationId?: number | null }) =>
  OPERATION_SERVICES.includes(d.serviceType) && !d.operationId;

const schema = z
  .object({
    patient: patientInputSchema,
    operationId: z.coerce.number().int().positive().optional().nullable(),
    // Служебные поля для создания операции на лету (не колонки Payment):
    operationCost: moneyAmount().optional().nullable(),
    operationDate: optionalDate,
    manager: z.string().optional().nullable(),
    // Служебные поля для создания консультации на лету (не колонки Payment):
    dateKons: optionalDate,
    vid: z.string().optional().nullable(),
    stage: optionalString(200),
    resultDetails: optionalString(),
    date: requiredDate('Необходимо указать дату платежа'),
    serviceType: requiredString('Необходимо указать вид услуги'),
    opType: z.string().optional().nullable(),
    amount: moneyAmount({ positive: true, msg: 'Необходимо указать сумму больше нуля' }),
    payMethod: requiredString('Необходимо указать способ оплаты'),
    terminal: z.string().optional().nullable(),
    payNote: optionalString(),
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
  .refine((d) => !(createsOperation(d) || d.serviceType === KONS_SERVICE) || !!d.manager, {
    message: 'Необходимо указать менеджера',
    path: ['manager'],
  })
  // Платёж за консультацию создаёт запись консультации — нужны её дата и вид
  .refine((d) => d.serviceType !== KONS_SERVICE || !!d.dateKons, {
    message: 'Необходимо указать дату консультации',
    path: ['dateKons'],
  })
  .refine((d) => d.serviceType !== KONS_SERVICE || !!d.vid, {
    message: 'Необходимо указать вид консультации',
    path: ['vid'],
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
    await assertDictionaryValue('vid', d.vid as string | null);
    // stage не проверяем: свой итог авто-добавляется в справочник (prepareData)
  },
  prepareData: async (data, req, ctx) => {
    const { tx } = ctx;
    // Поля создания операции/консультации — служебные, в Payment не пишем
    const { patient, operationCost, operationDate, manager, dateKons, vid, stage, resultDetails, ...rest } =
      data as Record<string, unknown> & { patient: never };
    const patientId = await resolvePatient(patient, req, tx);
    let operationId = (rest.operationId as number | null) ?? null;

    // K1: если платёж привязывают к существующей операции — она должна существовать,
    // быть не удалённой и принадлежать ТОМУ ЖЕ пациенту (иначе деньги «переедут»
    // на чужой долг). Проверяем и при создании, и при редактировании.
    if (operationId) {
      const op = await tx.operation.findFirst({ where: { id: operationId, deletedAt: null } });
      if (!op) throw badRequest('Операция не найдена');
      if (op.patientId !== patientId) throw badRequest('Операция принадлежит другому пациенту');
    }

    // Платёж за консультацию -> создаём запись во вкладке «Консультации»
    // (симметрично операциям ниже). Только при создании платежа: при редактировании
    // консультация не создаётся повторно и не синхронизируется.
    if (rest.serviceType === KONS_SERVICE && ctx.mode === 'create') {
      const stageLabel = typeof stage === 'string' && stage.trim() ? stage.trim() : null;
      await ensureDictionaryValue('consultation_stage', stageLabel, req, tx);
      const kons = await tx.consultation.create({
        data: {
          patientId,
          dateZapis: (rest.date as Date) ?? new Date(),
          dateKons: (dateKons as Date) ?? null,
          vid: (vid as string) ?? null,
          interestOperation: (rest.opType as string) ?? null,
          doctor: (rest.doctor as string) ?? null,
          manager: (manager as string) ?? null,
          stage: stageLabel,
          resultDetails: (resultDetails as string) ?? null,
          amount: (rest.amount as number) ?? null,
          payDate: (rest.date as Date) ?? null,
          payMethod: (rest.payMethod as string) ?? null,
          terminal: (rest.terminal as string) ?? null,
          payNote: (rest.payNote as string) ?? 'Оплата внесена через Кассу',
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      await writeAudit(req, { action: 'create', entity: 'consultation', entityId: kons.id, after: kons }, tx);
    }

    // Услуга про операцию, но операция не выбрана -> создаём её на лету, полностью
    // заполненную (дата, тип, стоимость, врач, запись, менеджер) — чтобы корректно
    // учитывалась в отчётах и в KPI менеджеров. Только при создании платежа (B6):
    // при редактировании новая операция не плодится.
    if (OPERATION_SERVICES.includes(rest.serviceType as string) && !operationId && ctx.mode === 'create') {
      const op = await tx.operation.create({
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
      await writeAudit(req, { action: 'create', entity: 'operation', entityId: op.id, after: op }, tx);
      operationId = op.id;
    }

    return { ...rest, patientId, operationId };
  },
});

export default router;
