import { Fragment, useState } from 'react';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
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
  byDoctorMonth: DoctorMonth;
}

// Выручка по врачам помесячно: суммы по врачам в каждом месяце и итог месяца.
interface DoctorMonth {
  doctors: string[];
  rows: { month: string; total: number; values: Record<string, number> }[];
  totals: { total: number; values: Record<string, number> };
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

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// «2026-11» → «Ноябрь 2026»
const monthLabel = (key: string) => {
  const [y, m] = key.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
};
// «2026-11» → «ноя 26» (подпись оси графика)
const monthShort = (key: string) => {
  const [y, m] = key.split('-');
  return `${(MONTHS[Number(m) - 1] ?? m).slice(0, 3).toLowerCase()} ${y.slice(2)}`;
};
// Доля в выручке месяца; при нулевой или отрицательной выручке доля не имеет смысла.
const sharePct = (value: number, total: number) => (total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—');

function DoctorMonthCard({ data }: { data: DoctorMonth }) {
  const { doctors, rows, totals } = data;
  if (rows.length === 0) {
    return (
      <div className="card">
        <div className="text-sm font-semibold text-slate-700">Выручка по врачам помесячно</div>
        <div className="mt-3 text-sm text-slate-400">За выбранный период платежей нет.</div>
      </div>
    );
  }
  const chartData = rows.map((r) => ({ month: r.month, ...r.values }));
  const thousands = (v: number) => Math.round(v / 1000).toLocaleString('ru-RU');
  // Подпись внутри сегмента столбца: «сумма в тыс. (доля %)». Если сегмент слишком
  // низкий или узкий, подпись сокращается до суммы либо не выводится — точные цифры
  // остаются в таблице ниже и во всплывающей подсказке.
  const segmentLabel = (doctor: string) => (props: unknown) => {
    const { x, y, width, height, index } = props as { x: number; y: number; width: number; height: number; index: number };
    const row = rows[index];
    const value = row?.values[doctor] ?? 0;
    if (!row || value <= 0 || height < 13) return null;
    const sum = thousands(value);
    const pct = row.total > 0 ? `(${Math.round((value / row.total) * 100)}%)` : '';
    const full = pct ? `${sum} ${pct}` : sum;
    // Оценка ширины текста: ~0.54 размера шрифта на символ (полужирные цифры).
    const fits = (t: string, size: number) => t.length * size * 0.54 <= width - 2;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const common = { textAnchor: 'middle' as const, fontWeight: 600, fill: '#fff', pointerEvents: 'none' as const };
    const oneLine = (t: string, size: number) => (
      <text x={cx} y={cy} dominantBaseline="central" fontSize={size} {...common}>
        {t}
      </text>
    );
    if (fits(full, 10)) return oneLine(full, 10);
    // Не помещается в ширину столбца — доля уходит на вторую строку.
    if (pct && height >= 27 && fits(sum, 10)) {
      return (
        <text x={cx} fontSize={10} {...common}>
          <tspan x={cx} y={cy - 6} dominantBaseline="central">
            {sum}
          </tspan>
          <tspan x={cx} y={cy + 6} dominantBaseline="central" fontWeight={500}>
            {pct}
          </tspan>
        </text>
      );
    }
    if (fits(full, 8.5)) return oneLine(full, 8.5);
    return fits(sum, 10) ? oneLine(sum, 10) : null;
  };
  // Итог месяца над столбцом (в тыс.).
  const totalLabel = (props: unknown) => {
    const { x, y, width, index } = props as { x: number; y: number; width: number; index: number };
    const row = rows[index];
    if (!row || row.total <= 0) return null;
    return (
      <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={11} fontWeight={700} fill="#334155" pointerEvents="none">
        {thousands(row.total)}
      </text>
    );
  };
  const cell = (value: number, total: number, bold = false) => (
    <td className={`px-3 py-1.5 text-right tabular-nums ${bold ? 'font-semibold' : ''}`}>
      {value === 0 ? (
        <span className="text-slate-300">—</span>
      ) : (
        <>
          <div className={value < 0 ? 'text-rose-600' : ''}>{formatMoney(value)}</div>
          <div className="text-xs font-normal text-slate-400">{sharePct(value, total)}</div>
        </>
      )}
    </td>
  );
  return (
    <div className="card">
      <div className="text-sm font-semibold text-slate-700">Выручка по врачам помесячно</div>
      <div className="mb-3 text-xs text-slate-400">
        Платежи Кассы по дате платежа и врачу, указанному в платеже; возвраты вычитаются. На графике — сумма в тыс. и доля врача
        в выручке месяца, над столбцом — итог месяца в тыс.
      </div>
      <div style={{ height: 460 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 22, right: 8, left: 0, bottom: 0 }} barCategoryGap="12%">
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="month" tickFormatter={monthShort} tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={(v) => `${(v / 1_000_000).toFixed(1)}М`} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number) => formatMoney(v)} labelFormatter={(m) => monthLabel(String(m))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {doctors.map((d, i) => (
              <Bar key={d} dataKey={d} stackId="doctors" fill={COLORS[i % COLORS.length]} isAnimationActive={false}>
                <LabelList content={segmentLabel(d) as never} />
                {i === doctors.length - 1 && <LabelList content={totalLabel as never} />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="px-3 py-1.5 text-left font-medium">Месяц</th>
              {doctors.map((d, i) => (
                <th key={d} className="whitespace-nowrap px-3 py-1.5 text-right font-medium">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                  {d}
                </th>
              ))}
              <th className="px-3 py-1.5 text-right font-medium">Итого</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month} className="border-b border-slate-50 align-top hover:bg-slate-50">
                <td className="whitespace-nowrap px-3 py-1.5 font-medium text-slate-700">{monthLabel(r.month)}</td>
                {doctors.map((d) => (
                  <Fragment key={d}>{cell(r.values[d] ?? 0, r.total)}</Fragment>
                ))}
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{formatMoney(r.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50 align-top">
              <td className="px-3 py-1.5 font-semibold">Итого за период</td>
              {doctors.map((d) => (
                <Fragment key={d}>{cell(totals.values[d] ?? 0, totals.total, true)}</Fragment>
              ))}
              <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{formatMoney(totals.total)}</td>
            </tr>
          </tfoot>
        </table>
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

          <DoctorMonthCard data={data.byDoctorMonth} />
        </div>
      )}
    </div>
  );
}
