import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { JournalPage } from '../components/JournalPage';
import { apiGet, apiPost, ApiError } from '../api/client';
import type { ListResponse } from '../api/hooks';
import { formatDate } from '../lib/format';
import { Modal } from '../components/ui';
import { useAuth } from '../lib/auth';
import type { Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface Patient {
  id: number;
  fio: string;
  phone: string;
  city: string | null;
  birthDate: string | null;
  services?: string[];
  createdBy?: number | null;
  createdAt?: string;
}

const fields: Field[] = [
  { name: 'fio', label: 'ФИО', type: 'text', required: true, span: 2 },
  { name: 'phone', label: 'Телефон', type: 'phone', required: true },
  { name: 'birthDate', label: 'Дата рождения', type: 'date' },
  { name: 'city', label: 'Город', type: 'select', dict: 'city', required: true },
];

export function Patients() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [merging, setMerging] = useState<Patient | null>(null);

  const columns: Column<Patient>[] = [
    { header: 'ФИО', cell: (p) => <span className="font-medium text-brand-700">{p.fio}</span> },
    { header: 'Телефон', cell: (p) => p.phone },
    { header: 'Город', cell: (p) => p.city ?? '—' },
    { header: 'Дата рождения', cell: (p) => formatDate(p.birthDate) },
    { header: 'Услуга', cell: (p) => (p.services && p.services.length ? p.services.join(', ') : '—') },
  ];

  return (
    <>
      <JournalPage<Patient>
        entity="patients"
        title="Пациенты"
        subtitle="Реестр пациентов. Клик по строке — карточка пациента."
        columns={columns}
        fields={fields}
        exportJournal="patients"
        newButtonLabel="Пациента"
        onRowClick={(p) => navigate(`/patients/${p.id}`)}
        rowActions={(p) =>
          isAdmin ? (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setMerging(p)}>
              Объединить
            </button>
          ) : null
        }
      />

      <Modal open={merging != null} onClose={() => setMerging(null)} title={`Объединить дубль · ${merging?.fio ?? ''}`}>
        {merging && (
          <PatientMergeForm
            dup={merging}
            onDone={() => setMerging(null)}
            onSaved={() => qc.invalidateQueries()}
          />
        )}
      </Modal>
    </>
  );
}

// Слияние дубля пациента в основную карточку: поиск цели, перенос всех записей.
function PatientMergeForm({ dup, onDone, onSaved }: { dup: Patient; onDone: () => void; onSaved: () => void }) {
  const [term, setTerm] = useState('');
  const [target, setTarget] = useState<Patient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ['patients', 'merge-pick', term],
    queryFn: () => apiGet<ListResponse<Patient>>(`/patients?pageSize=8&search=${encodeURIComponent(term)}`),
    enabled: !target && term.trim().length >= 1,
  });

  const submit = async () => {
    if (!target) return;
    setError(null);
    setBusy(true);
    try {
      await apiPost(`/patients/${dup.id}/merge`, { intoId: target.id });
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
        Все консультации, операции, платежи и списания карточки <b>«{dup.fio}»</b> ({dup.phone}) будут перенесены в
        выбранную основную карточку, а дубль скрыт.
      </p>
      {target ? (
        <div className="flex items-center gap-2">
          <div className="input flex-1 bg-slate-50">
            Основная: {target.fio} ({target.phone})
          </div>
          <button type="button" className="btn-ghost text-sm" onClick={() => setTarget(null)}>
            Сменить
          </button>
        </div>
      ) : (
        <div>
          <label className="label">Основная карточка (куда объединять)</label>
          <input className="input" placeholder="Поиск по ФИО или телефону…" value={term} onChange={(e) => setTerm(e.target.value)} autoComplete="off" />
          {term.trim().length >= 1 && (
            <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-slate-200">
              {(data?.items ?? []).filter((p) => p.id !== dup.id).length ? (
                data!.items
                  .filter((p) => p.id !== dup.id)
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-100"
                      onClick={() => setTarget(p)}
                    >
                      <span>{p.fio}</span>
                      <span className="text-xs text-slate-400">{p.phone}</span>
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
