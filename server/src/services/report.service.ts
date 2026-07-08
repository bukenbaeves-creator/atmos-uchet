import { prisma } from '../lib/prisma.js';
import { serialize } from '../lib/serialize.js';
import { computeOperation, round2 } from './compute.js';
import { config } from '../lib/config.js';
import { PAY_STAGES, PREPAYMENT_SERVICE } from '../constants.js';

const num = (v: unknown): number => (v == null ? 0 : Number(v));
// Порог сравнения баланса с нулём (полкопейки).
const CENT = 0.005;

// Ключ месяца в UTC — согласованно с хранением дат (UTC-полночь из <input type=date>)
// и с границами периода (тоже UTC), чтобы разбивка не «переезжала» в соседний месяц.
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface Period {
  from?: Date;
  toExclusive?: Date; // верхняя граница НЕ включительно (полуоткрытый интервал)
}

function dateFilter(period: Period, field: string) {
  if (!period.from && !period.toExclusive) return {};
  return {
    [field]: {
      ...(period.from ? { gte: period.from } : {}),
      ...(period.toExclusive ? { lt: period.toExclusive } : {}),
    },
  };
}

// Дашборд (раздел 9.1): KPI + серии для графиков
export async function dashboard(period: Period) {
  // Исключаем записи удалённых пациентов/операций: иначе их деньги продолжали бы
  // попадать в выручку (мягкое удаление на уровне БД не каскадируется).
  const [payments, operations, consultations] = await Promise.all([
    prisma.payment.findMany({
      where: {
        deletedAt: null,
        patient: { is: { deletedAt: null } },
        OR: [{ operationId: null }, { operation: { is: { deletedAt: null } } }],
        ...dateFilter(period, 'date'),
      },
      select: { amount: true, date: true, payMethod: true, doctor: true },
    }),
    prisma.operation.findMany({
      where: { deletedAt: null, patient: { is: { deletedAt: null } }, ...dateFilter(period, 'dateOp') },
      select: { id: true, surgeon: true, cost: true, anesthesiaCost: true },
    }),
    prisma.consultation.findMany({
      where: { deletedAt: null, patient: { is: { deletedAt: null } }, ...dateFilter(period, 'dateKons') },
      select: { stage: true },
    }),
  ]);

  const revenue = round2(payments.reduce((s, p) => s + num(p.amount), 0));

  // Конверсия в оплату
  const known = consultations.filter((c) => c.stage);
  const converted = known.filter((c) => PAY_STAGES.includes(c.stage as string));
  const conversion = known.length ? converted.length / known.length : 0;

  // Выручка по месяцам
  const byMonthMap = new Map<string, number>();
  for (const p of payments) {
    if (!p.date) continue;
    const k = monthKey(new Date(p.date));
    byMonthMap.set(k, (byMonthMap.get(k) ?? 0) + num(p.amount));
  }
  const revenueByMonth = [...byMonthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, value]) => ({ month, value: round2(value) }));

  // Способы оплаты
  const byMethodMap = new Map<string, number>();
  for (const p of payments) {
    const k = p.payMethod || '(не указан)';
    byMethodMap.set(k, (byMethodMap.get(k) ?? 0) + num(p.amount));
  }
  const byPayMethod = [...byMethodMap.entries()]
    .map(([name, value]) => ({ name, value: round2(value) }))
    .sort((a, b) => b.value - a.value);

  // Воронка по стадиям
  const funnelMap = new Map<string, number>();
  for (const c of consultations) {
    const k = c.stage || '(без итога)';
    funnelMap.set(k, (funnelMap.get(k) ?? 0) + 1);
  }
  const funnel = [...funnelMap.entries()].map(([stage, count]) => ({ stage, count }));

  // Срез по врачам (выручка кассы)
  const byDoctorMap = new Map<string, number>();
  for (const p of payments) {
    if (!p.doctor) continue;
    byDoctorMap.set(p.doctor, (byDoctorMap.get(p.doctor) ?? 0) + num(p.amount));
  }
  const byDoctor = [...byDoctorMap.entries()]
    .map(([name, value]) => ({ name, value: round2(value) }))
    .sort((a, b) => b.value - a.value);

  return {
    kpi: {
      revenue,
      operations: operations.length,
      consultations: consultations.length,
      conversion,
    },
    revenueByMonth,
    byPayMethod,
    funnel,
    byDoctor,
  };
}

// Предоплаты и остатки (раздел 9.5)
export async function prepayments(filter: string | undefined) {
  const operations = await prisma.operation.findMany({
    where: { deletedAt: null, patient: { is: { deletedAt: null } } },
    include: {
      patient: { select: { id: true, fio: true, phone: true } },
      payments: { where: { deletedAt: null } },
    },
    orderBy: { dateOp: 'desc' },
  });

  let rows = operations.map((op) => {
    const c = computeOperation(op);
    // Аванс (предоплата) — сумма платежей по операции с видом услуги «Предоплата»
    const prepaid = round2(
      op.payments
        .filter((p) => !p.deletedAt && p.serviceType === PREPAYMENT_SERVICE)
        .reduce((s, p) => s + num(p.amount), 0),
    );
    return {
      ...serialize({
        id: op.id,
        patientId: op.patientId,
        patient: op.patient,
        dateOp: op.dateOp,
        opType: op.opType,
        surgeon: op.surgeon,
        cost: op.cost,
        anesthesiaCost: op.anesthesiaCost,
        contractSigned: op.contractSigned,
      }),
      ...c,
      prepaid,
    };
  });

  if (filter === 'balance') rows = rows.filter((r) => r.balance > CENT);
  else if (filter === 'noContract') rows = rows.filter((r) => !r.contractSigned);
  else if (filter === 'fullyPaid') rows = rows.filter((r) => r.fullyPaid);

  const totals = rows.reduce(
    (acc, r) => {
      acc.totalDue = round2(acc.totalDue + r.totalDue);
      acc.prepaid = round2(acc.prepaid + r.prepaid);
      acc.paid = round2(acc.paid + r.paid);
      acc.balance = round2(acc.balance + r.balance);
      return acc;
    },
    { totalDue: 0, prepaid: 0, paid: 0, balance: 0 },
  );

  return { rows, totals };
}

// Проверка ошибок (раздел 9.7)
export async function errorCheck() {
  const issues: {
    type: string;
    entity: string;
    entityId: number;
    label: string;
    detail: string;
  }[] = [];

  const [operations, payments, consultations, patients] = await Promise.all([
    prisma.operation.findMany({
      where: { deletedAt: null },
      include: { patient: { select: { fio: true } } },
    }),
    prisma.payment.findMany({
      where: { deletedAt: null },
      include: { patient: { select: { fio: true } } },
    }),
    prisma.consultation.findMany({
      where: { deletedAt: null },
      include: { patient: { select: { fio: true } } },
    }),
    prisma.patient.findMany({ where: { deletedAt: null } }),
  ]);

  for (const op of operations) {
    const total = num(op.cost) + num(op.anesthesiaCost);
    if (total > config.anomalyAmount) {
      issues.push({
        type: 'anomaly_amount',
        entity: 'operation',
        entityId: op.id,
        label: op.patient?.fio ?? '—',
        detail: `Аномально большая стоимость операции: ${total.toLocaleString('ru-RU')}`,
      });
    }
    if (num(op.cost) === 0) {
      issues.push({
        type: 'zero_cost',
        entity: 'operation',
        entityId: op.id,
        label: op.patient?.fio ?? '—',
        detail: 'Нулевая стоимость операции',
      });
    }
  }

  for (const p of payments) {
    if (num(p.amount) > config.anomalyAmount) {
      issues.push({
        type: 'anomaly_amount',
        entity: 'payment',
        entityId: p.id,
        label: p.patient?.fio ?? '—',
        detail: `Аномально большая сумма платежа: ${num(p.amount).toLocaleString('ru-RU')}`,
      });
    }
  }

  for (const c of consultations) {
    if (!c.stage) {
      issues.push({
        type: 'empty_stage',
        entity: 'consultation',
        entityId: c.id,
        label: c.patient?.fio ?? '—',
        detail: 'Пустой итог (стадия) консультации',
      });
    }
  }

  for (const pt of patients) {
    if (!pt.phone) {
      issues.push({
        type: 'no_phone',
        entity: 'patient',
        entityId: pt.id,
        label: pt.fio,
        detail: 'Нет телефона у пациента',
      });
    }
  }

  // Дубли пациентов по телефону
  const byPhone = new Map<string, number[]>();
  for (const pt of patients) {
    if (!pt.phone) continue;
    (byPhone.get(pt.phone) ?? byPhone.set(pt.phone, []).get(pt.phone)!).push(pt.id);
  }
  for (const [phone, ids] of byPhone) {
    if (ids.length > 1) {
      for (const id of ids) {
        issues.push({
          type: 'duplicate_phone',
          entity: 'patient',
          entityId: id,
          label: phone,
          detail: `Дубли пациентов по телефону (${ids.length})`,
        });
      }
    }
  }

  return { issues, count: issues.length };
}
