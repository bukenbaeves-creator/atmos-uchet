import { round2 } from './compute.js';
import { badRequest } from '../lib/http.js';
import { TERMINAL_METHOD } from '../constants.js';

// ===================== Чистая функция расчёта выплаты (Э2-1) =====================
// Без обращения к БД: всё приходит параметрами — функция полностью тестируема.
// Порядок расчёта (из «$соглашения» фикстур):
//   base        = operation.cost + operation.anesthesiaCost
//   amountFull  = (base − Σ компонентов before_share) × доля − Σ компонентов after_share
// Комиссия эквайринга — по каждому платежу × ставка терминала на дату платежа.
// Округление round2 только на итоговых значениях; промежуточные не округляем.

export type CalcStage = 'before_share' | 'after_share';
export type ComponentDirection = 'deduction' | 'addition';
export type ComponentValueSource =
  | 'fixed'
  | 'pct_of_base'
  | 'pct_of_payments'
  | 'operation_field'
  | 'warehouse_fact'
  | 'warehouse_or_norm'
  | 'table_by_source'
  | 'table_by_op_type'
  | 'manual'
  | 'per_day';

export interface CalcComponentInput {
  code: string;
  label?: string;
  valueSource: ComponentValueSource;
  direction: ComponentDirection;
  operationField?: string | null; // для operation_field: имя поля операции
  stage: CalcStage;
  enabled: boolean;
  useOwnValue?: boolean;
  value?: number | null; // процент или сумма — в зависимости от источника
  // Режим значения: card — из карточки операции, fixed — фикс из схемы, table — по таблице
  // «вид операции → сумма» (ComponentTableValue). Для table_by_op_type по умолчанию table.
  mode?: 'card' | 'fixed' | 'table';
}

export interface CalcOperation {
  cost: number;
  anesthesiaCost: number;
  implantsCost: number;
  assistantCost: number;
  zapis?: string | null;
  opType?: string | null;
  dateOp?: string | null;
}

export interface CalcPayment {
  amount: number;
  terminal: string | null;
  date: string; // YYYY-MM-DD
  direction?: 'payment' | 'refund';
  payMethod?: string | null; // «Через терминал» — единственный способ с комиссией банка
}

export interface AcquiringRateInput {
  terminal: string;
  ratePct: number;
  validFrom: string; // YYYY-MM-DD
}

export interface CalcScheme {
  kind: 'share_based' | 'tariff_based';
  shareMode?: 'constant' | 'by_source' | 'by_op_type';
  shareValue?: number | null;
  shareBySource?: Record<string, number>;
  shareByOpType?: Record<string, number>;
  components: CalcComponentInput[];
}

export interface CalcInput {
  operation: CalcOperation;
  payments: CalcPayment[];
  scheme: CalcScheme;
  acquiringRates: AcquiringRateInput[];
  materialsFact: number | null;
  materialNorm: number | null;
  // Таблицы «вид операции → сумма» по коду компонента (наркоз, седация, …).
  opTypeTables?: Record<string, Record<string, number>>;
}

export interface ComponentLine {
  code: string;
  label: string;
  stage: CalcStage;
  direction: ComponentDirection;
  amount: number;
  // Для «Расходных материалов» (warehouse_or_norm): факт со склада, норматив из настроек
  // и какой из них попал в расчёт (берётся больший).
  detail?: { fact: number; norm: number; method: 'факт' | 'норматив' };
}

export interface TraceLine {
  label: string;
  value?: number;
  note?: string;
}

export interface CalcOutput {
  base: number;
  components: ComponentLine[];
  sharePct: number;
  baseForShare: number;
  amountFull: number;
  calcTrace: TraceLine[];
}

// Метаданные системных компонентов (совпадают с сидом PAYOUT_COMPONENTS). Позволяют
// собрать CalcComponentInput по одному коду — используется тестами и движком.
export const SYSTEM_COMPONENT_META: Record<
  string,
  { label: string; valueSource: ComponentValueSource; direction: ComponentDirection; operationField: string | null }
> = {
  acquiring: { label: 'Комиссия банка', valueSource: 'pct_of_payments', direction: 'deduction', operationField: null },
  anesthesia: { label: 'Наркоз / седация', valueSource: 'operation_field', direction: 'deduction', operationField: 'anesthesiaCost' },
  implants: { label: 'Импланты', valueSource: 'operation_field', direction: 'deduction', operationField: 'implantsCost' },
  materials: { label: 'Расходные материалы', valueSource: 'warehouse_or_norm', direction: 'deduction', operationField: null },
  assistant: { label: 'Медсестра / ассистент', valueSource: 'operation_field', direction: 'deduction', operationField: 'assistantCost' },
  operation_tax: { label: 'Налог с операции', valueSource: 'pct_of_base', direction: 'deduction', operationField: null },
  day_rent: { label: 'Аренда операционного дня', valueSource: 'per_day', direction: 'deduction', operationField: null },
  admin_bonus: { label: 'Бонус администратора', valueSource: 'table_by_source', direction: 'deduction', operationField: null },
};

const num = (v: unknown): number => (v == null ? 0 : Number(v));

// ---- Тарифы анестезиологов (Э6-1) ----
export interface AnesthesiaTariffInput {
  anesthesiaType: string;
  minCount: number;
  maxCount: number | null;
  amount: number;
}
// Ставка за операцию для данного типа наркоза и количества операций (ступень шкалы).
export function anesthesiaTariffRate(tariffs: AnesthesiaTariffInput[], type: string, count: number): number | null {
  const forType = tariffs.filter((t) => t.anesthesiaType === type);
  if (!forType.length) return null;
  const step = forType.find((t) => count >= t.minCount && (t.maxCount == null || count <= t.maxCount));
  return step ? Number(step.amount) : null;
}
// Нижняя ставка типа наркоза (применяется в недельных и произвольных ведомостях).
export function lowestAnesthesiaRate(tariffs: AnesthesiaTariffInput[], type: string): number | null {
  const forType = tariffs.filter((t) => t.anesthesiaType === type);
  if (!forType.length) return null;
  return Math.min(...forType.map((t) => Number(t.amount)));
}

// Ставка терминала, действующая на дату платежа: последняя запись с validFrom ≤ date.
// Отсутствие ставки — ошибка (а не молчаливый ноль), как требует «$соглашения».
export function resolveAcquiringRate(rates: AcquiringRateInput[], terminal: string | null, date: string): number {
  const applicable = rates
    .filter((r) => r.terminal === terminal && r.validFrom <= date)
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1));
  if (!applicable.length) {
    throw badRequest(`Не задана ставка эквайринга для терминала «${terminal ?? '—'}» на дату ${date}.`);
  }
  return applicable[0].ratePct;
}

// Доля врача по схеме и источнику записи операции.
function resolveShare(scheme: CalcScheme, op: CalcOperation): number {
  switch (scheme.shareMode) {
    case 'by_source': {
      const key = op.zapis ?? '';
      const share = scheme.shareBySource?.[key];
      if (share == null) throw badRequest(`Не задана доля врача для источника «${key || '—'}».`);
      return share;
    }
    case 'by_op_type': {
      const key = op.opType ?? '';
      const share = scheme.shareByOpType?.[key];
      if (share == null) throw badRequest(`Не задана доля врача для вида операции «${key || '—'}».`);
      return share;
    }
    default:
      return num(scheme.shareValue);
  }
}

interface Ctx {
  base: number;
  operation: CalcOperation;
  payments: CalcPayment[];
  totalPayments: number;
  terminalPayments: CalcPayment[]; // только «Через терминал» — облагаются комиссией
  terminalTotal: number;
  materialsFact: number | null;
  materialNorm: number | null;
  rates: AcquiringRateInput[];
  opTypeTables: Record<string, Record<string, number>>;
}

// Сумма из таблицы «вид операции → сумма» для компонента; вид не в таблице → 0.
const tableAmount = (ctx: Ctx, code: string): number => ctx.opTypeTables[code]?.[ctx.operation.opType ?? ''] ?? 0;

// Сумма одного компонента по его источнику значения.
// pctBase — база для «pct_of_base»: до доли это база начисления, после доли — сумма доли врача.
function componentAmount(c: CalcComponentInput, ctx: Ctx, pctBase: number): number {
  switch (c.valueSource) {
    case 'pct_of_payments':
      // useOwnValue → процент из value применяется ко ВСЕЙ сумме платежей (переопределение);
      // иначе — ставка терминала на дату по каждому платежу.
      // Комиссия — только с платежей «Через терминал» (наличные/на счёт/рассрочка — без).
      // Свой % схемы — единый процент на эти платежи вместо ставок терминалов.
      if (c.useOwnValue) return ctx.terminalTotal * (num(c.value) / 100);
      return ctx.terminalPayments.reduce(
        (s, p) => s + (p.terminal?.trim() ? p.amount * (resolveAcquiringRate(ctx.rates, p.terminal, p.date) / 100) : 0),
        0,
      );
    case 'pct_of_base':
      // «до доли» → % от базы; «после доли» → % от доли врача (pctBase подставляется вызовом).
      return pctBase * (num(c.value) / 100);
    case 'operation_field':
      // Режимы: по таблице видов операций / фикс из схемы / из карточки операции.
      if (c.mode === 'table') return tableAmount(ctx, c.code);
      return c.useOwnValue ? num(c.value) : num((ctx.operation as unknown as Record<string, unknown>)[c.operationField ?? '']);
    case 'warehouse_or_norm':
      return ctx.materialsFact ?? ctx.materialNorm ?? 0;
    case 'warehouse_fact':
      return ctx.materialsFact ?? 0;
    case 'per_day':
      return num(c.value);
    case 'table_by_source':
      // Таблица «источник → значение» вводится в схеме; в тестах — через useOwnValue.
      return num(c.value);
    case 'table_by_op_type':
      // Фикс из схемы (useOwnValue) либо таблица «вид операции → сумма».
      return c.useOwnValue ? num(c.value) : tableAmount(ctx, c.code);
    case 'fixed':
    case 'manual':
      return num(c.value);
    default:
      return 0;
  }
}

export function calcPayout(input: CalcInput): CalcOutput {
  const { operation, scheme } = input;
  const base = num(operation.cost) + num(operation.anesthesiaCost);
  const payments = input.payments.filter((p) => (p.direction ?? 'payment') === 'payment');
  const totalPayments = payments.reduce((s, p) => s + p.amount, 0);
  // Облагаемые комиссией: способ «Через терминал»; если способ не задан (старые данные) —
  // по наличию терминала.
  const terminalPayments = payments.filter((p) => (p.payMethod ? p.payMethod === TERMINAL_METHOD : !!p.terminal?.trim()));
  const ctx: Ctx = {
    base,
    operation,
    payments,
    totalPayments,
    terminalPayments,
    terminalTotal: terminalPayments.reduce((s, p) => s + p.amount, 0),
    materialsFact: input.materialsFact,
    materialNorm: input.materialNorm,
    rates: input.acquiringRates,
    opTypeTables: input.opTypeTables ?? {},
  };

  // Строка компонента; pctBase — база для процентных вычетов «pct_of_base».
  const buildLine = (c: CalcComponentInput, pctBase: number): ComponentLine => {
    const label = c.label ?? SYSTEM_COMPONENT_META[c.code]?.label ?? c.code;
    if (c.valueSource === 'warehouse_or_norm') {
      // Материалы: считаем оба способа и берём БОЛЬШИЙ (факт со склада vs норматив).
      const fact = ctx.materialsFact ?? 0;
      const norm = ctx.materialNorm ?? 0;
      const method: 'факт' | 'норматив' = fact >= norm ? 'факт' : 'норматив';
      return { code: c.code, label, stage: c.stage, direction: c.direction, amount: Math.max(fact, norm), detail: { fact, norm, method } };
    }
    return { code: c.code, label, stage: c.stage, direction: c.direction, amount: componentAmount(c, ctx, pctBase) };
  };
  const signed = (l: ComponentLine) => (l.direction === 'deduction' ? l.amount : -l.amount);

  // Два прохода: сначала «до доли» (база процентов = база начисления), затем «после доли»
  // (база процентов = сумма доли врача) — чтобы налог мог считаться от доли.
  const beforeLines = scheme.components.filter((c) => c.enabled && c.stage === 'before_share').map((c) => buildLine(c, base));
  const beforeSum = beforeLines.reduce((s, l) => s + signed(l), 0);
  const baseForShare = base - beforeSum;
  const sharePct = resolveShare(scheme, operation);
  const shareAmount = baseForShare * sharePct;
  const afterLines = scheme.components.filter((c) => c.enabled && c.stage === 'after_share').map((c) => buildLine(c, shareAmount));
  const afterSum = afterLines.reduce((s, l) => s + signed(l), 0);
  const amountFull = shareAmount - afterSum;
  const lines: ComponentLine[] = [...beforeLines, ...afterLines];

  // Читаемый след для экрана «Как посчитано».
  const trace: TraceLine[] = [];
  const detailNote = (l: ComponentLine) =>
    l.detail ? `факт ${l.detail.fact} / норматив ${l.detail.norm} → по ${l.detail.method === 'факт' ? 'факту' : 'нормативу'}` : undefined;
  trace.push({ label: 'База начисления', value: base, note: `операция ${num(operation.cost)} + наркоз ${num(operation.anesthesiaCost)}` });
  for (const l of lines.filter((x) => x.stage === 'before_share')) {
    trace.push({ label: `${l.direction === 'deduction' ? '−' : '+'} ${l.label}`, value: l.amount, note: detailNote(l) });
  }
  trace.push({ label: 'База для доли', value: baseForShare });
  trace.push({ label: `Доля врача ${Math.round(sharePct * 10000) / 100}%`, value: round2(baseForShare * sharePct) });
  for (const l of lines.filter((x) => x.stage === 'after_share')) {
    trace.push({ label: `${l.direction === 'deduction' ? '−' : '+'} ${l.label}`, value: l.amount, note: detailNote(l) });
  }
  trace.push({ label: 'Итого при 100% оплате', value: round2(amountFull) });

  return { base, components: lines, sharePct, baseForShare, amountFull, calcTrace: trace };
}
