import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { apiGet } from '../../api/client';
import { PageHeader, Spinner } from '../../components/ui';
import { PeriodSelect, usePayoutPeriod } from '../../components/PeriodSelect';

// Дашборд выплат (Э5-2). Блоки: KPI, «кто сколько заработал и должны», динамика,
// сигналы. Период — общий для модуля (usePayoutPeriod). Только администратор.

interface Summary { accrued: number; toPay: number; paid: number; debt: number; revenue: number; shareOfRevenuePct: number }
interface DoctorRow { payeeId: number; fio: string; accrued: number; toPay: number; paid: number; debt: number }
interface TrendRow { month: string; accrued: number; paid: number }
interface Signal { type: string; label: string; count: number; items: { id: number; fio: string }[] }

const fmtMoney = (v: number) => Number(v).toLocaleString('ru-RU');

function Tile({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent ?? 'text-slate-800'}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function PayoutDashboard() {
  const nav = useNavigate();
  const [period, setPeriod] = usePayoutPeriod();
  const qp = `from=${period.from}&to=${period.to}`;

  const summary = useQuery({ queryKey: ['payout-dash-summary', qp], queryFn: () => apiGet<Summary>(`/payouts/dashboard/summary?${qp}`) });
  const doctors = useQuery({ queryKey: ['payout-dash-share', qp], queryFn: () => apiGet<{ items: DoctorRow[] }>(`/payouts/dashboard/share?${qp}`) });
  const trend = useQuery({ queryKey: ['payout-dash-trend', qp], queryFn: () => apiGet<{ items: TrendRow[] }>(`/payouts/dashboard/trend?${qp}`) });
  const signals = useQuery({ queryKey: ['payout-dash-signals'], queryFn: () => apiGet<{ items: Signal[] }>(`/payouts/dashboard/signals`) });

  const s = summary.data;

  return (
    <div>
      <PageHeader title="Дашборд выплат" subtitle="Начисления, выплаты, долг и доля выплат в выручке за период." />

      <div className="mb-4 max-w-md">
        <label className="label">Период</label>
        <PeriodSelect value={period} onChange={setPeriod} />
      </div>

      {summary.isLoading || !s ? (
        <Spinner />
      ) : (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Tile label="Начислено" value={fmtMoney(s.accrued)} />
          <Tile label="К выплате" value={fmtMoney(s.toPay)} />
          <Tile label="Выплачено" value={fmtMoney(s.paid)} />
          <Tile label="Остаток долга" value={fmtMoney(s.debt)} accent={s.debt > 0 ? 'text-rose-600' : 'text-emerald-600'} hint="к выплате минус выплачено" />
          <Tile label="Доля выплат в выручке" value={`${s.shareOfRevenuePct}%`} hint={`выручка ${fmtMoney(s.revenue)} ₸`} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Кто сколько заработал и сколько должны */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 text-sm font-semibold text-slate-700">Кто сколько заработал и сколько должны</div>
          {doctors.isLoading ? (
            <Spinner />
          ) : (doctors.data?.items ?? []).length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-400">Нет утверждённых ведомостей за период.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-1">Врач</th>
                    <th className="py-1 text-right">Начислено</th>
                    <th className="py-1 text-right">К выплате</th>
                    <th className="py-1 text-right">Выплачено</th>
                    <th className="py-1 text-right">Долг</th>
                  </tr>
                </thead>
                <tbody>
                  {(doctors.data?.items ?? []).map((d) => (
                    <tr key={d.payeeId} className="cursor-pointer border-b border-slate-50 hover:bg-slate-50" onClick={() => nav('/payouts/sheets')} title="К ведомостям">
                      <td className="py-1 font-medium">{d.fio}</td>
                      <td className="py-1 text-right tabular-nums">{fmtMoney(d.accrued)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtMoney(d.toPay)}</td>
                      <td className="py-1 text-right tabular-nums">{fmtMoney(d.paid)}</td>
                      <td className={`py-1 text-right tabular-nums ${d.debt > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>{fmtMoney(d.debt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Динамика по месяцам */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 text-sm font-semibold text-slate-700">Динамика по месяцам</div>
          {trend.isLoading ? (
            <Spinner />
          ) : (trend.data?.items ?? []).length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-400">Нет данных за период.</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={trend.data?.items ?? []} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="month" fontSize={12} />
                <YAxis fontSize={12} tickFormatter={(v) => (v >= 1e6 ? `${Math.round(v / 1e5) / 10}М` : String(v))} />
                <Tooltip formatter={(v: number) => fmtMoney(v)} />
                <Legend />
                <Line type="monotone" dataKey="accrued" name="Начислено" stroke="#6366f1" strokeWidth={2} />
                <Line type="monotone" dataKey="paid" name="Выплачено" stroke="#10b981" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Сигналы и проблемы */}
      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="mb-3 text-sm font-semibold text-slate-700">Сигналы и проблемы</div>
        {signals.isLoading ? (
          <Spinner />
        ) : (signals.data?.items ?? []).length === 0 ? (
          <div className="py-4 text-center text-sm text-emerald-600">Проблем не обнаружено.</div>
        ) : (
          <ul className="space-y-2">
            {(signals.data?.items ?? []).map((sig) => (
              <li key={sig.type} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <b>{sig.label}</b> — {sig.count}
                {sig.items.length > 0 && <span className="text-amber-700">: {sig.items.map((i) => i.fio).join(', ')}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
