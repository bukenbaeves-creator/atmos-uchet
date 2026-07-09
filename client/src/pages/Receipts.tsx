import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../api/client';
import type { ListResponse } from '../api/hooks';
import { formatDate, isExpired } from '../lib/format';
import { PageHeader, Spinner, EmptyState, Modal, Pagination, Hint } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { MoneyInput } from '../components/MoneyInput';
import { useAuth } from '../lib/auth';

interface Batch {
  id: number;
  qtyIn: number;
  purchasePrice?: number; // только администратору
  series: string | null;
  expiryDate: string | null;
  nomenclature?: { nameDisplay: string };
}
interface Receipt {
  id: number;
  date: string;
  supplier: string | null;
  note: string | null;
  batches: Batch[];
}

interface Line {
  name: string;
  qty: string;
  purchasePrice: number | string | null;
  series: string;
  expiryDate: string;
  noExpiry: boolean;
}

const emptyLine = (): Line => ({ name: '', qty: '', purchasePrice: '', series: '', expiryDate: '', noExpiry: false });

// Отображение срока годности: красный если истёк, «бессрочный» если пусто.
function ExpiryCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-400">бессрочный</span>;
  return isExpired(value) ? (
    <span className="font-semibold text-rose-600">{formatDate(value)} · просрочен</span>
  ) : (
    <span>{formatDate(value)}</span>
  );
}

export function Receipts() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Receipt | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['receipts', { page }],
    queryFn: () => apiGet<ListResponse<Receipt>>(`/receipts?page=${page}`),
  });

  const columns: Column<Receipt>[] = [
    { header: 'Дата', cell: (r) => formatDate(r.date) },
    { header: 'Поставщик', cell: (r) => r.supplier ?? '—' },
    { header: 'Позиций', align: 'right', cell: (r) => r.batches.length },
    {
      header: 'Состав',
      cell: (r) => (
        <span className="text-slate-600">
          {r.batches
            .map((b) => `${b.nomenclature?.nameDisplay ?? '—'} ×${b.qtyIn}`)
            .join(', ')}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Приход на склад"
        subtitle="Оприходование материалов. Клик по строке — состав прихода. Новые наименования уходят на подтверждение в «Номенклатуру»."
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            + Приход
          </button>
        }
      />

      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : !data || data.items.length === 0 ? (
        <EmptyState>Приходов пока нет</EmptyState>
      ) : (
        <>
          <Table columns={columns} rows={data.items} onRowClick={(r) => setDetail(r)} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} wide title="Новый приход">
        <ReceiptForm
          onDone={() => setOpen(false)}
          onSaved={() => {
            for (const k of ['receipts', 'stock', 'nomenclature']) qc.invalidateQueries({ queryKey: [k] });
          }}
        />
      </Modal>

      <Modal open={detail != null} onClose={() => setDetail(null)} wide title={`Приход · ${detail ? formatDate(detail.date) : ''}`}>
        {detail && <ReceiptDetail receipt={detail} />}
      </Modal>
    </div>
  );
}

function ReceiptDetail({ receipt }: { receipt: Receipt }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-x-8 gap-y-1">
        <div>
          <span className="text-slate-400">Дата:</span> {formatDate(receipt.date)}
        </div>
        <div>
          <span className="text-slate-400">Поставщик:</span> {receipt.supplier ?? '—'}
        </div>
        {receipt.note && (
          <div>
            <span className="text-slate-400">Примечание:</span> {receipt.note}
          </div>
        )}
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="py-2">Наименование</th>
            <th className="py-2 text-right">Кол-во</th>
            <th className="py-2">Серия</th>
            <th className="py-2">Срок годности</th>
            {isAdmin && <th className="py-2 text-right">Цена закупа</th>}
          </tr>
        </thead>
        <tbody>
          {receipt.batches.map((b) => (
            <tr key={b.id} className="border-b border-slate-100">
              <td className="py-2 font-medium">{b.nomenclature?.nameDisplay ?? '—'}</td>
              <td className="py-2 text-right">{b.qtyIn}</td>
              <td className="py-2">{b.series ?? '—'}</td>
              <td className="py-2">
                <ExpiryCell value={b.expiryDate} />
              </td>
              {isAdmin && <td className="py-2 text-right">{b.purchasePrice != null ? b.purchasePrice.toLocaleString('ru-RU') : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReceiptForm({ onDone, onSaved }: { onDone: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPost('/receipts', {
        date,
        supplier: supplier || null,
        note: note || null,
        lines: lines.map((l) => ({
          name: l.name.trim(),
          qty: Number(l.qty),
          purchasePrice: l.purchasePrice === '' || l.purchasePrice == null ? 0 : Number(l.purchasePrice),
          series: l.series || null,
          // Бессрочная позиция — без срока годности
          expiryDate: l.noExpiry ? null : l.expiryDate || null,
        })),
      });
      onSaved();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label">Дата прихода *</label>
          <input type="date" className="input" required min="2020-01-01" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Поставщик</label>
          <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="ТОО, аптека…" />
        </div>
        <div>
          <label className="label">Примечание</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium text-slate-600">Позиции прихода</div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-slate-200 p-2">
            <div className="col-span-12 sm:col-span-3">
              <label className="label">Наименование *</label>
              <input className="input" required value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} />
            </div>
            <div className="col-span-4 sm:col-span-1">
              <label className="label">Кол-во *</label>
              <input type="number" min={0} step="any" className="input" required value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
            </div>
            <div className="col-span-4 sm:col-span-2">
              <label className="label">
                Цена закупа *<Hint text="Цена за одну единицу прихода, не за всю партию." />
              </label>
              <MoneyInput value={l.purchasePrice} onChange={(v) => setLine(i, { purchasePrice: v as string })} required />
            </div>
            <div className="col-span-4 sm:col-span-2">
              <label className="label">
                Серия<Hint text="Номер серии/партии от производителя (с упаковки) — для отзыва партий и контроля." />
              </label>
              <input className="input" value={l.series} onChange={(e) => setLine(i, { series: e.target.value })} />
            </div>
            <div className="col-span-6 sm:col-span-2">
              <label className="label">
                Срок годности<Hint text="До какой даты препарат годен. Для позиций без срока отметьте «Бессрочный»." />
              </label>
              <input
                type="date"
                className="input"
                disabled={l.noExpiry}
                value={l.noExpiry ? '' : l.expiryDate}
                onChange={(e) => setLine(i, { expiryDate: e.target.value })}
              />
            </div>
            <div className="col-span-4 sm:col-span-1">
              <label className="label">Бессрочный</label>
              <div className="flex h-[38px] items-center">
                <input type="checkbox" checked={l.noExpiry} onChange={(e) => setLine(i, { noExpiry: e.target.checked })} />
              </div>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="label">&nbsp;</label>
              <button type="button" className="btn-ghost px-2 py-2 text-xs text-rose-600" onClick={() => removeLine(i)} title="Удалить строку">
                ✕
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="btn-ghost text-sm" onClick={addLine}>
          + Добавить позицию
        </button>
      </div>

      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Сохранение…' : 'Оприходовать'}
        </button>
      </div>
    </form>
  );
}
