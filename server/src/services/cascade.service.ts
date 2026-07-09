import type { Request } from 'express';
import type { PrismaClientOrTx } from '../lib/prisma.js';
import { writeAudit } from './audit.service.js';

// Мягкое удаление НЕ каскадируется на уровне БД, поэтому делаем это здесь:
// при удалении пациента гасим его консультации/операции/платежи, при удалении
// операции — её платежи. Иначе «осиротевшие» платежи продолжали бы попадать в
// выручку и отчёты. Всё вызывается внутри той же транзакции, что и основное
// удаление.
export async function cascadeSoftDelete(
  entity: string,
  id: number,
  req: Request,
  tx: PrismaClientOrTx,
) {
  const stamp = { deletedAt: new Date(), deletedBy: req.user!.id };

  if (entity === 'patient') {
    await softDeleteChildren(tx.consultation, { patientId: id }, stamp, req, 'consultation', tx);
    await softDeleteChildren(tx.payment, { patientId: id }, stamp, req, 'payment', tx);
    await softDeleteChildren(tx.operation, { patientId: id }, stamp, req, 'operation', tx);
    await softDeleteChildren(tx.expenseWriteoff, { patientId: id }, stamp, req, 'writeoff', tx);
  } else if (entity === 'operation') {
    await softDeleteChildren(tx.payment, { operationId: id }, stamp, req, 'payment', tx);
  }
}

// Симметричное восстановление: при восстановлении пациента/операции возвращаем
// его ранее удалённые связанные записи.
export async function cascadeRestore(entity: string, id: number, req: Request, tx: PrismaClientOrTx) {
  if (entity === 'patient') {
    await restoreChildren(tx.consultation, { patientId: id }, req, 'consultation', tx);
    await restoreChildren(tx.payment, { patientId: id }, req, 'payment', tx);
    await restoreChildren(tx.operation, { patientId: id }, req, 'operation', tx);
    await restoreChildren(tx.expenseWriteoff, { patientId: id }, req, 'writeoff', tx);
  } else if (entity === 'operation') {
    await restoreChildren(tx.payment, { operationId: id }, req, 'payment', tx);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Delegate = any;

async function softDeleteChildren(
  model: Delegate,
  where: Record<string, unknown>,
  stamp: { deletedAt: Date; deletedBy: number },
  req: Request,
  entity: string,
  tx: PrismaClientOrTx,
) {
  const rows = await model.findMany({ where: { ...where, deletedAt: null }, select: { id: true } });
  for (const r of rows as { id: number }[]) {
    const before = await model.findUnique({ where: { id: r.id } });
    const after = await model.update({ where: { id: r.id }, data: stamp });
    await writeAudit(req, { action: 'delete', entity, entityId: r.id, before, after }, tx);
  }
}

async function restoreChildren(
  model: Delegate,
  where: Record<string, unknown>,
  req: Request,
  entity: string,
  tx: PrismaClientOrTx,
) {
  const rows = await model.findMany({ where: { ...where, NOT: { deletedAt: null } }, select: { id: true } });
  for (const r of rows as { id: number }[]) {
    const before = await model.findUnique({ where: { id: r.id } });
    const after = await model.update({ where: { id: r.id }, data: { deletedAt: null, deletedBy: null } });
    await writeAudit(req, { action: 'restore', entity, entityId: r.id, before, after }, tx);
  }
}
