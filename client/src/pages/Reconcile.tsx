import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiUpload, ApiError } from '../api/client';
import { formatDate, formatMoney } from '../lib/format';
import { PageHeader, Spinner, Badge } from '../components/ui';

interface BankRow {
  date: string | null;
  amount: number;
  description: string;
}
interface SysPay {
  id: number;
  date: string | null;
  amount: number;
  patient: string;
}
interface Result {
  toleranceDays: number;
  summary: {
    bankCount: number;
    bankTotal: number;
    matchedCount: number;
    matchedTotal: number;
    unmatchedBankCount: number;
    unmatchedBankTotal: number;
    unmatchedSystemCount: number;
    unmatchedSystemTotal: number;
  };
  matched: { bank: BankRow; payment: SysPay }[];
  unmatchedBank: BankRow[];
  unmatchedSystem: SysPay[];
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-bold ${tone ?? 'text-slate-800'}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

export function Reconcile() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [tolerance, setTolerance] = useState(2);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('toleranceDays', String(tolerance));
      const r = await apiUpload<Result>('/reconcile', fd);
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось обработать файл');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Сверка с банком"
        subtitle="Загрузите выписку из интернет-банка (Excel/CSV) — сверим реальные поступления с внесёнными платежами."
      />

      <div className="card mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="label">Файл выписки (.xlsx, .xls, .csv)</label>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              className="block text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div>
            <label className="label">Допуск по дате, дней</label>
            <input
              type="number"
              className="input w-28"
              min={0}
              max={30}
              value={tolerance}
              onChange={(e) => setTolerance(Number(e.target.value))}
            />
          </div>
          <button className="btn-primary" disabled={!file || busy} onClick={run}>
            {busy ? 'Обработка…' : 'Сверить'}
          </button>
        </div>
        <div className="mt-2 text-xs text-slate-400">
          Сопоставление по сумме и дате (± допуск). Нужны столбцы с датой и суммой поступления; остальное определяется
          автоматически.
        </div>
        {error && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      </div>

      {busy && <Spinner label="Разбираем выписку и сверяем…" />}

      {result && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat
              label="Строк в выписке"
              value={String(result.summary.bankCount)}
              sub={formatMoney(result.summary.bankTotal)}
            />
            <Stat
              label="Совпало"
              value={String(result.summary.matchedCount)}
              sub={formatMoney(result.summary.matchedTotal)}
              tone="text-emerald-600"
            />
            <Stat
              label="В банке, нет в системе"
              value={String(result.summary.unmatchedBankCount)}
              sub={formatMoney(result.summary.unmatchedBankTotal)}
              tone="text-rose-600"
            />
            <Stat
              label="В системе, нет в банке"
              value={String(result.summary.unmatchedSystemCount)}
              sub={formatMoney(result.summary.unmatchedSystemTotal)}
              tone="text-amber-600"
            />
          </div>

          {/* Есть в банке, нет в системе — деньги пришли, но не занесены */}
          <div className="card">
            <div className="mb-3 flex items-center gap-2">
              <Badge tone="red">Деньги пришли — не занесены</Badge>
              <span className="text-sm text-slate-500">{result.unmatchedBank.length} шт.</span>
            </div>
            {result.unmatchedBank.length === 0 ? (
              <div className="text-sm text-slate-400">Нет — все поступления учтены ✔</div>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="py-1.5">Дата</th>
                    <th className="py-1.5">Сумма</th>
                    <th className="py-1.5">Назначение</th>
                    <th className="py-1.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.unmatchedBank.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1.5">{formatDate(r.date)}</td>
                      <td className="py-1.5 font-semibold tabular-nums">{formatMoney(r.amount)}</td>
                      <td className="py-1.5 text-slate-500">{r.description || '—'}</td>
                      <td className="py-1.5 text-right">
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => navigate('/cashbox')}>
                          Внести в кассу →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Есть в системе, нет в банке — занесли, но реально денег нет */}
          <div className="card">
            <div className="mb-3 flex items-center gap-2">
              <Badge tone="amber">Занесено — нет в банке</Badge>
              <span className="text-sm text-slate-500">{result.unmatchedSystem.length} шт.</span>
            </div>
            {result.unmatchedSystem.length === 0 ? (
              <div className="text-sm text-slate-400">Нет — все внесённые платежи подтверждены выпиской ✔</div>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="py-1.5">Дата</th>
                    <th className="py-1.5">Сумма</th>
                    <th className="py-1.5">Пациент</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {result.unmatchedSystem.map((p) => (
                    <tr key={p.id}>
                      <td className="py-1.5">{formatDate(p.date)}</td>
                      <td className="py-1.5 font-semibold tabular-nums">{formatMoney(p.amount)}</td>
                      <td className="py-1.5">{p.patient}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Совпавшие */}
          <details className="card">
            <summary className="cursor-pointer text-sm font-semibold text-slate-700">
              Совпавшие платежи ({result.matched.length})
            </summary>
            <table className="mt-3 min-w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-400">
                <tr>
                  <th className="py-1.5">Дата (банк)</th>
                  <th className="py-1.5">Сумма</th>
                  <th className="py-1.5">Пациент (система)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.matched.map((m, i) => (
                  <tr key={i}>
                    <td className="py-1.5">{formatDate(m.bank.date)}</td>
                    <td className="py-1.5 tabular-nums">{formatMoney(m.bank.amount)}</td>
                    <td className="py-1.5 text-slate-500">{m.payment.patient}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </div>
  );
}
