import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../../api/client';
import { PageHeader, Spinner, EmptyState, Badge } from '../../components/ui';
import { SheetWizard } from './SheetWizard';

interface SheetLine { toPay: number; paidTotal: number }
interface Sheet {
  id: number;
  number: string;
  kind: 'weekly' | 'monthly' | 'custom' | 'adhoc';
  periodFrom: string | null;
  periodTo: string | null;
  status: 'draft' | 'approved' | 'paid';
  lines: SheetLine[];
}

const KIND: Record<string, string> = { weekly: 'Недельная', monthly: 'Месячная', custom: 'Произвольная', adhoc: 'Внеочередная' };
const STATUS: Record<string, { label: string; tone: 'slate' | 'amber' | 'green' }> = {
  draft: { label: 'Черновик', tone: 'slate' },
  approved: { label: 'Утверждена', tone: 'amber' },
  paid: { label: 'Выплачена', tone: 'green' },
};
const fmtMoney = (v: number) => Number(v).toLocaleString('ru-RU');
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '—');

export function Sheets() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [wizard, setWizard] = useState(false);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [recalcMsg, setRecalcMsg] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['payout-sheets'],
    queryFn: () => apiGet<{ items: Sheet[] }>('/payouts/sheets'),
  });
  const items = data?.items ?? [];

  // Пересчёт начислений по всем операциям (после настройки получателей и схем).
  // Генерирует начисления, которые попадут в ведомость.
  const recalc = async () => {
    setRecalcBusy(true);
    setRecalcMsg(null);
    try {
      const r = await apiPost<{ processed: number; accruals: number; errors: { message: string; count: number }[] }>('/payouts/recalculate', {});
      let msg = `Готово: обработано операций ${r.processed}, начислений ${r.accruals}.`;
      if (r.errors?.length) msg += ' Не посчитано — ' + r.errors.map((e) => `${e.message} (${e.count})`).join('; ');
      else msg += ' Теперь можно собрать ведомость.';
      setRecalcMsg(msg);
      qc.invalidateQueries({ queryKey: ['payout-sheets'] });
    } catch (x) {
      setRecalcMsg(x instanceof ApiError ? x.message : 'Не удалось пересчитать');
    } finally {
      setRecalcBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Ведомости выплат"
        subtitle="Сбор начислений по врачам за период, утверждение, удержания и выплаты."
        actions={
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={recalcBusy} onClick={recalc} title="Пересчитать начисления по всем операциям на основе получателей и схем">
              {recalcBusy ? 'Пересчёт…' : '↻ Пересчитать выплаты'}
            </button>
            <button className="btn-primary" onClick={() => setWizard(true)}>+ Ведомость</button>
          </div>
        }
      />

      {recalcMsg && <div className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">{recalcMsg}</div>}

      {isError ? (
        <EmptyState>Не удалось загрузить ведомости.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState>Ведомостей пока нет. Соберите первую по кнопке «Ведомость».</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2">Номер</th>
                <th className="px-3 py-2">Тип</th>
                <th className="px-3 py-2">Период</th>
                <th className="px-3 py-2">Статус</th>
                <th className="px-3 py-2 text-right">К выплате</th>
                <th className="px-3 py-2 text-right">Выплачено</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const toPay = s.lines.reduce((a, l) => a + Number(l.toPay), 0);
                const paid = s.lines.reduce((a, l) => a + Number(l.paidTotal), 0);
                return (
                  <tr key={s.id} className="cursor-pointer border-b border-slate-50 hover:bg-slate-50" onClick={() => nav(`/payouts/sheets/${s.id}`)}>
                    <td className="px-3 py-2 font-medium">{s.number}</td>
                    <td className="px-3 py-2">{KIND[s.kind] ?? s.kind}</td>
                    <td className="px-3 py-2">{s.periodFrom ? `${fmtDate(s.periodFrom)} — ${fmtDate(s.periodTo)}` : '—'}</td>
                    <td className="px-3 py-2"><Badge tone={STATUS[s.status]?.tone ?? 'slate'}>{STATUS[s.status]?.label ?? s.status}</Badge></td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(toPay)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(paid)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SheetWizard open={wizard} onClose={() => setWizard(false)} onCreated={(id) => { setWizard(false); nav(`/payouts/sheets/${id}`); }} />
    </div>
  );
}
