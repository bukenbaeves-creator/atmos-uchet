import { useMemo, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';

// Переиспользуемая таблица модуля выплат (Э4-1, ТЗ 11А.2): двухуровневая шапка,
// закрепление шапки/первых колонок/итоговой строки, сортировка по клику, поиск,
// переключатель плотности, форматирование (0 → «—», отрицательные красным,
// моноширинные цифры), цветная полоса-признак слева. Движок — @tanstack/react-table.

export interface DataTableColumn<T> {
  id: string;
  header: string;
  group?: string; // группа для двухуровневой шапки
  accessor: (row: T) => number | string | null;
  align?: 'left' | 'right';
  format?: 'money' | 'date' | 'text';
  sticky?: boolean; // закрепить слева
  width?: number;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  totals?: Record<string, number | string | null>;
  rowAccent?: (row: T) => string | undefined; // цвет полосы слева
  empty?: string;
  searchable?: boolean;
}

function fmt(v: number | string | null | undefined, format?: string): { text: string; cls: string } {
  if (format === 'money') {
    const n = Number(v ?? 0);
    if (v == null || n === 0) return { text: '—', cls: 'text-slate-300' };
    return { text: n.toLocaleString('ru-RU'), cls: n < 0 ? 'text-rose-600' : '' };
  }
  if (format === 'date') return { text: v ? String(v).slice(0, 10).split('-').reverse().join('.') : '—', cls: '' };
  return { text: v == null || v === '' ? '—' : String(v), cls: '' };
}

export function DataTable<T>({ columns, rows, totals, rowAccent, empty = 'Нет данных', searchable = true }: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [dense, setDense] = useState(false);

  const columnDefs = useMemo<ColumnDef<T>[]>(() => {
    type GroupDef = ColumnDef<T> & { columns: ColumnDef<T>[] };
    const out: ColumnDef<T>[] = [];
    const groups = new Map<string, GroupDef>();
    for (const c of columns) {
      const leaf: ColumnDef<T> = {
        id: c.id,
        accessorFn: (r) => c.accessor(r),
        header: c.header,
        enableSorting: c.sortable ?? true,
        meta: c,
      };
      if (c.group) {
        let g = groups.get(c.group);
        if (!g) {
          g = { id: `g_${c.group}`, header: c.group, columns: [] } as GroupDef;
          groups.set(c.group, g);
          out.push(g);
        }
        g.columns.push(leaf);
      } else out.push(leaf);
    }
    return out;
  }, [columns]);

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  // Смещения слева для закреплённых колонок.
  const leafCols = table.getVisibleLeafColumns();
  const stickyLeft = new Map<string, number>();
  let acc = 0;
  for (const lc of leafCols) {
    const m = lc.columnDef.meta as DataTableColumn<T> | undefined;
    if (m?.sticky) {
      stickyLeft.set(lc.id, acc);
      acc += m.width ?? 140;
    }
  }
  const pad = dense ? 'px-2 py-1' : 'px-3 py-2';
  const stickyCls = (id: string, isHeader: boolean) =>
    stickyLeft.has(id) ? `sticky z-10 ${isHeader ? '' : 'bg-white'}` : '';

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        {searchable ? (
          <input className="input h-8 w-64 py-1 text-sm" placeholder="Поиск…" value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} />
        ) : (
          <span />
        )}
        <button className="btn-ghost text-xs" onClick={() => setDense((v) => !v)}>
          {dense ? '↕ обычная' : '↕ компактная'}
        </button>
      </div>

      <div className="overflow-auto rounded-2xl border border-slate-200" style={{ maxHeight: '70vh' }}>
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-20 bg-slate-50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const m = h.column.columnDef.meta as DataTableColumn<T> | undefined;
                  const canSort = h.column.getCanSort() && !h.isPlaceholder && h.subHeaders.length === 0;
                  const dir = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      colSpan={h.colSpan}
                      className={`border-b border-slate-200 ${pad} text-left font-semibold text-slate-600 ${m?.align === 'right' ? 'text-right' : ''} ${stickyCls(h.column.id, true)} ${canSort ? 'cursor-pointer select-none' : ''} bg-slate-50`}
                      style={stickyLeft.has(h.column.id) ? { left: stickyLeft.get(h.column.id) } : undefined}
                      onClick={canSort ? h.column.getToggleSortingHandler() : undefined}
                    >
                      {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                      {dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={leafCols.length} className="px-3 py-8 text-center text-slate-400">{empty}</td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => {
                const accent = rowAccent?.(row.original);
                return (
                  <tr key={row.id} className="border-b border-slate-50 hover:bg-slate-50">
                    {row.getVisibleCells().map((cell, ci) => {
                      const m = cell.column.columnDef.meta as DataTableColumn<T>;
                      const { text, cls } = fmt(cell.getValue() as number | string | null, m.format);
                      return (
                        <td
                          key={cell.id}
                          className={`${pad} ${m.align === 'right' ? 'text-right tabular-nums' : ''} ${cls} ${stickyCls(cell.column.id, false)}`}
                          style={{
                            ...(stickyLeft.has(cell.column.id) ? { left: stickyLeft.get(cell.column.id) } : {}),
                            ...(ci === 0 && accent ? { borderLeft: `3px solid ${accent}` } : {}),
                          }}
                        >
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
          {totals && (
            <tfoot className="sticky bottom-0 z-20 bg-slate-100">
              <tr>
                {leafCols.map((lc, i) => {
                  const m = lc.columnDef.meta as DataTableColumn<T>;
                  const val = totals[lc.id];
                  const { text, cls } = i === 0 && val == null ? { text: 'ИТОГО', cls: '' } : fmt(val, m.format);
                  return (
                    <td
                      key={lc.id}
                      className={`border-t border-slate-300 ${pad} font-semibold ${m.align === 'right' ? 'text-right tabular-nums' : ''} ${cls} ${stickyCls(lc.id, false)}`}
                      style={stickyLeft.has(lc.id) ? { left: stickyLeft.get(lc.id), background: 'inherit' } : undefined}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
