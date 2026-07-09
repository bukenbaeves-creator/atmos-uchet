// Вычисляемые поля операции (раздел 8 ТЗ). Не хранятся в БД — считаются здесь.
import { Prisma } from '@prisma/client';

type Num = number | Prisma.Decimal | null | undefined;
const n = (v: Num): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v));
// Округление до копеек: гасит накопленную погрешность float при сложении сумм.
export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
// Порог сравнения баланса с нулём (полкопейки) — чтобы 0.000001 не считался долгом.
const CENT = 0.005;

export interface PaymentLike {
  amount: Num;
  deletedAt?: Date | null;
  direction?: string | null; // 'payment' | 'refund' — возврат вычитается
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
  const totalDue = round2(n(op.cost) + n(op.anesthesiaCost));
  // Оплачено = платежи минус возвраты (refund вычитается)
  const paid = round2(
    (op.payments ?? [])
      .filter((p) => !p.deletedAt)
      .reduce((sum, p) => sum + (p.direction === 'refund' ? -n(p.amount) : n(p.amount)), 0),
  );
  const balance = round2(totalDue - paid);
  return {
    totalDue,
    paid,
    balance,
    fullyPaid: balance <= CENT,
    month: op.dateOp ? new Date(op.dateOp).getMonth() + 1 : null,
  };
}
