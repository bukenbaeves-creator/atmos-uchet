/**
 * Тест смысла значения компонентов (доработка конструктора):
 *  - operation_field (наркоз/импланты/медсестра): вписана сумма → фикс; пусто → из операции;
 *  - pct_of_base (налог): «после доли» → % от доли врача; «до доли» → % от базы.
 * Чистый расчёт (без БД).
 *
 * Запуск: npm run test:components
 */
import { calcPayout, SYSTEM_COMPONENT_META, type CalcComponentInput, type CalcScheme } from '../services/payout-calc.service.js';

let failed = 0;
const check = (label: string, cond: boolean, extra = '') => {
  if (!cond) failed++;
  console.log(`   ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};

function comp(code: string, over: Partial<CalcComponentInput> = {}): CalcComponentInput {
  const m = SYSTEM_COMPONENT_META[code];
  return { code, label: m.label, valueSource: m.valueSource, direction: m.direction, operationField: m.operationField, stage: 'before_share', enabled: true, useOwnValue: false, value: null, ...over };
}
function calc(components: CalcComponentInput[], op: Record<string, number>, shareValue = 0.5) {
  const scheme: CalcScheme = { kind: 'share_based', shareMode: 'constant', shareValue, components };
  return calcPayout({
    operation: { cost: op.cost, anesthesiaCost: op.anesthesiaCost ?? 0, implantsCost: op.implantsCost ?? 0, assistantCost: op.assistantCost ?? 0, zapis: 'X', opType: 'Y', dateOp: '2026-01-01' },
    payments: [{ amount: (op.cost ?? 0) + (op.anesthesiaCost ?? 0), terminal: 'Наличные', date: '2026-01-01', direction: 'payment' }],
    scheme,
    acquiringRates: [],
    materialsFact: null,
    materialNorm: null,
  });
}
const amt = (out: ReturnType<typeof calc>, code: string) => out.components.find((c) => c.code === code)?.amount;

console.log('=== Наркоз/медсестра: фикс из схемы, если вписана сумма ===');
const anesFix = calc([comp('anesthesia', { useOwnValue: true, value: 250000, stage: 'before_share' })], { cost: 900000, anesthesiaCost: 100000 });
check('наркоз с суммой 250 000 → фикс 250 000 (не из операции 100 000)', amt(anesFix, 'anesthesia') === 250000);
const anesOp = calc([comp('anesthesia', { useOwnValue: false, stage: 'before_share' })], { cost: 900000, anesthesiaCost: 100000 });
check('наркоз без суммы → из операции (100 000)', amt(anesOp, 'anesthesia') === 100000);

console.log('\n=== Импланты: из карточки операции, если сумма не вписана ===');
const implOp = calc([comp('implants', { useOwnValue: false, stage: 'before_share' })], { cost: 1000000, implantsCost: 700000 });
check('импланты без суммы → из операции (700 000)', amt(implOp, 'implants') === 700000);
const implFix = calc([comp('implants', { useOwnValue: true, value: 500000, stage: 'before_share' })], { cost: 1000000, implantsCost: 700000 });
check('импланты с суммой 500 000 → фикс 500 000', amt(implFix, 'implants') === 500000);

console.log('\n=== Налог: стадия решает базу процента ===');
const taxAfter = calc([comp('operation_tax', { useOwnValue: true, value: 3, stage: 'after_share' })], { cost: 100 }, 0.5);
check('налог 3% «после доли» → 1.5 (от доли 50)', amt(taxAfter, 'operation_tax') === 1.5, String(amt(taxAfter, 'operation_tax')));
check('итог = 48.5 (50 − 1.5)', taxAfter.amountFull === 48.5, String(taxAfter.amountFull));
const taxBefore = calc([comp('operation_tax', { useOwnValue: true, value: 4, stage: 'before_share' })], { cost: 100 }, 0.5);
check('налог 4% «до доли» → 4 (от базы 100)', amt(taxBefore, 'operation_tax') === 4);
check('итог = 48 ((100 − 4) × 0.5)', taxBefore.amountFull === 48);

if (failed) {
  console.error(`\nПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
}
console.log('\nТест компонентов (фикс-суммы, налог от доли) пройден.');
process.exit(0);
