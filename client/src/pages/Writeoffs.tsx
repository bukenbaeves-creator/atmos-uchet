import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError, expenseExportUrl } from '../api/client';
import type { ListResponse } from '../api/hooks';
import { formatDate } from '../lib/format';
import { PageHeader, Spinner, EmptyState, Modal, Badge, Pagination } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { PatientBlock, type PatientValue } from '../components/PatientBlock';
import { useAuth } from '../lib/auth';

interface Writeoff {
  id: number;
  date: string;
  qty: number;
  costTotal?: number; // приходит только администратору
  isShortage: boolean;
  patient?: { id: number; fio: string };
  nomenclature?: { nameDisplay: string; unitWriteoff: string | null };
  category?: { name: string };
}
interface NomOption { id: number; nameDisplay: string; unitWriteoff: string | null }
interface CatOption { id: number; name: string }

export function Writeoffs() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['writeoffs', { page }],
    queryFn: () => apiGet<ListResponse<Writeoff>>(`/writeoffs?page=${page}`),
  });

  const columns: Column<Writeoff>[] = [
    { header: 'Дата', cell: (w) => formatDate(w.date) },
    { header: 'Пациент', cell: (w) => <span className="font-medium">{w.patient?.fio ?? '—'}</span> },
    { header: 'Позиция', cell: (w) => w.nomenclature?.nameDisplay ?? '—' },
    {
      header: 'Кол-во',
      align: 'right',
      cell: (w) => `${w.qty}${w.nomenclature?.unitWriteoff ? ' ' + w.nomenclature.unitWriteoff : ''}`,
    },
    { header: 'Категория', cell: (w) => w.category?.name ?? '—' },
    {
      header: 'Остаток',
      cell: (w) => (w.isShortage ? <Badge tone="red">списано в минус</Badge> : <Badge tone="green">в наличии</Badge>),
    },
    // Себестоимость — только администратору (сервер не отдаёт её медсестре)
    ...(isAdmin
      ? [{ header: 'Себестоимость', align: 'right' as const, cell: (w: Writeoff) => (w.costTotal != null ? w.costTotal.toLocaleString('ru-RU') : '—') }]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Расход материалов"
        subtitle="Списание препаратов и расходников на пациента. Себестоимость видит только администратор."
        actions={
          <>
            <a className="btn-ghost" href={expenseExportUrl('writeoffs')}>
              Экспорт в Excel
            </a>
            <button className="btn-primary" onClick={() => setOpen(true)}>
              + Списание
            </button>
          </>
        }
      />

      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : !data || data.items.length === 0 ? (
        <EmptyState>Списаний пока нет</EmptyState>
      ) : (
        <>
          <Table columns={columns} rows={data.items} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Новое списание материала">
        <WriteoffForm
          onDone={() => setOpen(false)}
          onSaved={() => {
            for (const k of ['writeoffs', 'stock', 'nomenclature']) qc.invalidateQueries({ queryKey: [k] });
          }}
        />
      </Modal>
    </div>
  );
}

function WriteoffForm({ onDone, onSaved }: { onDone: () => void; onSaved: () => void }) {
  const [patient, setPatient] = useState<PatientValue>({});
  const [nomenclatureId, setNomenclatureId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [qty, setQty] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Только подтверждённые позиции (active) — draft списывать нельзя
  const { data: cats } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => apiGet<{ items: CatOption[] }>('/expense-categories'),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setWarning(null);
    if (!nomenclatureId) {
      setError('Выберите позицию номенклатуры');
      return;
    }
    setBusy(true);
    try {
      const res = await apiPost<{ warning?: string }>('/writeoffs', {
        patient: {
          fio: (patient.fio ?? '').trim(),
          phone: (patient.phone ?? '').trim(),
          city: patient.city || '',
          birthDate: patient.birthDate || null,
        },
        nomenclatureId: Number(nomenclatureId),
        categoryId: Number(categoryId),
        qty: Number(qty),
        date,
      });
      onSaved();
      if (res.warning) {
        setWarning(res.warning); // нехватка остатка — показываем, но списание прошло
      } else {
        onDone();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PatientBlock value={patient} onChange={setPatient} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label">Позиция (номенклатура) *</label>
          <NomenclaturePicker value={Number(nomenclatureId) || null} onChange={(id) => setNomenclatureId(id ? String(id) : '')} />
        </div>
        <div>
          <label className="label">Количество *</label>
          <input
            type="number"
            className="input"
            required
            min={0}
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Категория расхода *</label>
          <select className="input" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">— выберите —</option>
            {cats?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Дата *</label>
          <input
            type="date"
            className="input"
            required
            min="2020-01-01"
            max={new Date().toISOString().slice(0, 10)}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      {warning && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {warning}
          <div className="mt-2">
            <button type="button" className="btn-ghost" onClick={onDone}>
              Понятно, закрыть
            </button>
          </div>
        </div>
      )}
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      {!warning && (
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onDone}>
            Отмена
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Сохранение…' : 'Списать'}
          </button>
        </div>
      )}
    </form>
  );
}

// Поиск позиции номенклатуры (позиций много) — ввод фильтрует список на сервере.
// Показывает выбранную позицию с кнопкой «сменить»; наружу отдаёт nomenclatureId.
function NomenclaturePicker({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<NomOption | null>(null);

  const { data } = useQuery({
    queryKey: ['nomenclature', { status: 'active', search: term }],
    queryFn: () => apiGet<{ items: NomOption[] }>(`/nomenclature?status=active&search=${encodeURIComponent(term)}`),
    enabled: value == null && term.trim().length >= 1,
  });

  // Уже выбрана позиция — показываем её с возможностью сменить
  if (value != null && selected) {
    return (
      <div className="flex items-center gap-2">
        <div className="input flex-1 bg-slate-50">
          {selected.nameDisplay}
          {selected.unitWriteoff ? ` (${selected.unitWriteoff})` : ''}
        </div>
        <button
          type="button"
          className="btn-ghost text-sm"
          onClick={() => {
            setSelected(null);
            onChange(null);
            setTerm('');
          }}
        >
          Сменить
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        className="input"
        placeholder="Начните вводить название позиции…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        autoComplete="off"
      />
      {term.trim().length >= 1 && (
        <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-slate-200">
          {data?.items.length ? (
            data.items.map((n) => (
              <button
                type="button"
                key={n.id}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-100"
                onClick={() => {
                  setSelected(n);
                  onChange(n.id);
                }}
              >
                <span>{n.nameDisplay}</span>
                {n.unitWriteoff && <span className="text-xs text-slate-400">{n.unitWriteoff}</span>}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-sm text-slate-400">Ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
}
