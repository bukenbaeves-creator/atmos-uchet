import { useState } from 'react';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiGet } from '../api/client';
import { formatMoney, formatNumber } from '../lib/format';
import { PageHeader, Spinner } from '../components/ui';

interface DashboardData {
  kpi: { revenue: number; operations: number; consultations: number; conversion: number };
  revenueByMonth: { month: string; value: number }[];
  byPayMethod: { name: string; value: number }[];
  funnel: { stage: string; count: number }[];
  byDoctor: { name: string; value: number }[];
}

const COLORS = ['#3b62d6', '#22a06b', '#e0a000', '#d9534f', '#7b61ff', '#0ea5b7', '#e06c9a', '#6b7280', '#f97316', '#14b8a6'];

function StatCard({ label, value, tone, icon }: { label: string; value: string; tone?: string; icon?: string }) {
  return (
    <div className="card flex items-center gap-3">
      {icon && <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-xl">{icon}</div>}
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
        <div className={`mt-0.5 text-2xl font-bold ${tone ?? 'text-slate-800'}`}>{value}</div>
      </div>
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

const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'today', label: 'Сегодня', range: () => [dayjs().format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'week', label: '7 дней', range: () => [dayjs().subtract(6, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'month', label: 'Месяц', range: () => [dayjs().startOf('month').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'year', label: 'Год', range: () => [dayjs().startOf('year').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')] },
  { key: 'all', label: 'Всё время', range: () => ['', ''] },
];

export function Dashboard() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preset, setPreset] = useState('all');

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', from, to],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      return apiGet<DashboardData>(`/reports/dashboard${qs.toString() ? `?${qs}` : ''}`);
    },
  });

  return (
    <div>
      <PageHeader
        title="Дашборд"
        subtitle="Ежедневная сводка по клинике ATMOS"
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex rounded-lg bg-slate-100 p-0.5">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    preset === p.key ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                  onClick={() => {
                    const [f, t] = p.range();
                    setFrom(f);
                    setTo(t);
                    setPreset(p.key);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div>
              <label className="label">С</label>
              <input
                type="date"
                className="input"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPreset('');
                }}
              />
            </div>
            <div>
              <label className="label">По</label>
              <input
                type="date"
                className="input"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPreset('');
                }}
              />
            </div>
          </div>
        }
      />

      {isLoading || !data ? (
        <Spinner />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Выручка (касса)" value={formatMoney(data.kpi.revenue)} tone="text-emerald-600" icon="💰" />
            <StatCard label="Операций" value={formatNumber(data.kpi.operations)} icon="🩺" />
            <StatCard label="Консультаций" value={formatNumber(data.kpi.consultations)} icon="🗒️" />
            <StatCard
              label="Конверсия в оплату"
              value={`${(data.kpi.conversion * 100).toFixed(1)}%`}
              tone="text-brand-600"
              icon="📈"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="Выручка по месяцам">
              <BarChart data={data.revenueByMonth}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `${(v / 1_000_000).toFixed(1)}М`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => formatMoney(v)} />
                <Bar dataKey="value" name="Выручка" fill="#3b62d6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>

            <ChartCard title="Способы оплаты">
              <PieChart>
                <Pie data={data.byPayMethod} dataKey="value" nameKey="name" outerRadius={90} label={false}>
                  {data.byPayMethod.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => formatMoney(v)} />
              </PieChart>
            </ChartCard>

            <ChartCard title="Воронка по стадиям">
              <BarChart data={data.funnel} layout="vertical" margin={{ left: 20 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="stage" width={160} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="count" name="Консультаций" fill="#22a06b" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartCard>

            <ChartCard title="Выручка по врачам">
              <BarChart data={data.byDoctor}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(v) => `${(v / 1_000_000).toFixed(1)}М`} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => formatMoney(v)} />
                <Bar dataKey="value" name="Выручка" fill="#e0a000" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>
          </div>
        </div>
      )}
    </div>
  );
}
