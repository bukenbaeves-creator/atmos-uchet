import { Prisma } from '@prisma/client';
import type { PrismaClientOrTx } from '../lib/prisma.js';

// Текущий учётный остаток позиции = сумма остатков её партий.
export async function currentStock(nomenclatureId: number, tx: PrismaClientOrTx): Promise<Prisma.Decimal> {
  const batches = await tx.batch.findMany({ where: { nomenclatureId, qtyRemaining: { gt: 0 } } });
  return batches.reduce((s, b) => s.add(b.qtyRemaining), new Prisma.Decimal(0));
}

// Снимает недостачу с партий позиции (FEFO для позиций со сроком, иначе FIFO),
// уменьшая qtyRemaining. Возвращает себестоимость снятого количества и непокрытый
// остаток (shortfall) — при корректной ревизии он всегда 0. Вызывать ТОЛЬКО в транзакции.
export async function reduceStock(
  nomenclatureId: number,
  qty: Prisma.Decimal,
  tx: PrismaClientOrTx,
): Promise<{ cost: Prisma.Decimal; shortfall: Prisma.Decimal }> {
  const nom = await tx.nomenclature.findUnique({ where: { id: nomenclatureId } });
  if (!nom) throw new Error('Позиция номенклатуры не найдена');
  const batches = await tx.batch.findMany({
    where: { nomenclatureId, qtyRemaining: { gt: 0 } },
    orderBy: nom.isExpiryTracked ? [{ expiryDate: 'asc' }, { receivedAt: 'asc' }] : [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  let remaining = qty;
  let cost = new Prisma.Decimal(0);
  for (const b of batches) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(b.qtyRemaining, remaining);
    cost = cost.add(take.mul(b.purchasePrice));
    remaining = remaining.sub(take);
    await tx.batch.update({ where: { id: b.id }, data: { qtyRemaining: b.qtyRemaining.sub(take) } });
  }
  return { cost, shortfall: remaining };
}
