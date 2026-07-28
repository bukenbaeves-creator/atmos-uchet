// Диапазон дат из query (?xFrom=YYYY-MM-DD&xTo=YYYY-MM-DD) → фрагмент Prisma-фильтра.
// Полуоткрытый интервал [from, to+1день): конечный день входит целиком. UTC — как хранятся даты.
export function dateRange(fromStr: unknown, toStr: unknown): { gte?: Date; lt?: Date } | undefined {
  const out: { gte?: Date; lt?: Date } = {};
  if (typeof fromStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromStr)) out.gte = new Date(fromStr + 'T00:00:00.000Z');
  if (typeof toStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
    const d = new Date(toStr + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + 1);
    out.lt = d;
  }
  return out.gte || out.lt ? out : undefined;
}

// Равенство по строковому query-параметру (пусто → не фильтруем).
export function eqStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
