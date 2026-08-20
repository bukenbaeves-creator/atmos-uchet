import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, Spinner, EmptyState, Badge } from '../../components/ui';
import { PatientField } from '../../components/PatientField';
import { OperationSelect } from '../../components/OperationSelect';

// Экран «Как посчитано» (Э2-5): пошаговый расчёт начислений по операции из calcTrace
// с подписью применённой версии схемы. Только администратор.

interface TraceLine { label: string; value?: number; note?: string }
interface ComponentLine { code: string; label: string; stage: string; direction: string; amount: number }
interface Accrual {
  id: number;
  payee: { id: number; fio: string } | null;
  eventDate: string;
  isCorrection: boolean;
  status: 'free' | 'locked' | 'paid' | 'cancelled';
  base: number;
  paidRatio: number;
  sharePct: number;
  amountFull: number;
  amount: number;
  components: ComponentLine[];
  calcTrace: TraceLine[];
  scheme: { name: string | null; version: number; validFrom: string | null };
}

const fmtMoney = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('ru-RU'));
const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '—');
const STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'blue' | 'slate' | 'red' }> = {
  free: { label: 'свободно', tone: 'green' },
  locked: { label: 'в ведомости', tone: 'amber' },
  paid: { label: 'выплачено', tone: 'blue' },
  cancelled: { label: 'аннулировано', tone: 'slate' },
};

export function AccrualTrace() {
  const [params] = useSearchParams();
  const paramOp = params.get('operationId');
  const [patientId, setPatientId] = useState<number | null>(null);
  const [opId, setOpId] = useState<number | null>(paramOp ? Number(paramOp) : null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['payout-accruals', opId],
    queryFn: () => apiGet<{ items: Accrual[] }>(`/payouts/accruals?operationId=${opId}`),
    enabled: opId != null,
  });
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Как посчитано"
        subtitle="Здесь видно, из чего сложилась выплата врачу по конкретной операции. Обычно сюда переходят по клику из реестра ведомости; можно и выбрать операцию вручную."
      />
      <div className="mb-4 grid grid-cols-1 gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <div>
          <label className="label">Пациент</label>
          <PatientField value={patientId} onChange={(v) => { setPatientId(v); setOpId(null); }} />
        </div>
        <div>
          <label className="label">Операция пациента</label>
          <OperationSelect patientId={patientId} value={opId} onChange={(v) => setOpId(v)} />
        </div>
      </div>

      {opId == null ? (
        <EmptyState>Выберите пациента и его операцию — покажем пошаговый расчёт начисления.</EmptyState>
      ) : isError ? (
        <EmptyState>Не удалось загрузить данные.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState>По этой операции начислений нет (нет схемы у участников или платежей).</EmptyState>
      ) : (
        <div className="space-y-4">
          {items.map((a) => (
            <div key={a.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-slate-800">
                  {a.payee?.fio ?? '—'}
                  {a.isCorrection && <span className="ml-2 text-xs text-amber-600">корректировка</span>}
                </div>
                <Badge tone={STATUS[a.status]?.tone ?? 'slate'}>{STATUS[a.status]?.label ?? a.status}</Badge>
              </div>
              <div className="mb-3 text-xs text-slate-500">
                Схема «{a.scheme.name ?? '—'}», версия {a.scheme.version}
                {a.scheme.validFrom ? `, действует с ${fmtDate(a.scheme.validFrom)}` : ''} · событие {fmtDate(a.eventDate)}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {a.calcTrace.map((t, i) => (
                      <tr key={i} className="border-b border-slate-50 last:border-0">
                        <td className="py-1 pr-4 text-slate-600">
                          {t.label}
                          {t.note ? <span className="ml-1 text-xs text-slate-400">({t.note})</span> : null}
                        </td>
                        <td className="py-1 text-right tabular-nums font-medium text-slate-800">{t.value != null ? fmtMoney(t.value) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span className="text-slate-500">Коэффициент оплаты: <b className="text-slate-800">{Math.round(a.paidRatio * 10000) / 100}%</b></span>
                <span className="text-slate-500">При 100%: <b className="text-slate-800">{fmtMoney(a.amountFull)}</b></span>
                <span className="text-slate-500">Начислено событием: <b className="text-emerald-700">{fmtMoney(a.amount)}</b></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
