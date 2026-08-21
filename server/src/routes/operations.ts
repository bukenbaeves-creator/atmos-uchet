import { z } from 'zod';
import { PayeeKind } from '@prisma/client';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import type { PrismaClientOrTx } from '../lib/prisma.js';
import { ApiError, asyncHandler, notFound, forbidden, badRequest } from '../lib/http.js';
import { serialize } from '../lib/serialize.js';
import { writeAudit } from '../services/audit.service.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { computeOperation } from '../services/compute.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { patientInputSchema, requiredDate, requiredString, optionalString, moneyAmount } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { dateRange, eqStr } from '../lib/filters.js';
import { recalcOperation } from '../services/payout-engine.service.js';

// Один участник операции (Э1-3). Используется и в схеме операции, и в хуках синхронизации.
const participantSchema = z.object({
  payeeId: z.coerce.number().int().positive(),
  role: z.nativeEnum(PayeeKind),
  sharePct: z.coerce.number().min(0).max(100).optional().nullable(),
  anesthesiaType: optionalString(100),
  shiftDay: z.coerce.boolean().default(false),
  shiftNight: z.coerce.boolean().default(false),
});
type ParticipantInput = z.infer<typeof participantSchema>;

// Синхронизация участников операции с БД (Э1-3). Вызывается из afterCreate/afterUpdate
// в той же транзакции. Источник правды строковых полей — Operation.surgeon (из формы),
// участники лишь дополняют. Проверки:
//  • несколько хирургов → сумма sharePct = 100;
//  • у хирурга dictionaryLabel задана и ≠ Operation.surgeon → отклонить (два источника правды);
//  • dictionaryLabel пустая → сохранить (позже операция попадёт в «Сигналы» дашборда).
async function syncParticipants(
  tx: PrismaClientOrTx,
  operationId: number,
  surgeon: string | null,
  participants: ParticipantInput[],
  userId: number,
) {
  const surgeons = participants.filter((p) => p.role === 'surgeon');
  if (surgeons.length > 1) {
    const sum = surgeons.reduce((s, p) => s + (p.sharePct ?? 0), 0);
    if (Math.abs(sum - 100) > 0.01) {
      throw badRequest(`Если хирургов несколько, сумма их долей должна быть 100%. Сейчас ${sum}%.`);
    }
  }
  if (surgeons.length) {
    const payees = await tx.doctorPayee.findMany({
      where: { id: { in: surgeons.map((s) => s.payeeId) } },
      select: { id: true, fio: true, dictionaryLabel: true },
    });
    for (const s of surgeons) {
      const payee = payees.find((p) => p.id === s.payeeId);
      if (!payee) throw badRequest('Указан несуществующий получатель-хирург.');
      const label = payee.dictionaryLabel?.trim();
      if (label && surgeon && label !== surgeon.trim()) {
        throw badRequest(
          `Хирург-участник «${payee.fio}» привязан к справочнику как «${payee.dictionaryLabel}», но в поле «Врач» указано «${surgeon}». Приведите их в соответствие.`,
        );
      }
    }
  }
  // Полная замена набора участников операции (идемпотентно при повторном сохранении).
  await tx.operationParticipant.deleteMany({ where: { operationId } });
  if (participants.length) {
    await tx.operationParticipant.createMany({
      data: participants.map((p) => ({
        operationId,
        payeeId: p.payeeId,
        role: p.role,
        sharePct: p.sharePct ?? null,
        anesthesiaType: p.anesthesiaType ?? null,
        shiftDay: p.shiftDay,
        shiftNight: p.shiftNight,
        createdBy: userId,
      })),
      skipDuplicates: true,
    });
  }
}

const schema = z.object({
  patient: patientInputSchema,
  consultationId: z.coerce.number().int().positive().optional().nullable(),
  zapis: requiredString('Необходимо указать запись'),
  manager: requiredString('Необходимо указать менеджера'),
  dateOp: requiredDate('Необходимо указать дату операции'),
  opType: requiredString('Необходимо указать тип операции'),
  surgeon: requiredString('Необходимо указать врача'),
  anesthesiologist: optionalString(200),
  cost: moneyAmount(),
  anesthesiaCost: moneyAmount().default(0),
  implantsCost: moneyAmount().default(0),
  assistantCost: moneyAmount().default(0),
  contractSigned: z.coerce.boolean().default(false),
  note: optionalString(),
  // Участники операции (Э1-3). Хирург создаётся тем же контролом формы, что и поле
  // surgeon (единый источник правды — см. проверку согласованности ниже).
  participants: z.array(participantSchema).optional(),
  // Разрешить создать операцию, даже если у пациента уже есть такая же на эту дату
  // (галочка в форме). Не пишется в БД — только гейт для проверки на дубль.
  confirmDuplicate: z.coerce.boolean().optional(),
}).refine((d) => d.patient?.birthDate != null, {
  // Для операции дата рождения пациента обязательна (в отличие от прочих форм).
  message: 'Необходимо указать дату рождения пациента',
  path: ['patient', 'birthDate'],
});

// Оператор правит свою операцию до «дата операции + 1 день» включительно
// (перенос даты, поздняя оплата вносится платежом в Кассе). Админ — всегда.
function operationCanEdit(user: { id: number; role: string }, record: Record<string, unknown>): boolean {
  if (user.role === 'admin') return true;
  if (record.createdBy !== user.id) return false;
  const dateOp = record.dateOp as Date | null;
  if (!dateOp) return true;
  const d = new Date(dateOp);
  const deadline = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); // конец «дня операции + 1»
  const now = new Date();
  // Сегодня — тоже в UTC (даты хранятся как UTC-полночь), иначе на non-UTC сервере граница «съедет».
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return today <= deadline;
}

const router = makeCrudRouter({
  entity: 'operation',
  model: prisma.operation,
  roles: ['operator', 'admin'], // содержит стоимость операции — скрыто от медсестры
  createSchema: schema,
  canEdit: operationCanEdit,
  include: {
    patient: true,
    consultation: true,
    payments: { where: { deletedAt: null } },
    // Журнал операций видит и оператор: отдаём только состав участников БЕЗ платёжных
    // полей (sharePct — деление гонорара — конфиденциально, только в модуле выплат).
    participants: {
      select: {
        id: true,
        payeeId: true,
        role: true,
        anesthesiaType: true,
        shiftDay: true,
        shiftNight: true,
        payee: { select: { id: true, fio: true, dictionaryLabel: true, kind: true } },
      },
    },
  },
  orderBy: { dateOp: 'desc' },
  buildWhere: (q) => {
    const where: Record<string, unknown> = {};
    if (eqStr(q.opType)) where.opType = eqStr(q.opType);
    if (eqStr(q.surgeon)) where.surgeon = eqStr(q.surgeon);
    if (eqStr(q.manager)) where.manager = eqStr(q.manager);
    if (typeof q.patientId === 'string' && q.patientId) where.patientId = Number(q.patientId);
    if (q.contractSigned === 'true') where.contractSigned = true;
    if (q.contractSigned === 'false') where.contractSigned = false;
    const d = dateRange(q.dateOpFrom, q.dateOpTo);
    if (d) where.dateOp = d;
    return where;
  },
  search: (t) => ({ OR: [...patientSearchOR(t, true), { opType: { contains: t, mode: 'insensitive' } }] }),
  validate: async (d) => {
    await assertDictionaryValue('op_type', d.opType as string);
    // Терминология единая: врач операции выбирается из общего справочника doctor
    await assertDictionaryValue('doctor', d.surgeon as string | null);
    await assertDictionaryValue('zapis', d.zapis as string | null);
    await assertDictionaryValue('manager', d.manager as string | null);
  },
  transform: (row) => ({ ...row, ...computeOperation(row as unknown as Parameters<typeof computeOperation>[0]) }),
  prepareData: async (data, req, ctx) => {
    // participants — связь, а не скалярное поле операции: убираем из данных записи,
    // сохраняем отдельно в afterCreate/afterUpdate (та же транзакция).
    const { patient, confirmDuplicate, participants: _participants, ...rest } = data as Record<string, unknown> & {
      patient: never;
    };
    const patientId = await resolvePatient(patient, req, ctx.tx);
    // Дату операции обычным PUT НЕ меняем — только через /reschedule (с причиной, для следа).
    if (ctx.mode === 'update') delete (rest as Record<string, unknown>).dateOp;
    // Защита от дубля: при создании — если у пациента уже есть операция того же
    // вида на ту же дату, требуем явного подтверждения «Разрешить дубль».
    if (ctx.mode === 'create' && !confirmDuplicate && rest.dateOp) {
      const day = new Date(rest.dateOp as Date).toISOString().slice(0, 10);
      const range = dateRange(day, day);
      const existing = await ctx.tx.operation.findFirst({
        where: { patientId, opType: rest.opType as string, deletedAt: null, ...(range ? { dateOp: range } : {}) },
      });
      if (existing) {
        throw new ApiError(
          409,
          `У пациента уже есть операция «${rest.opType}» на эту дату. Если это не дубль — отметьте «Разрешить дубль» и сохраните снова.`,
        );
      }
    }
    return { ...rest, patientId };
  },
  // Участников синхронизируем в той же транзакции. Если поле participants в запросе
  // отсутствует (старый клиент) — набор участников не трогаем.
  afterCreate: async (created, req, tx) => {
    if (req.body?.participants !== undefined) {
      const parts = z.array(participantSchema).parse(req.body.participants ?? []);
      await syncParticipants(tx, created.id as number, created.surgeon as string | null, parts, req.user!.id);
    }
    await recalcOperation(created.id as number, tx); // Э2-3: пересчёт начислений
  },
  afterUpdate: async (updated, _before, req, tx) => {
    if (req.body?.participants !== undefined) {
      const parts = z.array(participantSchema).parse(req.body.participants ?? []);
      await syncParticipants(tx, updated.id as number, updated.surgeon as string | null, parts, req.user!.id);
    }
    await recalcOperation(updated.id as number, tx);
  },
  // Мягкое удаление операции → снять свободные начисления (движок сам это делает).
  afterDelete: async (record, _req, tx) => {
    await recalcOperation(record.id as number, tx);
  },
});

// Перенос даты операции с обязательной причиной (оставляет след в OperationReschedule).
// Права как у правки: оператор — свою до «дата+1», админ — всегда.
const rescheduleSchema = z.object({
  newDate: requiredDate('Укажите новую дату операции'),
  reason: requiredString('Укажите причину переноса', 500),
});

router.patch(
  '/:id/reschedule',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const existing = await prisma.operation.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Операция не найдена');
    if (!operationCanEdit(req.user!, existing)) {
      throw forbidden('Перенос недоступен: доступно автору до «дата операции + 1 день» или администратору.');
    }
    const data = rescheduleSchema.parse(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.operationReschedule.create({
        data: {
          operationId: id,
          oldDate: existing.dateOp,
          newDate: data.newDate,
          reason: data.reason,
          createdBy: req.user!.id,
          createdByFio: req.user!.fio ?? null,
        },
      });
      const row = await tx.operation.update({
        where: { id },
        data: { dateOp: data.newDate, updatedBy: req.user!.id },
        include: { patient: true, consultation: true, payments: { where: { deletedAt: null } } },
      });
      await writeAudit(req, { action: 'update', entity: 'operation', entityId: id, before: existing, after: row }, tx);
      return row;
    });
    res.json({ ...serialize(updated), ...computeOperation(updated as unknown as Parameters<typeof computeOperation>[0]) });
  }),
);

// История переносов даты конкретной операции (для модалки).
router.get(
  '/:id/reschedules',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const rows = await prisma.operationReschedule.findMany({ where: { operationId: id }, orderBy: { createdAt: 'desc' } });
    res.json({ items: serialize(rows) });
  }),
);

export default router;
