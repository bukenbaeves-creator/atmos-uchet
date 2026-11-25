import { formatDate, formatMoney } from '../lib/format';
import {
  INSTALLMENT_MONTHS,
  defaultFirstPaymentDate,
  previewSchedule,
  type InstallmentValue,
} from '../lib/installment';
import { MoneyInput } from './MoneyInput';

// Поля рассрочки клиники + автоматически рассчитанный график платежей.
// Пользователь вводит взнос, срок и даты — остальное считается само.
export function InstallmentFields({
  totalCost,
  value,
  onChange,
}: {
  totalCost: number; // стоимость услуг: операция + наркоз
  value: InstallmentValue;
  onChange: (v: InstallmentValue) => void;
}) {
  const set = <K extends keyof InstallmentValue>(k: K, val: InstallmentValue[K]) => onChange({ ...value, [k]: val });
  const preview = previewSchedule(totalCost, value);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label">Первоначальный взнос *</label>
          <MoneyInput value={value.downPayment} onChange={(v) => set('downPayment', v)} />
        </div>
        <div>
          <label className="label">Срок рассрочки *</label>
          <div className="flex gap-1">
            {INSTALLMENT_MONTHS.map((m) => (
              <button
                key={m}
                type="button"
                className={`${value.months === m ? 'btn-primary' : 'btn-ghost'} flex-1 px-2`}
                onClick={() => set('months', m)}
              >
                {m} мес.
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Дата договора *</label>
          <input
            type="date"
            className="input"
            value={value.contractDate}
            onChange={(e) => {
              // Пока пользователь не менял дату первого платежа вручную — двигаем её следом.
              const auto = value.firstPaymentDate === defaultFirstPaymentDate(value.contractDate);
              onChange({
                ...value,
                contractDate: e.target.value,
                firstPaymentDate: auto && e.target.value ? defaultFirstPaymentDate(e.target.value) : value.firstPaymentDate,
              });
            }}
          />
        </div>
        <div>
          <label className="label">Дата первого платежа *</label>
          <input type="date" className="input" value={value.firstPaymentDate} onChange={(e) => set('firstPaymentDate', e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div>
          <div className="label">Стоимость услуг</div>
          <div className="text-sm font-semibold tabular-nums">{formatMoney(totalCost || 0)}</div>
        </div>
        <div>
          <div className="label">Сумма рассрочки</div>
          <div className="text-sm font-semibold tabular-nums">{preview.error ? '—' : formatMoney(preview.financed)}</div>
        </div>
        <div>
          <div className="label">Ежемесячный платёж</div>
          <div className="text-sm font-semibold tabular-nums text-brand-700">{preview.error ? '—' : formatMoney(preview.monthly)}</div>
        </div>
        <div>
          <label className="label">№ договора</label>
          <input
            className="input"
            placeholder="присвоится автоматически"
            value={value.contractNumber}
            onChange={(e) => set('contractNumber', e.target.value)}
          />
        </div>
      </div>

      {preview.error ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">{preview.error}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-center">№</th>
                <th className="px-3 py-2 text-left">Дата платежа (не позднее)</th>
                <th className="px-3 py-2 text-right">Сумма платежа</th>
                <th className="px-3 py-2 text-right">Остаток после платежа</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preview.items.map((i) => (
                <tr key={i.seq}>
                  <td className="px-3 py-1.5 text-center text-slate-500">{i.seq}</td>
                  <td className="px-3 py-1.5">
                    {formatDate(i.dueDate)}
                    {i.seq === 0 && <span className="ml-2 text-xs italic text-slate-400">первоначальный взнос</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(i.amount)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{formatMoney(i.rest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
