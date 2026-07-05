// Вычисляемые поля операции (раздел 8 ТЗ). Не хранятся в БД — считаются здесь.
import { Prisma } from '@prisma/client';

type Num = number | Prisma.Decimal | null | undefined;
const n = (v: Num): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v));

export interface PaymentLike {
  amount: Num;
  deletedAt?: Date | null;
}

export interface OperationLike {
  cost: Num;
  anesthesiaCost: Num;
  dateOp?: Date | null;
  payments?: PaymentLike[];
}

export interface OperationComputed {
  totalDue: number;
  paid: number;
  balance: number;
  fullyPaid: boolean;
  month: number | null;
}

export function computeOperation(op: OperationLike): OperationComputed {
  const totalDue = n(op.cost) + n(op.anesthesiaCost);
  const paid = (op.payments ?? [])
    .filter((p) => !p.deletedAt)
    .reduce((sum, p) => sum + n(p.amount), 0);
  const balance = totalDue - paid;
  return {
    totalDue,
    paid,
    balance,
    fullyPaid: balance <= 0,
    month: op.dateOp ? new Date(op.dateOp).getMonth() + 1 : null,
  };
}
