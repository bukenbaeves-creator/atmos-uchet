import dayjs from 'dayjs';

// Рассрочка клиники: расчёт графика для МГНОВЕННОГО предпросмотра в форме.
// Копия серверной buildSchedule (server/src/services/installment.service.ts) —
// сохранённый график всегда считает сервер, здесь только подсказка пользователю.

export const INSTALLMENT_MONTHS = [6, 9, 12] as const;

export interface InstallmentValue {
  downPayment: string; // сумма строкой — как отдаёт MoneyInput
  months: number;
  contractDate: string; // YYYY-MM-DD
  firstPaymentDate: string; // YYYY-MM-DD
  contractNumber: string; // пусто → номер присвоит сервер
}

export interface PreviewItem {
  seq: number;
  dueDate: string; // YYYY-MM-DD
  amount: number;
  rest: number; // остаток после платежа
}

export interface Preview {
  items: PreviewItem[];
  financed: number;
  monthly: number;
  error: string | null;
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

// Дата первого платежа по умолчанию: 5-е число месяца, следующего за датой договора.
export const defaultFirstPaymentDate = (contractDate: string): string =>
  dayjs(contractDate || undefined).add(1, 'month').date(5).format('YYYY-MM-DD');

export const emptyInstallment = (): InstallmentValue => {
  const today = dayjs().format('YYYY-MM-DD');
  return { downPayment: '', months: 9, contractDate: today, firstPaymentDate: defaultFirstPaymentDate(today), contractNumber: '' };
};

export function previewSchedule(totalCost: number, v: InstallmentValue): Preview {
  const total = round2(totalCost || 0);
  const down = round2(Number(v.downPayment) || 0);
  const months = Number(v.months);
  const fail = (error: string): Preview => ({ items: [], financed: 0, monthly: 0, error });
  if (!(total > 0)) return fail('Укажите стоимость операции — график рассчитается автоматически');
  if (!(down > 0)) return fail('Укажите первоначальный взнос');
  if (!(down < total)) return fail('Первоначальный взнос должен быть меньше стоимости услуг');
  if (!v.contractDate) return fail('Укажите дату договора');
  if (!v.firstPaymentDate) return fail('Укажите дату первого платежа');
  if (v.firstPaymentDate < v.contractDate) return fail('Дата первого платежа не может быть раньше даты договора');

  const financed = round2(total - down);
  const monthly = Math.ceil(financed / months - 1e-9);
  const last = round2(financed - monthly * (months - 1));
  if (!(last > 0)) return fail('Сумма рассрочки слишком мала для выбранного срока');

  let rest = financed;
  const items: PreviewItem[] = [{ seq: 0, dueDate: v.contractDate, amount: down, rest }];
  const first = dayjs(v.firstPaymentDate);
  for (let k = 1; k <= months; k++) {
    const amount = k < months ? monthly : last;
    rest = round2(rest - amount);
    // dayjs.add('month') прижимает 29–31 число к концу короткого месяца — как сервер и EDATE.
    items.push({ seq: k, dueDate: first.add(k - 1, 'month').format('YYYY-MM-DD'), amount, rest });
  }
  return { items, financed, monthly, error: null };
}

// Тело запроса для сервера (поле installment операции или POST /installments).
export const installmentPayload = (v: InstallmentValue) => ({
  downPayment: Number(v.downPayment) || 0,
  months: Number(v.months),
  contractDate: v.contractDate,
  firstPaymentDate: v.firstPaymentDate,
  contractNumber: v.contractNumber.trim() || null,
});
