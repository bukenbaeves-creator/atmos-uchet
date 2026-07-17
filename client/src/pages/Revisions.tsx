import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, ApiError } from '../api/client';
import { PageHeader, Spinner, EmptyState, Badge } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { formatDate, formatMoney } from '../lib/format';
import { useAuth } from '../lib/auth';

interface RevListItem {
  id: number;
  date: string;
  status: 'draft' | 'applied';
  note: string | null;
  appliedAt: string | null;
  total: number;
  counted: number;
  diffs: number;
}
interface RevItem {
  id: number;
  nomenclatureId: number;
  systemQty: number;
  countedQty: number | null;
  surplusPrice?: number | null;
  costDelta?: number | null;
  note: string | null;
  nomenclature: { id: number; nameDisplay: string; type: 'drug' | 'consumable'; unitWriteoff: string | null };
}
interface Revision {
  id: number;
  date: string;
  status: 'draft' | 'applied';
  note: string | null;
  appliedAt: string | null;
  items: RevItem[];
}

function StatusBadge({ status }: { status: 'draft' | 'applied' }) {
  return status === 'applied' ? <Badge tone="green">Применена</Badge> : <Badge tone="amber">Черновик</Badge>;
}

// ===== Список ревизий =====
export function Revisions() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['revisions'],
    queryFn: () => apiGet<{ items: RevListItem[] }>('/revisions'),
  });

  const create = async () => {
    setError(null);
    setBusy(true);
    try {
      const rev = await apiPost<Revision>('/revisions', {});
      qc.invalidateQueries({ queryKey: ['revisions'] });
      navigate(`/revisions/${rev.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать ревизию');
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<RevListItem>[] = [
    { header: 'Дата', cell: (r) => formatDate(r.date) },
    { header: 'Статус', cell: (r) => <StatusBadge status={r.status} /> },
    { header: 'Позиций', align: 'right', cell: (r) => r.total },
    { header: 'Посчитано', align: 'right', cell: (r) => r.counted },
    {
      header: 'Расхождений',
      align: 'right',
      cell: (r) => (r.diffs > 0 ? <span className="font-semibold text-rose-600">{r.diffs}</span> : r.counted ? '0' : '—'),
    },
    { header: 'Примечание', cell: (r) => <span className="text-slate-500">{r.note ?? '—'}</span> },
  ];

  return (
    <div>
      <PageHeader
        title="Ревизия склада"
        subtitle="Сверка фактических остатков с учётными. Медсестра вводит факт, корректировки применяет администратор."
        actions={
          <button className="btn-primary" disabled={busy} onClick={create}>
            {busy ? 'Создание…' : '+ Новая ревизия'}
          </button>
        }
      />
      {error && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : !data || data.items.length === 0 ? (
        <EmptyState>Ревизий пока нет. Нажмите «Новая ревизия», чтобы начать.</EmptyState>
      ) : (
        <Table columns={columns} rows={data.items} onRowClick={(r) => navigate(`/revisions/${r.id}`)} />
      )}
    </div>
  );
}

// ===== Детальная ревизия: ввод факта и применение =====
type Edit = { counted: string; price: string; note: string };

export function RevisionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data, isLoading, isError } = useQuery({
    queryKey: ['revision', id],
    queryFn: () => apiGet<Revision>(`/revisions/${id}`),
  });

  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const m: Record<number, Edit> = {};
    for (const it of data.items) {
      m[it.nomenclatureId] = {
        counted: it.countedQty == null ? '' : String(it.countedQty),
        price: it.surplusPrice == null ? '' : String(it.surplusPrice),
        note: it.note ?? '',
      };
    }
    setEdits(m);
  }, [data]);

  const isDraft = data?.status === 'draft';
  const editable = isDraft; // и nurse, и admin могут вводить факт в черновике

  const setEdit = (nid: number, patch: Partial<Edit>) =>
    setEdits((prev) => ({ ...prev, [nid]: { ...prev[nid], ...patch } }));

  // Итоги по расхождениям (для сводки/кнопки применения).
  const summary = useMemo(() => {
    if (!data) return { counted: 0, shortages: 0, surpluses: 0, surplusNoPrice: 0 };
    let counted = 0;
    let shortages = 0;
    let surpluses = 0;
    let surplusNoPrice = 0;
    for (const it of data.items) {
      const e = edits[it.nomenclatureId];
      if (!e || e.counted === '') continue;
      counted++;
      const diff = Number(e.counted) - it.systemQty;
      if (diff < 0) shortages++;
      else if (diff > 0) {
        surpluses++;
        if (e.price === '') surplusNoPrice++;
      }
    }
    return { counted, shortages, surpluses, surplusNoPrice };
  }, [data, edits]);

  const buildPayload = () => ({
    items: (data?.items ?? []).map((it) => {
      const e = edits[it.nomenclatureId];
      return {
        nomenclatureId: it.nomenclatureId,
        countedQty: e && e.counted !== '' ? Number(e.counted) : null,
        surplusPrice: e && e.price !== '' ? Number(e.price) : null,
        note: e && e.note ? e.note : null,
      };
    }),
  });

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await apiPut(`/revisions/${id}/items`, buildPayload());
      qc.invalidateQueries({ queryKey: ['revision', id] });
      qc.invalidateQueries({ queryKey: ['revisions'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (summary.surplusNoPrice > 0) {
      setError(`Укажите цену излишка для ${summary.surplusNoPrice} позиц. (столбец «Цена излишка»).`);
      return;
    }
    if (
      !window.confirm(
        `Применить ревизию? Будет проведено: недостач — ${summary.shortages}, излишков — ${summary.surpluses}. ` +
          `Остатки на складе изменятся, отменить будет нельзя.`,
      )
    )
      return;
    setError(null);
    setBusy(true);
    try {
      await apiPut(`/revisions/${id}/items`, buildPayload()); // сохраняем текущий ввод перед применением
      await apiPatch(`/revisions/${id}/apply`, {});
      qc.invalidateQueries({ queryKey: ['revision', id] });
      qc.invalidateQueries({ queryKey: ['revisions'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось применить ревизию');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Удалить черновик ревизии?')) return;
    setBusy(true);
    try {
      await apiDelete(`/revisions/${id}`);
      qc.invalidateQueries({ queryKey: ['revisions'] });
      navigate('/revisions');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
      setBusy(false);
    }
  };

  if (isLoading) return <Spinner />;
  if (isError || !data) return <EmptyState>Ревизия не найдена.</EmptyState>;

  const totalDelta = data.items.reduce((s, it) => s + (it.costDelta ?? 0), 0);

  return (
    <div>
      <PageHeader
        title={`Ревизия · ${formatDate(data.date)}`}
        subtitle="Введите фактический остаток по посчитанным позициям. Пустое поле — «не считали», остаток не меняется."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={data.status} />
            <button className="btn-ghost" onClick={() => navigate('/revisions')}>
              Назад
            </button>
            {isDraft && (
              <button className="btn-ghost" disabled={busy} onClick={save}>
                {busy ? '…' : 'Сохранить'}
              </button>
            )}
            {isDraft && isAdmin && (
              <button className="btn-primary" disabled={busy || summary.counted === 0} onClick={apply}>
                Применить
              </button>
            )}
            {isDraft && isAdmin && (
              <button className="btn-ghost text-rose-600" disabled={busy} onClick={remove}>
                Удалить
              </button>
            )}
          </div>
        }
      />

      {isDraft && !isAdmin && (
        <div className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          Введите фактические остатки и нажмите «Сохранить». Корректировки применит администратор.
        </div>
      )}
      {error && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      <div className="overflow-x-auto rounded-2xl ring-1 ring-slate-200/70">
        <table className="min-w-full border-separate border-spacing-0 bg-white text-sm">
          <thead className="bg-slate-50/95">
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="border-b border-slate-200 px-3 py-2.5">Позиция</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-right">Учётный</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-right">Факт</th>
              <th className="border-b border-slate-200 px-3 py-2.5 text-right">Разница</th>
              {isAdmin && <th className="border-b border-slate-200 px-3 py-2.5 text-right">Цена излишка</th>}
              {isAdmin && data.status === 'applied' && <th className="border-b border-slate-200 px-3 py-2.5 text-right">Δ стоимости</th>}
              <th className="border-b border-slate-200 px-3 py-2.5">Примечание</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it) => {
              const e = edits[it.nomenclatureId] ?? { counted: '', price: '', note: '' };
              const hasCount = e.counted !== '';
              const diff = hasCount ? Number(e.counted) - it.systemQty : null;
              const unit = it.nomenclature.unitWriteoff ?? '';
              return (
                <tr key={it.id} className="even:bg-slate-50/40">
                  <td className="border-b border-slate-100 px-3 py-2 font-medium">{it.nomenclature.nameDisplay}</td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right tabular-nums">
                    {it.systemQty} {unit}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right">
                    {editable ? (
                      <input
                        type="number"
                        min={0}
                        step="any"
                        className="input w-24 text-right"
                        value={e.counted}
                        placeholder="—"
                        onChange={(ev) => setEdit(it.nomenclatureId, { counted: ev.target.value })}
                      />
                    ) : (
                      <span className="tabular-nums">{it.countedQty == null ? '—' : `${it.countedQty} ${unit}`}</span>
                    )}
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right tabular-nums">
                    {diff == null ? (
                      <span className="text-slate-300">—</span>
                    ) : diff === 0 ? (
                      <span className="text-slate-400">0</span>
                    ) : diff > 0 ? (
                      <span className="font-semibold text-emerald-600">+{diff} излишек</span>
                    ) : (
                      <span className="font-semibold text-rose-600">{diff} недостача</span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="border-b border-slate-100 px-3 py-2 text-right">
                      {editable && diff != null && diff > 0 ? (
                        <input
                          type="number"
                          min={0}
                          step="any"
                          className="input w-28 text-right"
                          value={e.price}
                          placeholder="цена"
                          onChange={(ev) => setEdit(it.nomenclatureId, { price: ev.target.value })}
                        />
                      ) : (
                        <span className="tabular-nums text-slate-500">{it.surplusPrice != null ? formatMoney(it.surplusPrice) : '—'}</span>
                      )}
                    </td>
                  )}
                  {isAdmin && data.status === 'applied' && (
                    <td className="border-b border-slate-100 px-3 py-2 text-right tabular-nums">
                      {it.costDelta == null || it.costDelta === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span className={it.costDelta > 0 ? 'text-emerald-600' : 'text-rose-600'}>{formatMoney(it.costDelta)}</span>
                      )}
                    </td>
                  )}
                  <td className="border-b border-slate-100 px-3 py-2">
                    {editable ? (
                      <input
                        className="input"
                        value={e.note}
                        placeholder="—"
                        onChange={(ev) => setEdit(it.nomenclatureId, { note: ev.target.value })}
                      />
                    ) : (
                      <span className="text-slate-500">{it.note ?? '—'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-600">
        <span>Посчитано: <b>{summary.counted}</b> из {data.items.length}</span>
        <span>Недостач: <b className="text-rose-600">{summary.shortages}</b></span>
        <span>Излишков: <b className="text-emerald-600">{summary.surpluses}</b></span>
        {isAdmin && data.status === 'applied' && (
          <span>
            Итог корректировки: <b className={totalDelta >= 0 ? 'text-emerald-600' : 'text-rose-600'}>{formatMoney(totalDelta)}</b>
          </span>
        )}
      </div>
    </div>
  );
}
