import type { Request } from 'express';
import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma, type PrismaClientOrTx } from '../lib/prisma.js';
import { assertDictionaryValue, ensureDictionaryValue } from '../services/dictionary.service.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { patientInputSchema, requiredString, optionalString, requiredDate, optionalDate, moneyAmount } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { writeAudit } from '../services/audit.service.js';
import { asyncHandler, forbidden, notFound } from '../lib/http.js';
import { serialize } from '../lib/serialize.js';

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
    stage: optionalString(200),
    resultDetails: optionalString(),
    // Оплата — необязательна (консультация может быть бесплатной)
    amount: moneyAmount().optional().nullable(),
    payDate: optionalDate,
    payMethod: z.string().optional().nullable(),
    terminal: z.string().optional().nullable(),
    payNote: optionalString(),
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

// Синхронизация оплаты консультации со связанным платежом (без дублей).
// amount>0 — создаём/обновляем связанный платёж; пусто/0 — мягко удаляем.
async function syncConsultationPayment(c: Record<string, unknown>, req: Request, tx: PrismaClientOrTx) {
  const consultationId = c.id as number;
  const amount = Number(c.amount ?? 0);
  const existing = await tx.payment.findFirst({
    where: { consultationId, direction: 'payment', deletedAt: null },
  });
  if (amount > 0) {
    const payData = {
      patientId: c.patientId as number,
      date: (c.payDate as Date) ?? (c.dateKons as Date) ?? new Date(),
      serviceType: 'Консультация',
      opType: (c.interestOperation as string) ?? null,
      amount,
      payMethod: (c.payMethod as string) ?? null,
      terminal: (c.terminal as string) ?? null,
      payNote: (c.payNote as string) ?? 'Оплата консультации',
      doctor: (c.doctor as string) ?? null,
    };
    if (existing) {
      const upd = await tx.payment.update({ where: { id: existing.id }, data: { ...payData, updatedBy: req.user!.id } });
      await writeAudit(req, { action: 'update', entity: 'payment', entityId: existing.id, before: existing, after: upd }, tx);
    } else {
      const pay = await tx.payment.create({
        data: { ...payData, consultationId, createdBy: req.user!.id, updatedBy: req.user!.id },
      });
      await writeAudit(req, { action: 'create', entity: 'payment', entityId: pay.id, after: pay }, tx);
    }
  } else if (existing) {
    // Сумму убрали — платёж больше не актуален
    const del = await tx.payment.update({ where: { id: existing.id }, data: { deletedAt: new Date(), deletedBy: req.user!.id } });
    await writeAudit(req, { action: 'delete', entity: 'payment', entityId: existing.id, before: existing, after: del }, tx);
  }
}

// Итог заполнен — консультация «закрыта»: оператор её больше не правит (только админ).
function consultationCanEdit(user: { id: number; role: string }, record: Record<string, unknown>): boolean {
  if (user.role === 'admin') return true;
  if (record.createdBy !== user.id) return false;
  const stage = record.stage as string | null;
  return !stage || !String(stage).trim();
}

const router = makeCrudRouter({
  entity: 'consultation',
  model: prisma.consultation,
  roles: ['operator', 'admin'], // содержит суммы оплат — скрыто от медсестры
  createSchema: schema,
  canEdit: consultationCanEdit,
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
    // stage не проверяем: свой итог авто-добавляется в справочник (prepareData)
    await assertDictionaryValue('vid', d.vid as string | null);
    await assertDictionaryValue('op_type', d.interestOperation as string | null);
    await assertDictionaryValue('doctor', d.doctor as string | null);
    await assertDictionaryValue('manager', d.manager as string | null);
    await assertDictionaryValue('pay_method', d.payMethod as string | null);
    await assertDictionaryValue('terminal', d.terminal as string | null);
  },
  prepareData: async (data, req, ctx) => {
    const { patient, ...rest } = data as Record<string, unknown> & { patient: never };
    const patientId = await resolvePatient(patient, req, ctx.tx);
    // Свой итог (введён вручную) — добавляем в справочник «Стадии итога»
    rest.stage = typeof rest.stage === 'string' && rest.stage.trim() ? rest.stage.trim() : null;
    await ensureDictionaryValue('consultation_stage', rest.stage as string | null, req, ctx.tx);
    return { ...rest, patientId };
  },
  // Указана стоимость консультации -> связанный платёж в «Кассе».
  afterCreate: async (created, req, tx) => {
    await syncConsultationPayment(created as Record<string, unknown>, req, tx);
  },
  // Поздняя оплата/корректировка: синхронизируем платёж ТОЛЬКО при изменении суммы
  // (иначе не трогаем — защита legacy-записей без связи consultationId).
  afterUpdate: async (updated, before, req, tx) => {
    const a = Number((updated as Record<string, unknown>).amount ?? 0);
    const b = Number((before as Record<string, unknown>).amount ?? 0);
    if (a !== b) await syncConsultationPayment(updated as Record<string, unknown>, req, tx);
  },
});

const resultSchema = z.object({
  stage: optionalString(200),
  resultDetails: optionalString(),
});

// Итог консультации отдельным действием. Оператор может проставить/менять итог
// своей консультации, пока итог ещё не заполнен (запись не «закрыта»); как только
// итог проставлен — правит только админ.
router.patch(
  '/:id/result',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.consultation.findFirst({
      where: { id, deletedAt: null },
      include: { patient: true },
    });
    if (!existing) throw notFound();
    if (!consultationCanEdit(req.user!, existing)) {
      throw forbidden('Итог уже заполнен — изменить может только администратор');
    }
    const data = resultSchema.parse(req.body);
    const stageLabel = data.stage?.trim() ? data.stage.trim() : null;
    const updated = await prisma.$transaction(async (tx) => {
      // Свой итог (введён вручную) — добавляем в справочник «Стадии итога»
      await ensureDictionaryValue('consultation_stage', stageLabel, req, tx);
      const row = await tx.consultation.update({
        where: { id },
        data: { stage: stageLabel, resultDetails: data.resultDetails ?? null, updatedBy: req.user!.id },
        include: { patient: true },
      });
      await writeAudit(req, { action: 'update', entity: 'consultation', entityId: id, before: existing, after: row }, tx);
      return row;
    });
    res.json(serialize(updated));
  }),
);

export default router;
