import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, apiPut, ApiError } from '../api/client';
import { PageHeader, Spinner, EmptyState, Modal, Badge, Hint } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { useAuth } from '../lib/auth';

interface Nom {
  id: number;
  nameDisplay: string;
  type: 'drug' | 'consumable';
  unitMeasure: string | null;
  unitWriteoff: string | null;
  packFactor: number;
  minStock: number;
  isSpecial: boolean;
  isExpiryTracked: boolean;
  status: 'draft' | 'active';
}

export function Nomenclature() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const qc = useQueryClient();
  const [tab, setTab] = useState<'active' | 'draft'>('active');
  const [confirming, setConfirming] = useState<Nom | null>(null);
  const [editing, setEditing] = useState<Nom | null>(null);
  const [merging, setMerging] = useState<Nom | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['nomenclature', { status: tab }],
    queryFn: () => apiGet<{ items: Nom[] }>(`/nomenclature?status=${tab}`),
  });

  const changeTab = (t: 'active' | 'draft') => {
    setTab(t);
    setSelected(new Set());
    setBulkError(null);
  };
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const items = data?.items ?? [];
  const allChecked = items.length > 0 && items.every((n) => selected.has(n.id));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(items.map((n) => n.id)));

  const confirmSelected = async () => {
    if (selected.size === 0) return;
    setBulkError(null);
    setBulkBusy(true);
    try {
      await apiPatch<{ confirmed: number }>('/nomenclature/confirm-bulk', { ids: [...selected] });
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['nomenclature'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : 'Не удалось подтвердить выбранные');
    } finally {
      setBulkBusy(false);
    }
  };

  const showSelect = isAdmin && tab === 'draft';
  const columns: Column<Nom>[] = [
    ...(showSelect
      ? [
          {
            header: '',
            cell: (n: Nom) => (
              <input
                type="checkbox"
                checked={selected.has(n.id)}
                onChange={() => toggle(n.id)}
                aria-label={`Выбрать ${n.nameDisplay}`}
              />
            ),
          } as Column<Nom>,
        ]
      : []),
    { header: 'Наименование', cell: (n) => <span className="font-medium">{n.nameDisplay}</span> },
    { header: 'Тип', cell: (n) => (n.type === 'drug' ? 'Препарат' : 'Расходник') },
    { header: 'Ед. списания', cell: (n) => n.unitWriteoff ?? '—' },
    { header: 'Срок годн.', cell: (n) => (n.isExpiryTracked ? 'учитывается' : '—') },
    { header: 'Спецучёт', cell: (n) => (n.isSpecial ? <Badge tone="red">да</Badge> : '—') },
    {
      header: '',
      align: 'right',
      cell: (n) =>
        isAdmin ? (
          <div className="flex justify-end gap-1">
            {n.status === 'draft' ? (
              <button className="btn-primary px-2 py-1 text-xs" onClick={() => setConfirming(n)}>
                Подтвердить
              </button>
            ) : (
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setEditing(n)}>
                Изменить
              </button>
            )}
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setMerging(n)}>
              Объединить
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Номенклатура"
        subtitle="Справочник материалов. Новые позиции из приходов попадают на подтверждение администратору."
      />
      <div className="mb-3 flex gap-2">
        <button className={tab === 'active' ? 'btn-primary' : 'btn-ghost'} onClick={() => changeTab('active')}>
          Активные
        </button>
        <button className={tab === 'draft' ? 'btn-primary' : 'btn-ghost'} onClick={() => changeTab('draft')}>
          На подтверждении{data && tab === 'draft' ? ` (${data.items.length})` : ''}
        </button>
      </div>

      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : !data || data.items.length === 0 ? (
        <EmptyState>{tab === 'draft' ? 'Нет позиций на подтверждении' : 'Активных позиций нет'}</EmptyState>
      ) : (
        <>
          {showSelect && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                Выбрать все
              </label>
              <span className="text-slate-500">Выбрано: {selected.size}</span>
              <button
                className="btn-primary ml-auto px-3 py-1.5 text-xs"
                disabled={bulkBusy || selected.size === 0}
                onClick={confirmSelected}
              >
                {bulkBusy ? 'Подтверждение…' : `Подтвердить выбранные${selected.size ? ` (${selected.size})` : ''}`}
              </button>
            </div>
          )}
          {bulkError && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{bulkError}</div>}
          <Table columns={columns} rows={data.items} />
        </>
      )}

      <Modal open={confirming != null} onClose={() => setConfirming(null)} title={`Подтверждение · ${confirming?.nameDisplay ?? ''}`}>
        {confirming && (
          <AttrsForm
            nom={confirming}
            mode="confirm"
            onDone={() => setConfirming(null)}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['nomenclature'] });
              qc.invalidateQueries({ queryKey: ['stock'] });
            }}
          />
        )}
      </Modal>

      <Modal open={editing != null} onClose={() => setEditing(null)} title={`Изменить · ${editing?.nameDisplay ?? ''}`}>
        {editing && (
          <AttrsForm
            nom={editing}
            mode="edit"
            onDone={() => setEditing(null)}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['nomenclature'] });
              qc.invalidateQueries({ queryKey: ['stock'] });
            }}
          />
        )}
      </Modal>

      <Modal open={merging != null} onClose={() => setMerging(null)} title={`Объединить дубль · ${merging?.nameDisplay ?? ''}`}>
        {merging && (
          <MergeForm
            dup={merging}
            onDone={() => setMerging(null)}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['nomenclature'] });
              qc.invalidateQueries({ queryKey: ['stock'] });
            }}
          />
        )}
      </Modal>
    </div>
  );
}

// Слияние дубля позиции в основную: поиск цели, перенос движений на неё.
function MergeForm({ dup, onDone, onSaved }: { dup: Nom; onDone: () => void; onSaved: () => void }) {
  const [term, setTerm] = useState('');
  const [target, setTarget] = useState<Nom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ['nomenclature', { status: 'active', search: term }],
    queryFn: () => apiGet<{ items: Nom[] }>(`/nomenclature?status=active&search=${encodeURIComponent(term)}`),
    enabled: !target && term.trim().length >= 1,
  });

  const submit = async () => {
    if (!target) return;
    setError(null);
    setBusy(true);
    try {
      await apiPost(`/nomenclature/${dup.id}/merge`, { intoId: target.id });
      onSaved();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось объединить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Все партии, списания и варианты написания позиции <b>«{dup.nameDisplay}»</b> будут перенесены в выбранную основную
        позицию, а дубль скрыт. Действие необратимо через интерфейс.
      </p>
      {target ? (
        <div className="flex items-center gap-2">
          <div className="input flex-1 bg-slate-50">Основная: {target.nameDisplay}</div>
          <button type="button" className="btn-ghost text-sm" onClick={() => setTarget(null)}>
            Сменить
          </button>
        </div>
      ) : (
        <div>
          <label className="label">Основная позиция (куда объединять)</label>
          <input className="input" placeholder="Поиск позиции…" value={term} onChange={(e) => setTerm(e.target.value)} autoComplete="off" />
          {term.trim().length >= 1 && (
            <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-slate-200">
              {(data?.items ?? []).filter((n) => n.id !== dup.id).length ? (
                data!.items
                  .filter((n) => n.id !== dup.id)
                  .map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-100"
                      onClick={() => setTarget(n)}
                    >
                      {n.nameDisplay}
                    </button>
                  ))
              ) : (
                <div className="px-3 py-2 text-sm text-slate-400">Ничего не найдено</div>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="button" className="btn-primary" disabled={!target || busy} onClick={submit}>
          {busy ? 'Объединение…' : 'Объединить'}
        </button>
      </div>
    </div>
  );
}

// Форма атрибутов позиции. mode='confirm' — подтверждает draft (PATCH /confirm),
// mode='edit' — правит уже подтверждённую позицию (PUT /:id). Поля одинаковые.
function AttrsForm({ nom, mode, onDone, onSaved }: { nom: Nom; mode: 'confirm' | 'edit'; onDone: () => void; onSaved: () => void }) {
  const [nameDisplay, setNameDisplay] = useState(nom.nameDisplay);
  const [type, setType] = useState<'drug' | 'consumable'>(nom.type);
  const [unitWriteoff, setUnitWriteoff] = useState(nom.unitWriteoff ?? '');
  const [unitMeasure, setUnitMeasure] = useState(nom.unitMeasure ?? '');
  const [packFactor, setPackFactor] = useState(String(nom.packFactor ?? 1));
  const [minStock, setMinStock] = useState(String(nom.minStock ?? 0));
  const [isSpecial, setIsSpecial] = useState(nom.isSpecial);
  const [isExpiryTracked, setIsExpiryTracked] = useState(nom.isExpiryTracked);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameDisplay.trim()) {
      setError('Укажите наименование');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const payload = {
        nameDisplay: nameDisplay.trim(),
        type,
        unitWriteoff: unitWriteoff || null,
        unitMeasure: unitMeasure || null,
        packFactor: Number(packFactor) || 1,
        minStock: Number(minStock) || 0,
        isSpecial,
        isExpiryTracked,
      };
      if (mode === 'confirm') await apiPatch(`/nomenclature/${nom.id}/confirm`, payload);
      else await apiPut(`/nomenclature/${nom.id}`, payload);
      onSaved();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className="label">Наименование</label>
        <input className="input" value={nameDisplay} onChange={(e) => setNameDisplay(e.target.value)} />
      </div>
      <div>
        <label className="label">Тип</label>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as 'drug' | 'consumable')}>
          <option value="consumable">Расходник</option>
          <option value="drug">Препарат</option>
        </select>
      </div>
      <div>
        <label className="label">
          Единица измерения<Hint text="Как позиция измеряется физически (мл, мг, шт)." />
        </label>
        <input className="input" value={unitMeasure} onChange={(e) => setUnitMeasure(e.target.value)} placeholder="мл, мг, шт" />
      </div>
      <div>
        <label className="label">
          Единица списания<Hint text="В чём медсестра списывает расход (обычно шт или мл)." />
        </label>
        <input className="input" value={unitWriteoff} onChange={(e) => setUnitWriteoff(e.target.value)} placeholder="шт, мл" />
      </div>
      <div>
        <label className="label">
          Коэффициент упаковки
          <Hint text="Сколько единиц списания в одной единице прихода. Пример: приходуете упаковку из 100 таблеток, а списываете по таблетке → 100. Если приходуете и списываете одинаково (шт=шт) → 1." />
        </label>
        <input type="number" min={0} step="any" className="input" value={packFactor} onChange={(e) => setPackFactor(e.target.value)} />
      </div>
      <div>
        <label className="label">
          Минимальный остаток
          <Hint text="Порог дозакупа: когда остаток опустится ниже, позиция подсветится и попадёт в список к закупу." />
        </label>
        <input type="number" min={0} step="any" className="input" value={minStock} onChange={(e) => setMinStock(e.target.value)} />
      </div>
      <div className="flex flex-col justify-end gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isExpiryTracked} onChange={(e) => setIsExpiryTracked(e.target.checked)} />
          Учитывать срок годности (FEFO)
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isSpecial} onChange={(e) => setIsSpecial(e.target.checked)} />
          Контролируемый препарат
        </label>
      </div>

      {error && <div className="sm:col-span-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="sm:col-span-2 flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Сохранение…' : mode === 'confirm' ? 'Подтвердить позицию' : 'Сохранить'}
        </button>
      </div>
    </form>
  );
}
