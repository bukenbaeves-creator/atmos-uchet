// Рассрочка клиники: расчёт графика платежей и его состояния по фактическим оплатам.
// Чистые функции (buildSchedule, planState) не обращаются к БД — их проверяет
// scripts/test-installment-schedule.ts. Не путать со способом оплаты «Рассрочка» (банк).
import type { PrismaClientOrTx } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/http.js';
import { computeOperation, round2 } from './compute.js';

export const INSTALLMENT_MONTHS = [6, 9, 12] as const;
const CENT = 0.005;
const DAY_MS = 86_400_000;
// За сколько дней до срока платёж попадает в напоминания.
export const REMIND_DAYS = 2;

type Num = number | string | { toString(): string } | null | undefined;
const num = (v: Num): number => (v == null ? 0 : Number(v));
type DateLike = Date | string;
const toDate = (v: DateLike): Date => (v instanceof Date ? v : new Date(v));

/** UTC-полночь дня, на который приходится дата. */
export function utcDay(v: DateLike): Date {
  const d = toDate(v);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** «Сегодня» по Алматы (UTC+5) как UTC-полночь: сервер работает в UTC. */
export function almatyToday(now: Date = new Date()): Date {
  return utcDay(new Date(now.getTime() + 5 * 3_600_000));
}

/** Та же дата через k месяцев; 29–31 число прижимается к концу короткого месяца (как EDATE в Excel). */
export function addMonthsUTC(v: DateLike, k: number): Date {
  const d = toDate(v);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + k;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)));
}

export interface ScheduleInput {
  totalCost: number;
  downPayment: number;
  months: number;
  contractDate: DateLike;
  firstPaymentDate: DateLike;
}

export interface ScheduleItem {
  seq: number; // 0 — первоначальный взнос, 1…N — ежемесячные платежи
  dueDate: Date;
  amount: number;
}

/**
 * График платежей. Ежемесячный платёж — сумма рассрочки / срок с округлением ВВЕРХ до
 * целого тенге; последний платёж — остаток (1 500 000 / 9 → 166 667 × 8 + 166 664).
 * Бросает Error с русским сообщением при недопустимых параметрах.
 */
export function buildSchedule(input: ScheduleInput): ScheduleItem[] {
  const total = round2(num(input.totalCost));
  const down = round2(num(input.downPayment));
  const months = Number(input.months);
  if (!(INSTALLMENT_MONTHS as readonly number[]).includes(months)) {
    throw new Error('Срок рассрочки — 6, 9 или 12 месяцев');
  }
  if (!(total > 0)) throw new Error('У операции не заполнена стоимость — рассрочку оформить нельзя');
  if (!(down > 0)) throw new Error('Первоначальный взнос должен быть больше нуля');
  if (!(down < total)) throw new Error('Первоначальный взнос должен быть меньше стоимости услуг');
  const contractDate = utcDay(input.contractDate);
  const first = utcDay(input.firstPaymentDate);
  if (isNaN(contractDate.getTime())) throw new Error('Необходимо указать дату договора');
  if (isNaN(first.getTime())) throw new Error('Необходимо указать дату первого платежа');
  if (first.getTime() < contractDate.getTime()) {
    throw new Error('Дата первого платежа не может быть раньше даты договора');
  }

  const financed = round2(total - down);
  const monthly = Math.ceil(financed / months - 1e-9);
  const last = round2(financed - monthly * (months - 1));
  if (!(last > 0)) throw new Error('Сумма рассрочки слишком мала для выбранного срока');

  const items: ScheduleItem[] = [{ seq: 0, dueDate: contractDate, amount: down }];
  for (let k = 1; k <= months; k++) {
    items.push({ seq: k, dueDate: addMonthsUTC(first, k - 1), amount: k < months ? monthly : last });
  }
  return items;
}

/** Ежемесячный платёж (для шапки графика). */
export function monthlyPayment(totalCost: number, downPayment: number, months: number): number {
  return Math.ceil(round2(totalCost - downPayment) / months - 1e-9);
}

export interface PaymentLike {
  id?: number;
  amount: Num;
  date?: DateLike | null;
  direction?: string | null;
  deletedAt?: DateLike | null;
}

export interface ItemState {
  seq: number;
  dueDate: string; // ISO
  amount: number;
  paidAmount: number; // сколько из строки покрыто оплатами
  status: 'paid' | 'partial' | 'unpaid';
  paidDate: string | null; // дата платежа, закрывшего строку
  overdue: boolean; // срок прошёл, строка не закрыта
  daysLeft: number; // дней до срока (отрицательное — просрочка)
}

export interface PlanState {
  total: number; // сумма по графику
  paid: number; // оплачено по операции (платежи минус возвраты)
  balance: number; // остаток по графику
  closed: boolean; // рассрочка погашена
  items: ItemState[];
  nextDue: { seq: number; dueDate: string; amount: number; daysLeft: number } | null; // ближайшая незакрытая строка
  overdueCount: number;
  overdueAmount: number;
}

/**
 * Состояние графика: оплаченное по операции раскладывается по строкам ПО ПОРЯДКУ.
 * Отдельной отметки «оплачено» нет — источник правды один: платежи Кассы по операции.
 */
export function planState(
  items: { seq: number; dueDate: DateLike; amount: Num }[],
  payments: PaymentLike[],
  today: Date = almatyToday(),
): PlanState {
  const rows = [...items].sort((a, b) => a.seq - b.seq);
  const pays = payments
    .filter((p) => !p.deletedAt)
    .map((p) => ({
      id: p.id ?? 0,
      signed: (p.direction === 'refund' ? -1 : 1) * num(p.amount),
      date: p.date ? toDate(p.date) : null,
    }))
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0) || a.id - b.id);
  const paid = round2(pays.reduce((s, p) => s + p.signed, 0));
  const total = round2(rows.reduce((s, r) => s + num(r.amount), 0));

  let before = 0; // сумма строк до текущей
  const out: ItemState[] = rows.map((r) => {
    const amount = round2(num(r.amount));
    const threshold = round2(before + amount);
    const paidAmount = round2(Math.min(amount, Math.max(0, paid - before)));
    const isPaid = paid + CENT >= threshold;
    let paidDate: string | null = null;
    if (isPaid) {
      // Дата платежа, после которого накопленная оплата впервые покрыла строку.
      let cum = 0;
      for (const p of pays) {
        cum += p.signed;
        if (cum + CENT >= threshold) {
          paidDate = p.date ? p.date.toISOString() : null;
          break;
        }
      }
    }
    const due = utcDay(r.dueDate);
    const daysLeft = Math.round((due.getTime() - today.getTime()) / DAY_MS);
    before = threshold;
    return {
      seq: r.seq,
      dueDate: due.toISOString(),
      amount,
      paidAmount,
      status: isPaid ? 'paid' : paidAmount > CENT ? 'partial' : 'unpaid',
      paidDate,
      overdue: !isPaid && daysLeft < 0,
      daysLeft,
    };
  });

  const open = out.filter((i) => i.status !== 'paid');
  const overdue = open.filter((i) => i.overdue);
  const next = open[0] ?? null;
  return {
    total,
    paid,
    balance: round2(Math.max(0, total - paid)),
    closed: open.length === 0,
    items: out,
    nextDue: next
      ? { seq: next.seq, dueDate: next.dueDate, amount: round2(next.amount - next.paidAmount), daysLeft: next.daysLeft }
      : null,
    overdueCount: overdue.length,
    overdueAmount: round2(overdue.reduce((s, i) => s + i.amount - i.paidAmount, 0)),
  };
}

// ───────────────────────── Работа с БД ─────────────────────────

export interface PlanInput {
  operationId: number;
  downPayment: number;
  months: number;
  contractDate: Date;
  firstPaymentDate: Date;
  contractNumber?: string | null;
  note?: string | null;
}

/** Следующий номер договора: Р-001, Р-002 … (по числу всех когда-либо оформленных рассрочек). */
export async function nextContractNumber(tx: PrismaClientOrTx): Promise<string> {
  const count = await tx.installmentPlan.count();
  return `Р-${String(count + 1).padStart(3, '0')}`;
}

/**
 * Готовит данные записи плана и строки графика. Проверяет операцию и то, что у неё
 * нет другой действующей рассрочки. Стоимость берётся снимком с операции.
 */
export async function buildPlanData(
  tx: PrismaClientOrTx,
  input: PlanInput,
  opts: { excludePlanId?: number } = {},
): Promise<{ data: Record<string, unknown>; items: ScheduleItem[] }> {
  const op = await tx.operation.findFirst({
    where: { id: input.operationId, deletedAt: null },
    include: { payments: { where: { deletedAt: null } } },
  });
  if (!op) throw notFound('Операция не найдена');
  const other = await tx.installmentPlan.findFirst({
    where: { operationId: op.id, deletedAt: null, ...(opts.excludePlanId ? { id: { not: opts.excludePlanId } } : {}) },
  });
  if (other) throw badRequest(`По этой операции уже оформлена рассрочка (договор ${other.contractNumber})`);

  const totalCost = computeOperation(op).totalDue;
  let items: ScheduleItem[];
  try {
    items = buildSchedule({
      totalCost,
      downPayment: input.downPayment,
      months: input.months,
      contractDate: input.contractDate,
      firstPaymentDate: input.firstPaymentDate,
    });
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const contractNumber = input.contractNumber?.trim() || (await nextContractNumber(tx));
  return {
    data: {
      operationId: op.id,
      patientId: op.patientId,
      contractNumber,
      contractDate: utcDay(input.contractDate),
      totalCost,
      downPayment: round2(input.downPayment),
      months: input.months,
      firstPaymentDate: utcDay(input.firstPaymentDate),
      note: input.note ?? null,
    },
    items,
  };
}

/** Действующая рассрочка операции (или null). */
export async function getActivePlan(tx: PrismaClientOrTx, operationId: number) {
  return tx.installmentPlan.findFirst({ where: { operationId, deletedAt: null }, orderBy: { id: 'desc' } });
}

export interface Reminder {
  planId: number;
  operationId: number;
  patientId: number;
  patientFio: string;
  patientPhone: string;
  manager: string | null;
  opType: string | null;
  contractNumber: string;
  seq: number;
  dueDate: string;
  amount: number; // сколько осталось внести по строке
  daysLeft: number;
}

export interface Reminders {
  overdue: Reminder[]; // срок прошёл
  today: Reminder[]; // платёж сегодня
  soon: Reminder[]; // в ближайшие REMIND_DAYS дней
}

/**
 * Напоминания о платежах: строка графика появляется за REMIND_DAYS дней до срока и
 * остаётся (сегодня → просрочено), пока не будет оплачена.
 */
export async function loadReminders(client: PrismaClientOrTx, today: Date = almatyToday()): Promise<Reminders> {
  const horizon = new Date(today.getTime() + (REMIND_DAYS + 1) * DAY_MS); // полуоткрытый интервал [.., today+3)
  const plans = await client.installmentPlan.findMany({
    where: {
      deletedAt: null,
      operation: { is: { deletedAt: null } },
      patient: { is: { deletedAt: null } },
      items: { some: { dueDate: { lt: horizon } } },
    },
    include: {
      items: true,
      patient: { select: { id: true, fio: true, phone: true } },
      operation: { select: { id: true, manager: true, opType: true, payments: { where: { deletedAt: null } } } },
    },
  });
  const res: Reminders = { overdue: [], today: [], soon: [] };
  for (const p of plans) {
    const state = planState(p.items, p.operation.payments, today);
    for (const i of state.items) {
      if (i.status === 'paid' || i.daysLeft > REMIND_DAYS) continue;
      const r: Reminder = {
        planId: p.id,
        operationId: p.operationId,
        patientId: p.patientId,
        patientFio: p.patient.fio,
        patientPhone: p.patient.phone,
        manager: p.operation.manager,
        opType: p.operation.opType,
        contractNumber: p.contractNumber,
        seq: i.seq,
        dueDate: i.dueDate,
        amount: round2(i.amount - i.paidAmount),
        daysLeft: i.daysLeft,
      };
      (i.daysLeft < 0 ? res.overdue : i.daysLeft === 0 ? res.today : res.soon).push(r);
    }
  }
  const byDate = (a: Reminder, b: Reminder) => a.dueDate.localeCompare(b.dueDate) || a.patientFio.localeCompare(b.patientFio);
  res.overdue.sort(byDate);
  res.today.sort(byDate);
  res.soon.sort(byDate);
  return res;
}

// Реквизиты для печатной формы графика (ключи Setting; значения по умолчанию — из образца).
const CLINIC_KEYS = { clinicName: 'clinic_name', signatory: 'clinic_signatory' } as const;
const CLINIC_DEFAULTS = { clinicName: 'ТОО «Atmos clinic»', signatory: 'Букенбаева А.З.' };
export type ClinicSettings = typeof CLINIC_DEFAULTS;

export async function getClinicSettings(client: PrismaClientOrTx): Promise<ClinicSettings> {
  const rows = await client.setting.findMany({ where: { key: { in: Object.values(CLINIC_KEYS) } } });
  const get = (k: string, def: string) => rows.find((r) => r.key === k)?.value?.trim() || def;
  return {
    clinicName: get(CLINIC_KEYS.clinicName, CLINIC_DEFAULTS.clinicName),
    signatory: get(CLINIC_KEYS.signatory, CLINIC_DEFAULTS.signatory),
  };
}

export async function setClinicSettings(client: PrismaClientOrTx, value: ClinicSettings): Promise<void> {
  for (const [field, key] of Object.entries(CLINIC_KEYS) as [keyof ClinicSettings, string][]) {
    await client.setting.upsert({ where: { key }, create: { key, value: value[field] }, update: { value: value[field] } });
  }
}
