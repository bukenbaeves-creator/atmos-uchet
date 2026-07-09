import { Prisma } from '@prisma/client';
import type { PrismaClientOrTx } from '../lib/prisma.js';

export interface CostingResult {
  costTotal: Prisma.Decimal; // зафиксированная себестоимость списания
  isShortage: boolean; // остатка не хватило (списано «в минус»)
  allocations: { batchId: number; qty: Prisma.Decimal; cost: Prisma.Decimal }[];
}

// Списывает количество qty по позиции: подбирает партии и считает себестоимость.
// FEFO для позиций со сроком годности (по ближайшему сроку), иначе FIFO (по дате
// прихода). Уменьшает qtyRemaining партий. Нехватка не блокирует — помечается
// isShortage, непокрытое количество остаётся без стоимости до корректировки прихода.
// ВЫЗЫВАТЬ ТОЛЬКО ВНУТРИ ТРАНЗАКЦИИ (tx), чтобы остатки не рассинхронизировались.
export async function allocateWriteoff(
  nomenclatureId: number,
  qty: Prisma.Decimal,
  tx: PrismaClientOrTx,
): Promise<CostingResult> {
  const nom = await tx.nomenclature.findUnique({ where: { id: nomenclatureId } });
  if (!nom) throw new Error('Позиция номенклатуры не найдена');

  // Партии с положительным остатком; порядок — FEFO или FIFO.
  const batches = await tx.batch.findMany({
    where: { nomenclatureId, qtyRemaining: { gt: 0 } },
    orderBy: nom.isExpiryTracked
      ? [{ expiryDate: 'asc' }, { receivedAt: 'asc' }]
      : [{ receivedAt: 'asc' }, { id: 'asc' }],
  });

  const allocations: CostingResult['allocations'] = [];
  let remaining = qty;
  let costTotal = new Prisma.Decimal(0);

  for (const b of batches) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(b.qtyRemaining, remaining);
    const cost = take.mul(b.purchasePrice);
    allocations.push({ batchId: b.id, qty: take, cost });
    costTotal = costTotal.add(cost);
    remaining = remaining.sub(take);
    await tx.batch.update({
      where: { id: b.id },
      data: { qtyRemaining: b.qtyRemaining.sub(take) },
    });
  }

  return {
    costTotal,
    isShortage: remaining.gt(0), // осталось непокрытое количество
    allocations,
  };
}
