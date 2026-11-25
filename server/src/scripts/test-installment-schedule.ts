/**
 * Тесты расчёта графика рассрочки (чистые функции, БД не нужна).
 * Эталон — образец «Приложение № 1»: 2 000 000, взнос 500 000, 9 мес., платежи 5-го числа.
 *
 * Запуск: npm run test:installment
 */
import { addMonthsUTC, almatyToday, buildSchedule, planState } from '../services/installment.service.js';

let failed = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = typeof got === 'number' && typeof want === 'number' ? Math.abs(got - want) < 0.005 : got === want;
  if (!ok) failed++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}: получили ${String(got)}, ожидали ${String(want)}`);
}
const day = (s: string) => new Date(s + 'T00:00:00.000Z');
const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

console.log('1. Образец: 2 000 000, взнос 500 000, 9 мес.');
const s9 = buildSchedule({ totalCost: 2_000_000, downPayment: 500_000, months: 9, contractDate: day('2026-12-01'), firstPaymentDate: day('2027-01-05') });
check('строк в графике', s9.length, 10);
check('взнос — в день договора', iso(s9[0].dueDate), '2026-12-01');
check('взнос', s9[0].amount, 500_000);
check('платёж 1 — дата', iso(s9[1].dueDate), '2027-01-05');
check('платёж 1 — сумма', s9[1].amount, 166_667);
check('платёж 8 — сумма', s9[8].amount, 166_667);
check('платёж 9 — дата', iso(s9[9].dueDate), '2027-09-05');
check('платёж 9 — остаток', s9[9].amount, 166_664);
check('итого по графику', s9.reduce((a, i) => a + i.amount, 0), 2_000_000);

console.log('2. Сроки 6 и 12 месяцев');
const s6 = buildSchedule({ totalCost: 1_800_000, downPayment: 600_000, months: 6, contractDate: day('2026-12-01'), firstPaymentDate: day('2027-01-05') });
check('6 мес.: платёж', s6[1].amount, 200_000);
check('6 мес.: последний', s6[6].amount, 200_000);
check('6 мес.: итого', s6.reduce((a, i) => a + i.amount, 0), 1_800_000);
const s12 = buildSchedule({ totalCost: 2_000_000, downPayment: 500_000, months: 12, contractDate: day('2026-12-01'), firstPaymentDate: day('2027-01-05') });
check('12 мес.: платёж', s12[1].amount, 125_000);
check('12 мес.: последняя дата', iso(s12[12].dueDate), '2027-12-05');
check('12 мес.: итого', s12.reduce((a, i) => a + i.amount, 0), 2_000_000);

console.log('3. Конец месяца');
check('31.01 + 1 мес.', iso(addMonthsUTC(day('2027-01-31'), 1)), '2027-02-28');
check('31.01 + 2 мес.', iso(addMonthsUTC(day('2027-01-31'), 2)), '2027-03-31');
check('31.01.2028 + 1 мес. (високосный)', iso(addMonthsUTC(day('2028-01-31'), 1)), '2028-02-29');
check('05.11 + 2 мес. (через год)', iso(addMonthsUTC(day('2026-11-05'), 2)), '2027-01-05');

console.log('4. Недопустимые параметры');
const throws = (label: string, patch: Record<string, unknown>) => {
  let ok = false;
  try {
    buildSchedule({ totalCost: 2_000_000, downPayment: 500_000, months: 9, contractDate: day('2026-12-01'), firstPaymentDate: day('2027-01-05'), ...patch });
  } catch {
    ok = true;
  }
  check(label, ok, true);
};
throws('срок 7 мес.', { months: 7 });
throws('взнос 0', { downPayment: 0 });
throws('взнос = стоимости', { downPayment: 2_000_000 });
throws('стоимость 0', { totalCost: 0 });
throws('первый платёж раньше договора', { firstPaymentDate: day('2026-11-05') });

console.log('5. Состояние графика по оплатам');
const today = day('2027-02-05');
const st0 = planState(s9, [], today);
check('без оплат: оплачено', st0.paid, 0);
check('без оплат: просрочено строк (взнос, платёж 1)', st0.overdueCount, 2);
check('без оплат: ближайшая строка — взнос', st0.nextDue?.seq, 0);

const pays = [
  { id: 1, amount: 500_000, date: day('2026-12-01'), direction: 'payment' },
  { id: 2, amount: 166_667, date: day('2027-01-04'), direction: 'payment' },
  { id: 3, amount: 100_000, date: day('2027-02-03'), direction: 'payment' },
];
const st = planState(s9, pays, today);
check('оплачено', st.paid, 766_667);
check('остаток', st.balance, 1_233_333);
check('взнос — оплачен', st.items[0].status, 'paid');
check('взнос — дата оплаты', iso(st.items[0].paidDate!), '2026-12-01');
check('платёж 1 — оплачен', st.items[1].status, 'paid');
check('платёж 1 — дата оплаты', iso(st.items[1].paidDate!), '2027-01-04');
check('платёж 2 — частично', st.items[2].status, 'partial');
check('платёж 2 — внесено', st.items[2].paidAmount, 100_000);
check('платёж 2 — срок сегодня', st.items[2].daysLeft, 0);
check('платёж 2 — не просрочен (срок сегодня)', st.items[2].overdue, false);
check('ближайший платёж — осталось внести', st.nextDue?.amount, 66_667);
check('рассрочка не погашена', st.closed, false);

const stRefund = planState(s9, [...pays, { id: 4, amount: 300_000, date: day('2027-02-04'), direction: 'refund' }], today);
check('после возврата: оплачено', stRefund.paid, 466_667);
check('после возврата: взнос снова не закрыт', stRefund.items[0].status, 'partial');

const full = planState(s9, [{ id: 1, amount: 2_000_000, date: day('2026-12-01'), direction: 'payment' }], today);
check('полная оплата: погашена', full.closed, true);
check('полная оплата: ближайшего платежа нет', full.nextDue, null);

console.log('6. «Сегодня» по Алматы');
check('23:30 UTC 04.02 → 05.02 в Алматы', iso(almatyToday(new Date('2027-02-04T23:30:00.000Z'))), '2027-02-05');
check('18:59 UTC 04.02 → 04.02 в Алматы', iso(almatyToday(new Date('2027-02-04T18:59:00.000Z'))), '2027-02-04');

console.log(failed ? `\n❌ Провалено проверок: ${failed}` : '\n✅ Все проверки пройдены');
process.exit(failed ? 1 : 0);
