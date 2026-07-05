import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut } from '../api/client';
import { formatMoney, formatNumber, toInputDate } from '../lib/format';
import { useAuth } from '../lib/auth';
import { PageHeader, Spinner } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { MoneyInput } from '../components/MoneyInput';

interface Row {
  id: number;
  manager: string;
  consultations: number;
  operations: number;
  amount: number;
}
interface Report {
  period: string;
  label: string;
  rates: { consultation: number; operation: number };
  rows: Omit<Row, 'id'>[];
  totals: { consultations: number; operations: number; amount: number };
}

const PERIODS = [
  { key: 'month', label: 'Месяц' },
  { key: 'quarter', label: 'Квартал' },
  { key: 'year', label: 'Год' },
];

export function Kpi() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [period, setPeriod] = useState('month');
  const [date, setDate] = useState(toInputDate(new Date()));

  const { data, isLoading } = useQuery({
    queryKey: ['kpi-report', period, date],
    queryFn: () => apiGet<Report>(`/kpi/report?period=${period}&date=${date}`),
  });

  // Редактирование ставок (админ)
  const [editRates, setEditRates] = useState<{ consultation: string; operation: string } | null>(null);
  const saveRates = useMutation({
    mutationFn: (r: { consultation: number; operation: number }) => apiPut('/kpi/rates', r),
    onSuccess: () => {
      setEditRates(null);
      qc.invalidateQueries({ queryKey: ['kpi-report'] });
    },
  });

  const rows: Row[] = (data?.rows ?? []).map((r, i) => ({ ...r, id: i + 1 }));

  const columns: Column<Row>[] = [
    { header: 'Менеджер', cell: (r) => <span className="font-medium">{r.manager}</span> },
    { header: 'Записей на консультацию', align: 'right', cell: (r) => formatNumber(r.consultations) },
    { header: 'Записей на операцию', align: 'right', cell: (r) => formatNumber(r.operations) },
    {
      header: 'Вознаграждение (KPI)',
      align: 'right',
      cell: (r) => <span className="font-semibold text-emerald-600">{formatMoney(r.amount)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="KPI менеджеров"
        subtitle="Вознаграждение по количеству записей на консультации и операции."
        actions={
          <div className="flex items-end gap-2">
            <div className="flex rounded-lg bg-slate-100 p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    period === p.key ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                  onClick={() => setPeriod(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div>
              <label className="label">Дата в периоде</label>
              <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
        }
      />

      {/* Ставки */}
      <div className="card mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="font-semibold text-slate-700">Ставки KPI</span>
            <span className="ml-3 text-slate-500">
              за консультацию: <b>{formatMoney(data?.rates.consultation ?? 0)}</b> · за операцию:{' '}
              <b>{formatMoney(data?.rates.operation ?? 0)}</b>
            </span>
          </div>
          {isAdmin && !editRates && (
            <button
              className="btn-ghost"
              onClick={() =>
                setEditRates({
                  consultation: String(data?.rates.consultation ?? 0),
                  operation: String(data?.rates.operation ?? 0),
                })
              }
            >
              Изменить ставки
            </button>
          )}
        </div>

        {editRates && (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
            <div>
              <label className="label">За консультацию</label>
              <div className="w-40">
                <MoneyInput
                  value={editRates.consultation}
                  onChange={(v) => setEditRates((s) => ({ ...s!, consultation: v }))}
                />
              </div>
            </div>
            <div>
              <label className="label">За операцию</label>
              <div className="w-40">
                <MoneyInput value={editRates.operation} onChange={(v) => setEditRates((s) => ({ ...s!, operation: v }))} />
              </div>
            </div>
            <button
              className="btn-primary"
              disabled={saveRates.isPending}
              onClick={() =>
                saveRates.mutate({
                  consultation: Number(editRates.consultation || 0),
                  operation: Number(editRates.operation || 0),
                })
              }
            >
              Сохранить
            </button>
            <button className="btn-ghost" onClick={() => setEditRates(null)}>
              Отмена
            </button>
          </div>
        )}
      </div>

      {isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Период</div>
              <div className="mt-1 text-xl font-bold">{data.label}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Консультаций</div>
              <div className="mt-1 text-xl font-bold">{formatNumber(data.totals.consultations)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Операций</div>
              <div className="mt-1 text-xl font-bold">{formatNumber(data.totals.operations)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Итого KPI</div>
              <div className="mt-1 text-xl font-bold text-emerald-600">{formatMoney(data.totals.amount)}</div>
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">Нет записей за выбранный период</div>
          ) : (
            <Table columns={columns} rows={rows} />
          )}
        </>
      )}
    </div>
  );
}
