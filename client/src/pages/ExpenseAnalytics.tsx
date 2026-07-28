import { useState } from 'react';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiGet } from '../api/client';
import { formatNumber } from '../lib/format';
import { PageHeader, Spinner, EmptyState } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { useAuth } from '../lib/auth';

interface Row {
  id: number;
  patient: string;
  opType: string;
  positions: number;
  qty: number;
  cost?: number;
  materials: string;
}
interface AnalyticsData {
  metric: 'cost' | 'qty';
  kpi: { writeoffs: number; patients: number; totalQty: number; totalCost?: number };
  topPatients: { name: string; qty: number; cost?: number }[];
  rows: Omit<Row, 'id'>[];
}

const COLORS = ['#3b62d6', '#22a06b', '#e0a000', '#d9534f', '#7b61ff', '#0ea5b7', '#e06c9a', '#6b7280', '#f97316', '#14b8a6'];

const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'month', label: 'Месяц', range: () => [dayjs().startOf('month').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'quarter', label: 'Квартал', range: () => [dayjs().startOf('month').subtract(2, 'month').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'year', label: 'Год', range: () => [dayjs().startOf('year').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'all', label: 'Всё время', range: () => ['', ''] },
];

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 text-2xl font-bold ${tone ?? 'text-slate-800'}`}>{value}</div>
    </div>
  );
}

export function ExpenseAnalytics() {
  const { isAdmin } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState('all');
  const [search, setSearch] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['expense-analytics', from, to],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return apiGet<AnalyticsData>(`/expense-analytics${qs.toString() ? `?${qs}` : ''}`);
    },
  });

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    const [f, t] = p.range();
    setFrom(f);
    setTo(t);
    setPreset(p.key);
  };

  const metricKey = data?.metric ?? (isAdmin ? 'cost' : 'qty');
  const metricLabel = metricKey === 'cost' ? 'Себестоимость' : 'Количество';

  const allRows: Row[] = (data?.rows ?? []).map((r, i) => ({ ...r, id: i + 1 }));
  const rows = search.trim() ? allRows.filter((r) => r.patient.toLowerCase().includes(search.trim().toLowerCase())) : allRows;

  const columns: Column<Row>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patient}</span> },
    { header: 'Вид операции', cell: (r) => r.opType },
    { header: 'Позиций', align: 'right', cell: (r) => formatNumber(r.positions) },
    { header: 'Кол-во расхода', align: 'right', cell: (r) => formatNumber(r.qty) },
    ...(isAdmin ? [{ header: 'Себестоимость', align: 'right' as const, cell: (r: Row) => formatNumber(r.cost ?? 0) }] : []),
    { header: 'Материалы', cell: (r) => <span className="text-xs text-slate-500">{r.materials}</span> },
  ];

  const topPatients = (data?.topPatients ?? []).map((p) => ({ name: p.name, value: (metricKey === 'cost' ? p.cost : p.qty) ?? 0 }));

  return (
    <div>
      <PageHeader
        title="Аналитика расхода"
        subtitle={
          isAdmin
            ? 'Расход материалов и себестоимость по пациентам с указанием вида операции.'
            : 'Расход материалов по пациентам с указанием вида операции (без стоимости).'
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button key={p.key} className={preset === p.key ? 'btn-primary' : 'btn-ghost'} onClick={() => applyPreset(p)}>
            {p.label}
          </button>
        ))}
        <input type="date" className="input max-w-[150px]" value={from} onChange={(e) => { setFrom(e.target.value); setPreset(''); }} />
        <span className="text-slate-400">—</span>
        <input type="date" className="input max-w-[150px]" value={to} onChange={(e) => { setTo(e.target.value); setPreset(''); }} />
      </div>

      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading || !data ? (
        <Spinner />
      ) : data.kpi.writeoffs === 0 ? (
        <EmptyState>За выбранный период списаний нет.</EmptyState>
      ) : (
        <div className="space-y-4">
          <div className={`grid grid-cols-2 gap-4 ${isAdmin ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
            <StatCard label="Списаний" value={formatNumber(data.kpi.writeoffs)} />
            <StatCard label="Пациентов" value={formatNumber(data.kpi.patients)} />
            <StatCard label="Кол-во расхода" value={formatNumber(data.kpi.totalQty)} />
            {isAdmin && data.kpi.totalCost != null && (
              <StatCard label="Себестоимость" value={formatNumber(data.kpi.totalCost)} tone="text-rose-600" />
            )}
          </div>

          {topPatients.length > 1 && (
            <div className="card">
              <div className="mb-2 text-sm font-semibold text-slate-700">Топ пациентов по расходу ({metricLabel.toLowerCase()})</div>
              <ResponsiveContainer width="100%" height={Math.max(160, topPatients.length * 34)}>
                <BarChart data={topPatients} layout="vertical" margin={{ left: 20, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 12 }} />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => formatNumber(v)} />
                  <Bar dataKey="value" name={metricLabel} radius={[0, 4, 4, 0]}>
                    {topPatients.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-700">Расходы по пациентам</div>
              <input
                className="input max-w-xs"
                placeholder="Поиск по пациенту…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {rows.length === 0 ? (
              <EmptyState>По запросу ничего не найдено.</EmptyState>
            ) : (
              <Table columns={columns} rows={rows} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
