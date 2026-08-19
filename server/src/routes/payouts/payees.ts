import { z } from 'zod';
import { PayeeKind, PayeeLegalForm } from '@prisma/client';
import { makeCrudRouter } from '../../crud.js';
import { prisma } from '../../lib/prisma.js';
import { requiredString, optionalString } from '../../schemas.js';

// Получатели выплат (врачи/анестезиологи/ассистенты). Только администратор.
// У модели есть deletedAt — используем фабрику (soft-delete, аудит, RBAC внутри).
const schema = z.object({
  fio: requiredString('Необходимо указать ФИО получателя', 200),
  dictionaryLabel: optionalString(200), // точное значение из справочника doctor / Operation.surgeon
  kind: z.nativeEnum(PayeeKind),
  legalForm: z.nativeEnum(PayeeLegalForm).default('individual'),
  iin: optionalString(20),
  bankAccount: optionalString(100),
  active: z.coerce.boolean().default(true),
  userId: z.coerce.number().int().positive().optional().nullable(),
  note: optionalString(),
});

const router = makeCrudRouter({
  // entity используется и как метка аудита, и как ключ делегата Prisma (tx[entity]),
  // поэтому именно 'doctorPayee' (имя делегата), а не 'doctor_payee'.
  entity: 'doctorPayee',
  model: prisma.doctorPayee,
  roles: ['admin'],
  createSchema: schema,
  orderBy: { fio: 'asc' },
  buildWhere: (q) => {
    const where: Record<string, unknown> = {};
    if (typeof q.kind === 'string' && q.kind) where.kind = q.kind;
    if (q.active === 'true') where.active = true;
    if (q.active === 'false') where.active = false;
    return where;
  },
  search: (t) => ({
    OR: [
      { fio: { contains: t, mode: 'insensitive' } },
      { dictionaryLabel: { contains: t, mode: 'insensitive' } },
    ],
  }),
});

export default router;
