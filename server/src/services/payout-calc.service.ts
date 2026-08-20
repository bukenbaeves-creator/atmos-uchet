import { round2 } from './compute.js';
import { badRequest } from '../lib/http.js';

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
}

export interface ComponentLine {
  code: string;
  label: string;
  stage: CalcStage;
  direction: ComponentDirection;
  amount: number;
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
  materialsFact: number | null;
  materialNorm: number | null;
  rates: AcquiringRateInput[];
}

// Сумма одного компонента по его источнику значения.
function componentAmount(c: CalcComponentInput, ctx: Ctx): number {
  switch (c.valueSource) {
    case 'pct_of_payments':
      // useOwnValue → процент из value применяется ко ВСЕЙ сумме платежей (переопределение);
      // иначе — ставка терминала на дату по каждому платежу.
      if (c.useOwnValue) return ctx.totalPayments * (num(c.value) / 100);
      return ctx.payments.reduce((s, p) => s + p.amount * (resolveAcquiringRate(ctx.rates, p.terminal, p.date) / 100), 0);
    case 'pct_of_base':
      return ctx.base * (num(c.value) / 100);
    case 'operation_field':
      return num((ctx.operation as unknown as Record<string, unknown>)[c.operationField ?? '']);
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
      return num(c.value);
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
  const ctx: Ctx = {
    base,
    operation,
    payments,
    totalPayments,
    materialsFact: input.materialsFact,
    materialNorm: input.materialNorm,
    rates: input.acquiringRates,
  };

  const lines: ComponentLine[] = [];
  for (const c of scheme.components) {
    if (!c.enabled) continue;
    lines.push({
      code: c.code,
      label: c.label ?? SYSTEM_COMPONENT_META[c.code]?.label ?? c.code,
      stage: c.stage,
      direction: c.direction,
      amount: componentAmount(c, ctx),
    });
  }
  // Вычет уменьшает базу/выплату, начисление — увеличивает.
  const signed = (l: ComponentLine) => (l.direction === 'deduction' ? l.amount : -l.amount);
  const beforeSum = lines.filter((l) => l.stage === 'before_share').reduce((s, l) => s + signed(l), 0);
  const afterSum = lines.filter((l) => l.stage === 'after_share').reduce((s, l) => s + signed(l), 0);

  const baseForShare = base - beforeSum;
  const sharePct = resolveShare(scheme, operation);
  const amountFull = baseForShare * sharePct - afterSum;

  // Читаемый след для экрана «Как посчитано».
  const trace: TraceLine[] = [];
  trace.push({ label: 'База начисления', value: base, note: `операция ${num(operation.cost)} + наркоз ${num(operation.anesthesiaCost)}` });
  for (const l of lines.filter((x) => x.stage === 'before_share')) {
    trace.push({ label: `${l.direction === 'deduction' ? '−' : '+'} ${l.label}`, value: l.amount });
  }
  trace.push({ label: 'База для доли', value: baseForShare });
  trace.push({ label: `Доля врача ${Math.round(sharePct * 10000) / 100}%`, value: round2(baseForShare * sharePct) });
  for (const l of lines.filter((x) => x.stage === 'after_share')) {
    trace.push({ label: `${l.direction === 'deduction' ? '−' : '+'} ${l.label}`, value: l.amount });
  }
  trace.push({ label: 'Итого при 100% оплате', value: round2(amountFull) });

  return { base, components: lines, sharePct, baseForShare, amountFull, calcTrace: trace };
}
