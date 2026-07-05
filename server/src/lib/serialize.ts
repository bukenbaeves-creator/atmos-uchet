import { Prisma } from '@prisma/client';

// Prisma отдаёт Decimal как объект; для JSON-ответа приводим к number,
// а Date оставляем как ISO-строку (JSON.stringify делает это сам).
export function serialize<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Prisma.Decimal) return value.toNumber() as unknown as T;
  // Date -> ISO-строка: безопасно для JSON-полей аудита и одинаково на сети
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => serialize(v)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialize(v);
    }
    return out as T;
  }
  return value;
}
