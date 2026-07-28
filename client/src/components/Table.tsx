import type { ReactNode } from 'react';

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

const inputCls = 'w-full rounded border border-slate-200 bg-white px-1.5 py-1 text-xs font-normal normal-case text-slate-700 focus:border-brand-400 focus:outline-none';

// Один фильтр в шапке столбца. Читает значение из filters[param], пишет через onFilter.
function FilterControl({
  filter,
  filters,
  onFilter,
}: {
  filter: ColumnFilter;
  filters: Record<string, unknown>;
  onFilter: (key: string, value: unknown) => void;
}) {
  if (filter.kind === 'text') {
    return (
      <input
        className={inputCls}
        placeholder={filter.placeholder ?? 'фильтр…'}
        value={(filters[filter.param] as string) ?? ''}
        onChange={(e) => onFilter(filter.param, e.target.value)}
      />
    );
  }
  if (filter.kind === 'select') {
    return (
      <select className={inputCls} value={(filters[filter.param] as string) ?? ''} onChange={(e) => onFilter(filter.param, e.target.value)}>
        <option value="">все</option>
        {filter.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  // dateRange
  return (
    <div className="flex flex-col gap-1">
      <input
        type="date"
        className={inputCls}
        title="с"
        value={(filters[filter.paramFrom] as string) ?? ''}
        onChange={(e) => onFilter(filter.paramFrom, e.target.value)}
      />
      <input
        type="date"
        className={inputCls}
        title="по"
        value={(filters[filter.paramTo] as string) ?? ''}
        onChange={(e) => onFilter(filter.paramTo, e.target.value)}
      />
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

  const hasFilters = !!onFilter && columns.some((c) => c.filter);

  return (
    <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200/70">
      <table className="min-w-full border-separate border-spacing-0 bg-white text-sm">
        <thead className="sticky top-0 z-10">
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                className={`border-b border-slate-200 bg-slate-50/95 px-3.5 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 backdrop-blur ${alignCls(
                  c.align,
                )}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
          {hasFilters && (
            <tr>
              {columns.map((c, i) => (
                <th key={i} className="border-b border-slate-200 bg-slate-50/95 px-2 py-1.5 align-top backdrop-blur">
                  {c.filter && filters ? <FilterControl filter={c.filter} filters={filters} onFilter={onFilter!} /> : null}
                </th>
              ))}
            </tr>
          )}
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
