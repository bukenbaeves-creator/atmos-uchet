import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, payoutSheetExportUrl, payoutActUrl, ApiError } from '../../api/client';
import { PageHeader, Spinner, EmptyState, Badge, Modal } from '../../components/ui';
import { ExportButton } from '../../components/ExportButton';

interface Withholding { type: string; amount: number; comment?: string | null }
interface Payment { id: number; date: string; amount: number; channel: string; note: string | null }
interface Line {
  id: number;
  payee: { id: number; fio: string } | null;
  payeeId: number;
  operationsCount: number;
  accruedTotal: number;
  withholdings: Withholding[];
  toPay: number;
  paidTotal: number;
  payments: Payment[];
}
interface Accrual { id: number; payeeId: number; payee: { fio: string } | null; operationId: number; amount: number; isCorrection: boolean }
interface SheetData {
  id: number;
  number: string;
  kind: string;
  periodFrom: string | null;
  periodTo: string | null;
  status: 'draft' | 'approved' | 'paid';
  lines: Line[];
  accruals: Accrual[];
}

const KIND: Record<string, string> = { weekly: 'Недельная', monthly: 'Месячная', custom: 'Произвольная', adhoc: 'Внеочередная' };
const STATUS: Record<string, { label: string; tone: 'slate' | 'amber' | 'green' }> = {
  draft: { label: 'Черновик', tone: 'slate' },
  approved: { label: 'Утверждена', tone: 'amber' },
  paid: { label: 'Выплачена', tone: 'green' },
};
const fmtMoney = (v: number) => Number(v).toLocaleString('ru-RU');
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '—');
const sum = (a: { amount: number }[]) => a.reduce((s, x) => s + Number(x.amount), 0);

export function Sheet() {
  const { id } = useParams();
  const sheetId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [withhLine, setWithhLine] = useState<Line | null>(null);
  const [payLine, setPayLine] = useState<Line | null>(null);
  const [dissolveOpen, setDissolveOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['payout-sheet', sheetId],
    queryFn: () => apiGet<SheetData>(`/payouts/sheets/${sheetId}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['payout-sheet', sheetId] });
    qc.invalidateQueries({ queryKey: ['payout-sheets'] });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      refresh();
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Операция не удалась');
    } finally {
      setBusy(false);
    }
  };

  if (isError) return <EmptyState>Не удалось загрузить ведомость.</EmptyState>;
  if (isLoading || !data) return <Spinner />;
  const s = data;
  const hasPayments = s.lines.some((l) => l.payments.length > 0);

  // Для черновика строк ещё нет — показываем сгруппированные начисления.
  const draftGroups = () => {
    const by = new Map<number, { fio: string; ops: Set<number>; total: number; corr: boolean }>();
    for (const a of s.accruals) {
      let g = by.get(a.payeeId);
      if (!g) { g = { fio: a.payee?.fio ?? `#${a.payeeId}`, ops: new Set(), total: 0, corr: false }; by.set(a.payeeId, g); }
      g.ops.add(a.operationId);
      g.total += Number(a.amount);
      if (a.isCorrection) g.corr = true;
    }
    return [...by.entries()].map(([payeeId, g]) => ({ payeeId, fio: g.fio, operationsCount: g.ops.size, total: g.total, corr: g.corr }));
  };

  return (
    <div>
      <PageHeader
        title={`Ведомость ${s.number}`}
        subtitle={`${KIND[s.kind] ?? s.kind}${s.periodFrom ? ` · ${fmtDate(s.periodFrom)} — ${fmtDate(s.periodTo)}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={STATUS[s.status]?.tone ?? 'slate'}>{STATUS[s.status]?.label ?? s.status}</Badge>
            {s.status !== 'draft' && <ExportButton url={payoutSheetExportUrl(sheetId)} filename={`vedomost-${s.number}.xlsx`} label="Выгрузить в Excel" />}
            <button className="btn-ghost" onClick={() => nav('/payouts/sheets')}>К списку</button>
          </div>
        }
      />

      {err && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

      <div className="mb-4 flex flex-wrap gap-2">
        {s.status === 'draft' && (
          <button className="btn-primary" disabled={busy} onClick={() => run(() => apiPost(`/payouts/sheets/${sheetId}/approve`, {}))}>
            Утвердить
          </button>
        )}
        {s.status !== 'paid' && !hasPayments && (
          <button className="btn-ghost" disabled={busy} onClick={() => setDissolveOpen(true)}>Распустить</button>
        )}
      </div>

      {s.status === 'draft' ? (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2">Врач</th>
                <th className="px-3 py-2 text-right">Операций</th>
                <th className="px-3 py-2 text-right">Начислено</th>
              </tr>
            </thead>
            <tbody>
              {draftGroups().map((g) => (
                <tr key={g.payeeId} className="border-b border-slate-50">
                  <td className="px-3 py-2 font-medium">{g.fio}{g.corr && <span className="ml-1 text-xs text-amber-600">±корр.</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{g.operationsCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(g.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2">Врач</th>
                <th className="px-3 py-2 text-right">Операций</th>
                <th className="px-3 py-2 text-right">Начислено</th>
                <th className="px-3 py-2 text-right">Удержания</th>
                <th className="px-3 py-2 text-right">К выплате</th>
                <th className="px-3 py-2 text-right">Выплачено</th>
                <th className="px-3 py-2 text-right">Остаток</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => {
                const debt = Number(l.toPay) - Number(l.paidTotal);
                return (
                  <tr key={l.id} className="border-b border-slate-50">
                    <td className="px-3 py-2 font-medium">{l.payee?.fio ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.operationsCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.accruedTotal)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(sum(l.withholdings))}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtMoney(l.toPay)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(l.paidTotal)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${debt > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>{fmtMoney(debt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => nav(`/payouts/sheets/${sheetId}/registry/${l.payeeId}`)}>Реестр</button>
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => window.open(payoutActUrl(sheetId, l.id), '_blank')}>Акт</button>
                        {s.status === 'approved' && (
                          <>
                            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setWithhLine(l)}>Удержания</button>
                            <button className="btn-primary px-2 py-1 text-xs" onClick={() => setPayLine(l)}>Выплата</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Роспуск */}
      <Modal open={dissolveOpen} onClose={() => setDissolveOpen(false)} title="Роспуск ведомости">
        <DissolveForm
          busy={busy}
          onCancel={() => setDissolveOpen(false)}
          onSubmit={(reason) =>
            run(async () => {
              await apiPost(`/payouts/sheets/${sheetId}/dissolve`, { reason });
              setDissolveOpen(false);
              nav('/payouts/sheets');
            })
          }
        />
      </Modal>

      {/* Удержания */}
      <Modal open={withhLine != null} onClose={() => setWithhLine(null)} title={`Удержания · ${withhLine?.payee?.fio ?? ''}`}>
        {withhLine && (
          <WithholdingsForm
            line={withhLine}
            busy={busy}
            onCancel={() => setWithhLine(null)}
            onSubmit={(rows) =>
              run(async () => {
                await apiPatch(`/payouts/sheets/${sheetId}/lines/${withhLine.id}/withholdings`, { withholdings: rows });
                setWithhLine(null);
              })
            }
          />
        )}
      </Modal>

      {/* Выплата */}
      <Modal open={payLine != null} onClose={() => setPayLine(null)} title={`Выплата · ${payLine?.payee?.fio ?? ''}`}>
        {payLine && (
          <PaymentForm
            debt={Number(payLine.toPay) - Number(payLine.paidTotal)}
            busy={busy}
            onCancel={() => setPayLine(null)}
            onSubmit={(p) =>
              run(async () => {
                await apiPost(`/payouts/sheets/${sheetId}/lines/${payLine.id}/payments`, p);
                setPayLine(null);
              })
            }
          />
        )}
      </Modal>
    </div>
  );
}

function DissolveForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }} className="space-y-3">
      <p className="text-sm text-slate-600">Начисления вернутся в свободные, ведомость будет удалена. Действие доступно только при отсутствии выплат.</p>
      <div>
        <label className="label">Причина роспуска</label>
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>Отмена</button>
        <button className="btn-primary" disabled={busy || !reason.trim()}>Распустить</button>
      </div>
    </form>
  );
}

function WithholdingsForm({ line, busy, onCancel, onSubmit }: { line: Line; busy: boolean; onCancel: () => void; onSubmit: (rows: Withholding[]) => void }) {
  const [rows, setRows] = useState<Withholding[]>(line.withholdings.length ? line.withholdings : []);
  const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(rows.filter((r) => r.type.trim() && r.amount)); }} className="space-y-3">
      <div className="text-sm text-slate-500">Начислено: {fmtMoney(line.accruedTotal)} · к выплате станет {fmtMoney(Number(line.accruedTotal) - total)}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2">
          <input className="input flex-1" placeholder="тип (напр. налог)" value={r.type} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} />
          <input type="number" step="any" className="input w-32" placeholder="сумма" value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} />
          <button type="button" className="btn-ghost px-2" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="btn-ghost text-sm" onClick={() => setRows([...rows, { type: '', amount: 0 }])}>+ удержание</button>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>Отмена</button>
        <button className="btn-primary" disabled={busy}>Сохранить</button>
      </div>
    </form>
  );
}

function PaymentForm({ debt, busy, onCancel, onSubmit }: { debt: number; busy: boolean; onCancel: () => void; onSubmit: (p: { date: string; amount: number; channel: string; note: string | null }) => void }) {
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState(String(debt > 0 ? debt : ''));
  const [channel, setChannel] = useState('на расчётный счёт');
  const [note, setNote] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit({ date, amount: Number(amount), channel, note: note || null }); }} className="space-y-3">
      <div className="text-sm text-slate-500">Остаток долга: <b className="text-slate-700">{fmtMoney(debt)}</b></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label">Дата выплаты</label><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
        <div><label className="label">Сумма</label><input type="number" step="any" min={0} className="input" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
      </div>
      <div><label className="label">Канал</label>
        <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option>на расчётный счёт</option>
          <option>наличные</option>
          <option>перевод Kaspi</option>
        </select>
      </div>
      <div><label className="label">Примечание</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>Отмена</button>
        <button className="btn-primary" disabled={busy}>Зафиксировать выплату</button>
      </div>
    </form>
  );
}
