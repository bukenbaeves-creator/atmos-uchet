import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../lib/http.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { computeOperation } from '../services/compute.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { patientInputSchema, requiredDate, requiredString, optionalString, moneyAmount } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { dateRange, eqStr } from '../lib/filters.js';

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
  contractSigned: z.coerce.boolean().default(false),
  note: optionalString(),
  // Разрешить создать операцию, даже если у пациента уже есть такая же на эту дату
  // (галочка в форме). Не пишется в БД — только гейт для проверки на дубль.
  confirmDuplicate: z.coerce.boolean().optional(),
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
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
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
  transform: (row) => ({ ...row, ...computeOperation(row as never) }),
  prepareData: async (data, req, ctx) => {
    const { patient, confirmDuplicate, ...rest } = data as Record<string, unknown> & { patient: never };
    const patientId = await resolvePatient(patient, req, ctx.tx);
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
});

export default router;
