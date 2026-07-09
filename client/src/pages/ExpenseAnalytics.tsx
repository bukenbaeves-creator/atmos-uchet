import { useState } from 'react';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiGet } from '../api/client';
import { formatNumber } from '../lib/format';
import { PageHeader, Spinner, EmptyState } from '../components/ui';
import { useAuth } from '../lib/auth';

interface Bucket {
  name: string;
  qty: number;
  cost?: number;
}
interface AnalyticsData {
  kpi: { writeoffs: number; positions: number; totalQty: number; totalCost?: number };
  byCategory: Bucket[];
  byNomenclature: Bucket[];
  byPatient: Bucket[];
  byMonth: { month: string; qty: number; cost?: number }[];
}

const COLORS = ['#3b62d6', '#22a06b', '#e0a000', '#d9534f', '#7b61ff', '#0ea5b7', '#e06c9a', '#6b7280', '#f97316', '#14b8a6'];

const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'week', label: '7 дней', range: () => [dayjs().subtract(6, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'month', label: 'Месяц', range: () => [dayjs().startOf('month').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
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

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="mb-3 text-sm font-semibold text-slate-700">{title}</div>
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          {children as never}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function ExpenseAnalytics() {
  const { isAdmin } = useAuth();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState('all');

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

  return (
    <div>
      <PageHeader
        title="Аналитика расхода"
        subtitle={isAdmin ? 'Расход материалов и себестоимость за период.' : 'Расход материалов за период (без стоимости).'}
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
            <StatCard label="Позиций" value={formatNumber(data.kpi.positions)} />
            <StatCard label="Кол-во расхода" value={formatNumber(data.kpi.totalQty)} />
            {isAdmin && data.kpi.totalCost != null && (
              <StatCard label="Себестоимость" value={formatNumber(data.kpi.totalCost)} tone="text-rose-600" />
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="Расход по категориям (количество)">
              <BarChart data={data.byCategory}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="qty" name="Количество" radius={[4, 4, 0, 0]}>
                  {data.byCategory.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ChartCard>

            <ChartCard title="Динамика расхода по месяцам">
              <LineChart data={data.byMonth}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="qty" name="Количество" stroke="#3b62d6" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartCard>

            <ChartCard title="Топ-10 позиций по расходу">
              <BarChart layout="vertical" data={data.byNomenclature} margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="qty" name="Количество" fill="#22a06b" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartCard>

            <ChartCard title="Топ-10 пациентов по расходу">
              <BarChart layout="vertical" data={data.byPatient} margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="qty" name="Количество" fill="#7b61ff" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartCard>

            {isAdmin && (
              <ChartCard title="Себестоимость по категориям">
                <BarChart data={data.byCategory}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="cost" name="Себестоимость" fill="#d9534f" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartCard>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
