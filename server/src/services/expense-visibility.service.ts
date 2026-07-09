// Скрытие стоимостной информации от всех, кроме администратора.
// ПРАВИЛО МОДУЛЯ: цена закупа, себестоимость и суммы видны ТОЛЬКО роли admin.
// Усечение выполняется на сервере (в ответах API), а не в интерфейсе, — иначе
// цену можно было бы увидеть через инструменты разработчика браузера.

// Поля, которые нужно убрать для не-админов (на любом уровне вложенности).
const COST_FIELDS = new Set(['purchasePrice', 'costTotal', 'cost', 'sum', 'totalCost', 'avgPrice']);

type Role = string | undefined;

// Возвращает копию значения без стоимостных полей (для роли ≠ admin).
// Для admin возвращает данные как есть.
export function stripCost<T>(value: T, role: Role): T {
  if (role === 'admin') return value;
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(strip);
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (COST_FIELDS.has(k)) continue; // цену/сумму не отдаём
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}
