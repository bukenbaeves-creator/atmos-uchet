import type { ReactNode } from 'react';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  align?: 'right' | 'center';
}

export function Table<T extends { id: number }>({
  columns,
  rows,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
}) {
  const alignCls = (a?: 'right' | 'center') =>
    a === 'right' ? 'text-right tabular-nums' : a === 'center' ? 'text-center' : 'text-left';

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
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`transition-colors even:bg-slate-50/40 ${
                onRowClick ? 'cursor-pointer hover:bg-brand-50/60' : 'hover:bg-slate-100/60'
              }`}
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
