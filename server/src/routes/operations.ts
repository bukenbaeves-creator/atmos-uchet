import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { assertDictionaryValue } from '../services/dictionary.service.js';
import { computeOperation } from '../services/compute.js';
import { resolvePatient } from '../services/patient-resolve.service.js';
import { patientInputSchema, requiredDate, requiredString, optionalString, moneyAmount } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';

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
});

const router = makeCrudRouter({
  entity: 'operation',
  model: prisma.operation,
  roles: ['operator', 'admin'], // содержит стоимость операции — скрыто от медсестры
  createSchema: schema,
  include: {
    patient: true,
    consultation: true,
    payments: { where: { deletedAt: null } },
  },
  orderBy: { dateOp: 'desc' },
  buildWhere: (q) => {
    const where: Record<string, unknown> = {};
    if (typeof q.opType === 'string' && q.opType) where.opType = q.opType;
    if (typeof q.surgeon === 'string' && q.surgeon) where.surgeon = q.surgeon;
    if (typeof q.patientId === 'string' && q.patientId) where.patientId = Number(q.patientId);
    if (q.contractSigned === 'true') where.contractSigned = true;
    if (q.contractSigned === 'false') where.contractSigned = false;
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
    const { patient, ...rest } = data as Record<string, unknown> & { patient: never };
    const patientId = await resolvePatient(patient, req, ctx.tx);
    return { ...rest, patientId };
  },
});

export default router;
