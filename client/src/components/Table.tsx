import { useEffect, useRef, useState, type ReactNode } from 'react';

// Фильтр столбца (серверный: значение уходит в query-параметр с именем param).
export type ColumnFilter =
  | { kind: 'text'; param: string; placeholder?: string }
  | { kind: 'select'; param: string; options: { value: string; label: string }[] }
  | { kind: 'dateRange'; paramFrom: string; paramTo: string };

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'right' | 'center';
  filter?: ColumnFilter;
}

const inputCls = 'w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs font-normal normal-case text-slate-700 focus:border-brand-400 focus:outline-none';

function isFilterActive(f: ColumnFilter, filters: Record<string, unknown>): boolean {
  if (f.kind === 'dateRange') return !!filters[f.paramFrom] || !!filters[f.paramTo];
  return !!filters[f.param];
}

function clearFilter(f: ColumnFilter, onFilter: (k: string, v: unknown) => void) {
  if (f.kind === 'dateRange') {
    onFilter(f.paramFrom, '');
    onFilter(f.paramTo, '');
  } else {
    onFilter(f.param, '');
  }
}

// Содержимое выпадающего фильтра (текст / список / диапазон дат).
function FilterBody({ filter, filters, onFilter }: { filter: ColumnFilter; filters: Record<string, unknown>; onFilter: (k: string, v: unknown) => void }) {
  if (filter.kind === 'text') {
    return (
      <input
        autoFocus
        className={inputCls}
        placeholder={filter.placeholder ?? 'фильтр…'}
        value={(filters[filter.param] as string) ?? ''}
        onChange={(e) => onFilter(filter.param, e.target.value)}
      />
    );
  }
  if (filter.kind === 'select') {
    return (
      <select autoFocus className={inputCls} value={(filters[filter.param] as string) ?? ''} onChange={(e) => onFilter(filter.param, e.target.value)}>
        <option value="">все</option>
        {filter.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] text-slate-400">
        с
        <input type="date" className={inputCls} value={(filters[filter.paramFrom] as string) ?? ''} onChange={(e) => onFilter(filter.paramFrom, e.target.value)} />
      </label>
      <label className="block text-[11px] text-slate-400">
        по
        <input type="date" className={inputCls} value={(filters[filter.paramTo] as string) ?? ''} onChange={(e) => onFilter(filter.paramTo, e.target.value)} />
      </label>
    </div>
  );
}

export function Table<T extends { id: number }>({
  columns,
  rows,
  onRowClick,
  filters,
  onFilter,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  filters?: Record<string, unknown>;
  onFilter?: (key: string, value: unknown) => void;
  rowClassName?: (row: T) => string;
}) {
  const alignCls = (a?: 'right' | 'center') =>
    a === 'right' ? 'text-right tabular-nums' : a === 'center' ? 'text-center' : 'text-left';

  const [openCol, setOpenCol] = useState<number | null>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (openCol === null) return;
    const onDown = (e: MouseEvent) => {
      if (headRef.current && !headRef.current.contains(e.target as Node)) setOpenCol(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openCol]);

  const filterable = !!onFilter && !!filters;

  return (
    // Ограниченная высота + прокрутка: шапка закрепляется при вертикальном скролле.
    <div className="max-h-[calc(100vh-13rem)] overflow-auto rounded-2xl ring-1 ring-slate-200/70">
      <table className="min-w-full border-separate border-spacing-0 bg-white text-sm">
        <thead ref={headRef} className="sticky top-0 z-20">
          <tr>
            {columns.map((c, i) => {
              const active = filterable && c.filter ? isFilterActive(c.filter, filters!) : false;
              const clickable = filterable && !!c.filter;
              const anchorRight = i > columns.length / 2;
              return (
                <th
                  key={i}
                  className={`relative border-b border-slate-200 bg-slate-50/95 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide backdrop-blur ${alignCls(
                    c.align,
                  )} ${active ? 'text-brand-600' : 'text-slate-500'}`}
                >
                  {clickable ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-brand-600"
                      title="Нажмите, чтобы отфильтровать"
                      onClick={() => setOpenCol(openCol === i ? null : i)}
                    >
                      <span>{c.header}</span>
                      <svg viewBox="0 0 16 16" width="11" height="11" className={active ? 'fill-brand-600' : 'fill-slate-400'}>
                        <path d="M1.5 3h13l-5 6v4l-3 1.5V9L1.5 3z" />
                      </svg>
                    </button>
                  ) : (
                    c.header
                  )}
                  {openCol === i && clickable && c.filter && (
                    <div
                      className={`absolute top-full z-30 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-2 text-left shadow-lg ${anchorRight ? 'right-0' : 'left-0'}`}
                    >
                      <FilterBody filter={c.filter} filters={filters!} onFilter={onFilter!} />
                      {active && (
                        <button
                          type="button"
                          className="mt-2 text-xs text-slate-500 hover:text-rose-600"
                          onClick={() => {
                            clearFilter(c.filter!, onFilter!);
                            setOpenCol(null);
                          }}
                        >
                          Сбросить фильтр
                        </button>
                      )}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`transition-colors even:bg-slate-50/40 ${
                onRowClick ? 'cursor-pointer hover:bg-brand-50/60' : 'hover:bg-slate-100/60'
              } ${rowClassName?.(row) ?? ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c, i) => (
                <td
                  key={i}
                  className={`border-b border-slate-100 px-3.5 py-2.5 align-middle ${alignCls(c.align)} ${c.className ?? ''}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
