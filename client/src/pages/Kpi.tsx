import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiGet, apiPut } from '../api/client';
import { formatMoney, formatNumber } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useDictionaries } from '../lib/dictionaries';
import { PageHeader, Spinner } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { MoneyInput } from '../components/MoneyInput';

const iso = (d: Date) => d.toISOString().slice(0, 10);

// Общий переключатель периода для всей страницы KPI.
function PeriodControl({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  const preset = (kind: 'week' | 'month' | 'quarter' | 'year') => {
    const n = new Date();
    if (kind === 'week') setFrom(iso(new Date(Date.now() - 6 * 86400000)));
    else if (kind === 'month') setFrom(iso(new Date(n.getFullYear(), n.getMonth(), 1)));
    else if (kind === 'quarter') setFrom(iso(new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1)));
    else setFrom(iso(new Date(n.getFullYear(), 0, 1)));
    setTo(iso(n));
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex rounded-lg bg-slate-100 p-0.5">
        {(['week', 'month', 'quarter', 'year'] as const).map((k) => (
          <button
            key={k}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-800"
            onClick={() => preset(k)}
          >
            {{ week: 'Неделя', month: 'Месяц', quarter: 'Квартал', year: 'Год' }[k]}
          </button>
        ))}
      </div>
      <div>
        <label className="label">С</label>
        <input type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div>
        <label className="label">По</label>
        <input type="date" className="input" value={to} min={from} max={iso(new Date())} onChange={(e) => setTo(e.target.value)} />
      </div>
    </div>
  );
}

// ================= Общая страница: качество сверху, вознаграждение снизу =================
export function Kpi() {
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));

  return (
    <div>
      <PageHeader
        title="KPI менеджеров"
        subtitle="Качество работы по итогам консультаций и вознаграждение по записям."
        actions={<PeriodControl from={from} to={to} setFrom={setFrom} setTo={setTo} />}
      />

      <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Качество работы</div>
      <QualityTab from={from} to={to} />

      <div className="my-8 border-t border-slate-200" />

      <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Вознаграждение</div>
      <RewardTab from={from} to={to} />
    </div>
  );
}

// ================= Вкладка «Вознаграждение» (денежный KPI) =================
interface Row {
  id: number;
  manager: string;
  consultations: number;
  operations: number;
  amount: number;
}
interface Report {
  label: string;
  rates: { consultation: number; operation: number };
  rows: Omit<Row, 'id'>[];
  totals: { consultations: number; operations: number; amount: number };
}

function RewardTab({ from, to }: { from: string; to: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['kpi-report', from, to],
    queryFn: () => apiGet<Report>(`/kpi/report?from=${from}&to=${to}`),
  });

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
                <MoneyInput value={editRates.consultation} onChange={(v) => setEditRates((s) => ({ ...s!, consultation: v }))} />
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
              onClick={() => saveRates.mutate({ consultation: Number(editRates.consultation || 0), operation: Number(editRates.operation || 0) })}
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

// ================= Вкладка «Качество» (мини-дашборд) =================
interface Target {
  green: number;
  yellow: number;
}
interface QSettings {
  timelinessHours: number;
  minResultLen: number;
  templateDays: number;
  conversionDays: number;
  targets: { quality: Target; timeliness: Target; conversion: Target };
}
interface QRow {
  id: number;
  manager: string;
  consultations: number;
  assessable: number;
  noHistory: number;
  timelyPct: number | null;
  qualityPct: number | null;
  conversionPct: number;
}
interface QReport {
  from: string;
  to: string;
  settings: QSettings;
  rows: Omit<QRow, 'id'>[];
  totals: { consultations: number; assessable: number; noHistory: number; timelyPct: number | null; qualityPct: number | null; conversionPct: number };
  pendingConversion: number;
}

const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`);
const tone = (v: number | null, t: Target) =>
  v == null ? 'text-slate-400' : v >= t.green ? 'text-emerald-600' : v >= t.yellow ? 'text-amber-600' : 'text-rose-600';
const barColor = (v: number | null, t: Target) => (v == null ? '#cbd5e1' : v >= t.green ? '#059669' : v >= t.yellow ? '#d97706' : '#e11d48');

function QualityTab({ from, to }: { from: string; to: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { data: dict } = useDictionaries();
  const [manager, setManager] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['kpi-quality', from, to, manager],
    queryFn: () => apiGet<QReport>(`/kpi/quality?from=${from}&to=${to}${manager ? `&manager=${encodeURIComponent(manager)}` : ''}`),
  });

  const rows: QRow[] = (data?.rows ?? []).map((r, i) => ({ ...r, id: i + 1 }));
  const t = data?.settings.targets;

  const columns: Column<QRow>[] = [
    { header: 'Менеджер', cell: (r) => <span className="font-medium">{r.manager}</span> },
    { header: 'Консультаций', align: 'right', cell: (r) => r.consultations },
    {
      header: 'Качество',
      align: 'right',
      cell: (r) => <span className={`font-semibold ${tone(r.qualityPct, t!.quality)}`}>{fmtPct(r.qualityPct)}</span>,
    },
    {
      header: 'Своевременность',
      align: 'right',
      cell: (r) => <span className={`font-semibold ${tone(r.timelyPct, t!.timeliness)}`}>{fmtPct(r.timelyPct)}</span>,
    },
    {
      header: 'Конверсия',
      align: 'right',
      cell: (r) => <span className={`font-semibold ${tone(r.conversionPct, t!.conversion)}`}>{fmtPct(r.conversionPct)}</span>,
    },
    {
      header: 'Без истории',
      align: 'right',
      cell: (r) => (r.noHistory ? <span className="text-slate-400">{r.noHistory}</span> : '—'),
    },
  ];

  const chartData = rows.filter((r) => r.qualityPct != null).map((r) => ({ manager: r.manager, value: r.qualityPct as number }));

  return (
    <div>
      {/* Фильтр по менеджеру (период — общий, вверху страницы) */}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label className="label">Менеджер</label>
          <select className="input" value={manager} onChange={(e) => setManager(e.target.value)}>
            <option value="">Все</option>
            {dict?.manager?.map((m) => (
              <option key={m.id} value={m.label}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {isAdmin && (
          <button className="btn-ghost ml-auto" onClick={() => setShowSettings((v) => !v)}>
            ⚙️ Настройки
          </button>
        )}
      </div>

      {isAdmin && showSettings && <SettingsPanel settings={data?.settings} onSaved={() => qc.invalidateQueries({ queryKey: ['kpi-quality'] })} />}

      {isLoading || !data || !t ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <QualityTile label="Качественные итоги" value={fmtPct(data.totals.qualityPct)} target={t.quality} pct={data.totals.qualityPct} />
            <QualityTile label="Своевременность" value={fmtPct(data.totals.timelyPct)} target={t.timeliness} pct={data.totals.timelyPct} />
            <QualityTile label="Конверсия в операцию" value={fmtPct(data.totals.conversionPct)} target={t.conversion} pct={data.totals.conversionPct} />
          </div>

          {/* Пояснения по данным */}
          {(data.totals.noHistory > 0 || data.pendingConversion > 0) && (
            <div className="mb-3 space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-200">
              {data.totals.noHistory > 0 && (
                <div>
                  • {data.totals.noHistory} консультаций без истории аудита — не учтены в качестве и своевременности (итог заносился до
                  внедрения журнала или импортом).
                </div>
              )}
              {data.pendingConversion > 0 && (
                <div>
                  • По {data.pendingConversion} консультациям окно конверсии ({data.settings.conversionDays} дн.) ещё не закрыто — показатель
                  может вырасти.
                </div>
              )}
            </div>
          )}

          {rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">Нет состоявшихся консультаций за выбранный период</div>
          ) : (
            <>
              <Table columns={columns} rows={rows} />
              {chartData.length > 0 && (
                <div className="card mt-5">
                  <div className="mb-2 text-sm font-semibold text-slate-700">Качественные итоги по менеджерам, %</div>
                  <ResponsiveContainer width="100%" height={Math.max(160, chartData.length * 44)}>
                    <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} unit="%" />
                      <YAxis type="category" dataKey="manager" width={90} />
                      <Tooltip formatter={(v: number) => `${v}%`} />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                        {chartData.map((d, i) => (
                          <Cell key={i} fill={barColor(d.value, t.quality)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function QualityTile({ label, value, target, pct }: { label: string; value: string; target: Target; pct: number | null }) {
  return (
    <div className="card">
      <div className="text-xs uppercase text-slate-400">{label}</div>
      <div className={`mt-1 text-3xl font-bold ${tone(pct, target)}`}>{value}</div>
      <div className="text-xs text-slate-400">
        цель ≥ {target.green}% · норма ≥ {target.yellow}%
      </div>
    </div>
  );
}

// Панель настроек дашборда (только админ)
function SettingsPanel({ settings, onSaved }: { settings?: QSettings; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const cur = form ?? (settings ? flatten(settings) : null);

  const save = useMutation({
    mutationFn: (body: Record<string, number>) => apiPut('/kpi/settings', body),
    onSuccess: () => {
      setForm(null);
      onSaved();
    },
  });

  if (!cur) return null;
  const set = (k: string, v: string) => setForm({ ...cur, [k]: v });
  const num = (k: string) => (
    <input type="number" min={0} className="input" value={cur[k]} onChange={(e) => set(k, e.target.value)} />
  );

  return (
    <div className="card mb-4">
      <div className="mb-3 text-sm font-semibold text-slate-700">Настройки дашборда качества</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label">Срок итога, часов</label>
          {num('kpi_timeliness_hours')}
        </div>
        <div>
          <label className="label">Мин. длина итога</label>
          {num('kpi_min_result_len')}
        </div>
        <div>
          <label className="label">Окно шаблонности, дн.</label>
          {num('kpi_template_days')}
        </div>
        <div>
          <label className="label">Окно конверсии, дн.</label>
          {num('kpi_conversion_days')}
        </div>
        <div>
          <label className="label">Качество: зелёный / жёлтый %</label>
          <div className="flex gap-2">
            {num('kpi_target_quality_green')}
            {num('kpi_target_quality_yellow')}
          </div>
        </div>
        <div>
          <label className="label">Своевременность: зел. / жёлт. %</label>
          <div className="flex gap-2">
            {num('kpi_target_timeliness_green')}
            {num('kpi_target_timeliness_yellow')}
          </div>
        </div>
        <div>
          <label className="label">Конверсия: зел. / жёлт. %</label>
          <div className="flex gap-2">
            {num('kpi_target_conversion_green')}
            {num('kpi_target_conversion_yellow')}
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="btn-primary"
          disabled={save.isPending}
          onClick={() => save.mutate(Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Number(v)])))}
        >
          Сохранить настройки
        </button>
        {form && (
          <button className="btn-ghost" onClick={() => setForm(null)}>
            Сбросить
          </button>
        )}
      </div>
    </div>
  );
}

function flatten(s: QSettings): Record<string, string> {
  return {
    kpi_timeliness_hours: String(s.timelinessHours),
    kpi_min_result_len: String(s.minResultLen),
    kpi_template_days: String(s.templateDays),
    kpi_conversion_days: String(s.conversionDays),
    kpi_target_quality_green: String(s.targets.quality.green),
    kpi_target_quality_yellow: String(s.targets.quality.yellow),
    kpi_target_timeliness_green: String(s.targets.timeliness.green),
    kpi_target_timeliness_yellow: String(s.targets.timeliness.yellow),
    kpi_target_conversion_green: String(s.targets.conversion.green),
    kpi_target_conversion_yellow: String(s.targets.conversion.yellow),
  };
}
