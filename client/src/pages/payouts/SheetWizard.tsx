import { useState } from 'react';
import { apiPost, ApiError } from '../../api/client';
import { Modal } from '../../components/ui';
import { PeriodSelect, usePayoutPeriod, type Period } from '../../components/PeriodSelect';

// Мастер создания ведомости (Э3-5). Шаги: тип и период → предпросмотр по врачам →
// создание черновика. Возвращает id созданной ведомости через onCreated.

interface PreviewGroup { payeeId: number; fio: string; operationsCount: number; accruedTotal: number; hasCorrections: boolean }
interface PreviewResult { groups: PreviewGroup[]; totalPayees: number; totalAccrued: number; warnings: string[] }

const KIND_BY_PERIOD: Record<Period['kind'], 'weekly' | 'monthly' | 'custom'> = { weekly: 'weekly', monthly: 'monthly', custom: 'custom' };
const fmtMoney = (v: number) => Number(v).toLocaleString('ru-RU');

export function SheetWizard({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [period, setPeriod] = usePayoutPeriod();
  const [step, setStep] = useState<1 | 2>(1);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filter = () => ({ kind: KIND_BY_PERIOD[period.kind], from: period.from, to: period.to });

  const doPreview = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await apiPost<PreviewResult>('/payouts/sheets/preview', filter());
      setPreview(r);
      setStep(2);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Не удалось получить предпросмотр');
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    setErr(null);
    setBusy(true);
    try {
      const sheet = await apiPost<{ id: number }>('/payouts/sheets', filter());
      reset();
      onCreated(sheet.id);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Не удалось создать черновик');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep(1);
    setPreview(null);
    setErr(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Новая ведомость" wide>
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label className="label">Период</label>
            <PeriodSelect value={period} onChange={setPeriod} />
            <p className="mt-1 text-xs text-slate-400">
              В ведомость попадают операции, ПРОВЕДЁННЫЕ и оплаченные на 100%, у которых дата права
              (что позже: дата операции или платёж, закрывший оплату) входит в период.
            </p>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={close}>Отмена</button>
            <button className="btn-primary" disabled={busy} onClick={doPreview}>{busy ? 'Загрузка…' : 'Далее — предпросмотр'}</button>
          </div>
        </div>
      )}

      {step === 2 && preview && (
        <div className="space-y-4">
          <div className="text-sm text-slate-600">
            Период: <b>{period.label}</b> · врачей: <b>{preview.totalPayees}</b> · итого начислено: <b>{fmtMoney(preview.totalAccrued)}</b>
          </div>
          {preview.warnings.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              {preview.warnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}
          {preview.groups.length === 0 ? (
            <div className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500">Свободных начислений за период нет.</div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-1">Врач</th>
                    <th className="py-1 text-right">Операций</th>
                    <th className="py-1 text-right">Начислено</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.groups.map((g) => (
                    <tr key={g.payeeId} className="border-b border-slate-50">
                      <td className="py-1 font-medium">{g.fio}{g.hasCorrections && <span className="ml-1 text-xs text-amber-600">±корр.</span>}</td>
                      <td className="py-1 text-right tabular-nums">{g.operationsCount}</td>
                      <td className="py-1 text-right tabular-nums">{fmtMoney(g.accruedTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-between gap-2">
            <button className="btn-ghost" onClick={() => setStep(1)}>← Назад</button>
            <button className="btn-primary" disabled={busy || preview.groups.length === 0} onClick={doCreate}>
              {busy ? 'Создание…' : 'Создать черновик'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
