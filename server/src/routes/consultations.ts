import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { patientInputSchema, requiredString, requiredDate, optionalDate } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { writeAudit } from '../services/audit.service.js';

const TERMINAL_METHOD = 'Через терминал';

const schema = z
  .object({
    patient: patientInputSchema,
    dateZapis: optionalDate,
    dateKons: requiredDate('Необходимо указать дату консультации'),
    time: z.string().optional().nullable(),
    vid: requiredString('Необходимо указать вид консультации'),
    interestOperation: requiredString('Необходимо указать интересующую операцию'),
    doctor: requiredString('Необходимо указать врача'),
    manager: requiredString('Необходимо указать менеджера'),
    // Итог (стадия воронки) заполняется позже админом — необязателен при создании.
    stage: z.string().optional().nullable(),
    resultDetails: z.string().optional().nullable(),
    // Оплата — необязательна (консультация может быть бесплатной)
    amount: z.coerce.number().nonnegative().optional().nullable(),
    payDate: optionalDate,
    payMethod: z.string().optional().nullable(),
    terminal: z.string().optional().nullable(),
    payNote: z.string().optional().nullable(),
  })
  // Если указана сумма — нужен способ оплаты
  .refine((d) => !d.amount || d.amount <= 0 || !!d.payMethod, {
    message: 'Укажите способ оплаты консультации',
    path: ['payMethod'],
  })
  // Терминал обязателен при оплате «Через терминал»
  .refine((d) => d.payMethod !== TERMINAL_METHOD || !!d.terminal, {
    message: 'Необходимо указать терминал',
    path: ['terminal'],
  });

const router = makeCrudRouter({
  entity: 'consultation',
  model: prisma.consultation,
  createSchema: schema,
  include: { patient: true },
  orderBy: { dateKons: 'desc' },
  buildWhere: (q) => {
    const where: Record<string, unknown> = {};
    if (typeof q.stage === 'string' && q.stage) where.stage = q.stage;
    if (typeof q.patientId === 'string' && q.patientId) where.patientId = Number(q.patientId);
    return where;
  },
  search: (t) => ({ OR: [...patientSearchOR(t, true), { stage: { contains: t, mode: 'insensitive' } }] }),
  validate: async (d) => {
    await assertDictionaryValue('consultation_stage', d.stage as string | null);
    await assertDictionaryValue('vid', d.vid as string | null);
    await assertDictionaryValue('op_type', d.interestOperation as string | null);
    await assertDictionaryValue('doctor', d.doctor as string | null);
    await assertDictionaryValue('manager', d.manager as string | null);
    await assertDictionaryValue('pay_method', d.payMethod as string | null);
    await assertDictionaryValue('terminal', d.terminal as string | null);
  },
  prepareData: async (data, req) => {
    const { patient, ...rest } = data as Record<string, unknown> & { patient: never };
    const patientId = await resolvePatient(patient, req);
    return { ...rest, patientId };
  },
  // Указана стоимость консультации -> платёж автоматически попадает в «Кассу»
  afterCreate: async (created, req) => {
    const c = created as Record<string, unknown>;
    const amount = Number(c.amount ?? 0);
    if (amount > 0) {
      const pay = await prisma.payment.create({
        data: {
          patientId: c.patientId as number,
          date: (c.payDate as Date) ?? (c.dateKons as Date) ?? new Date(),
          serviceType: 'Консультация',
          amount,
          payMethod: (c.payMethod as string) ?? null,
          terminal: (c.terminal as string) ?? null,
          payNote: (c.payNote as string) ?? 'Оплата консультации',
          doctor: (c.doctor as string) ?? null,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        },
      });
      await writeAudit(req, { action: 'create', entity: 'payment', entityId: pay.id, after: pay });
    }
  },
});

export default router;
