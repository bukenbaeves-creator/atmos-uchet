import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Клиент Prisma ЛИБО транзакционный клиент ($transaction) — для функций,
// которые должны уметь работать внутри одной транзакции.
export type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;
