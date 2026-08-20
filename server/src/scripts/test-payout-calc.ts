/**
 * Golden-тесты расчётного ядра выплат (Э2-1). Числа берутся ТОЛЬКО из
 * docs/tests/fixtures-payout.json — авторитетного файла с проверенными значениями
 * из рабочей книги клиники. Подгонять код под другие числа нельзя.
 *
 * Проверяются Т1–Т4, Т6, Т7 (расчёт одной операции). Т5 (тариф анестезиолога) и
 * Т12 (событийный движок) — вне чистой функции calcPayout, проверяются на своих этапах.
 *
 * Запуск: npm run test:payout   (или npx tsx src/scripts/test-payout-calc.ts)
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { calcPayout, SYSTEM_COMPONENT_META, type CalcComponentInput, type CalcScheme } from '../services/payout-calc.service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtures = JSON.parse(readFileSync(path.join(root, 'docs/tests/fixtures-payout.json'), 'utf8'));
const rates = fixtures.acquiringRates;
const byId = (id: string) => fixtures.tests.find((t: Record<string, unknown>) => t.id === id);

const EPS = 0.005;
type FixtureComp = { code: string; enabled: boolean; stage?: string; useOwnValue?: boolean; value?: number };

function toComp(fc: FixtureComp): CalcComponentInput {
  const meta = SYSTEM_COMPONENT_META[fc.code];
  if (!meta) throw new Error(`Нет метаданных для компонента «${fc.code}»`);
  return {
    code: fc.code,
    label: meta.label,
    valueSource: meta.valueSource,
    direction: meta.direction,
    operationField: meta.operationField,
    stage: (fc.stage as CalcComponentInput['stage']) ?? 'before_share',
    enabled: fc.enabled,
    useOwnValue: fc.useOwnValue ?? false,
    value: fc.value ?? null,
  };
}

function toScheme(fs: Record<string, unknown>): CalcScheme {
  return {
    kind: fs.kind as CalcScheme['kind'],
    shareMode: fs.shareMode as CalcScheme['shareMode'],
    shareValue: (fs.shareValue as number) ?? null,
    shareBySource: fs.shareBySource as Record<string, number> | undefined,
    components: ((fs.components as FixtureComp[]) ?? []).map(toComp),
  };
}

function opOf(t: Record<string, unknown>) {
  const o = t.operation as Record<string, number | string>;
  return {
    cost: Number(o.cost),
    anesthesiaCost: Number(o.anesthesiaCost),
    implantsCost: Number(o.implantsCost),
    assistantCost: Number(o.assistantCost),
    zapis: (o.zapis as string) ?? null,
    opType: (o.opType as string) ?? null,
    dateOp: (o.dateOp as string) ?? null,
  };
}

// Построение входа calcPayout для конкретного теста (с учётом ссылок Т3→Т2, Т6→Т1).
function buildInput(id: string) {
  const t = byId(id);
  if (id === 'Т3') {
    const scheme = toScheme(byId('Т2').scheme); // «схема из Т2»
    return { operation: opOf(t), payments: t.payments, scheme, acquiringRates: rates, materialsFact: t.materialsFact ?? null, materialNorm: null };
  }
  if (id === 'Т6') {
    const t1 = byId('Т1');
    const scheme = toScheme(t1.scheme);
    for (const c of scheme.components) if (c.code === 'materials') c.enabled = false; // снята галочка
    return { operation: opOf(t1), payments: t1.payments, scheme, acquiringRates: rates, materialsFact: t1.materialsFact ?? null, materialNorm: null };
  }
  return { operation: opOf(t), payments: t.payments, scheme: toScheme(t.scheme), acquiringRates: rates, materialsFact: t.materialsFact ?? null, materialNorm: null };
}

let failed = 0;
function check(label: string, got: number, want: number, out: string[]) {
  const ok = Math.abs(got - want) < EPS;
  if (!ok) failed++;
  out.push(`   ${ok ? '✅' : '❌'} ${label}: получили ${got}, ожидали ${want}`);
}

console.log('=== Golden-тесты calcPayout (Э2-1) ===\n');
for (const id of ['Т1', 'Т2', 'Т3', 'Т4', 'Т6', 'Т7']) {
  const t = byId(id);
  const exp = t.expected as Record<string, unknown>;
  const out = calcPayout(buildInput(id) as Parameters<typeof calcPayout>[0]);
  const lines: string[] = [];
  check('base', out.base, Number(exp.base), lines);
  const expComps = (exp.components as Record<string, number>) ?? {};
  for (const [code, want] of Object.entries(expComps)) {
    const line = out.components.find((c) => c.code === code);
    check(`компонент ${code}`, line ? line.amount : NaN, want, lines);
  }
  // Выключенные компоненты не должны присутствовать (напр. materials в Т6).
  if (id === 'Т6' && out.components.some((c) => c.code === 'materials')) {
    failed++; lines.push('   ❌ materials не должен присутствовать (галочка снята)');
  }
  if (exp.baseForShare != null) check('baseForShare', out.baseForShare, Number(exp.baseForShare), lines);
  if (exp.sharePct != null) check('sharePct', out.sharePct, Number(exp.sharePct), lines);
  check('amountFull', out.amountFull, Number(exp.amountFull), lines);
  const testFail = lines.some((l) => l.includes('❌'));
  console.log(`${testFail ? '❌' : '✅'} ${id} — ${t.название}`);
  console.log(lines.join('\n'));
  console.log('');
}

if (failed) {
  console.error(`ПРОВАЛЕНО проверок: ${failed}`);
  process.exit(1);
} else {
  console.log('Все golden-тесты Э2-1 пройдены точно.');
  process.exit(0);
}
