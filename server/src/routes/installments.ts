import { Router } from 'express';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { makeCrudRouter } from '../crud.js';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { computeOperation } from '../services/compute.js';
import { recalcOperation } from '../services/payout-engine.service.js';
import { moneyAmount, optionalString, requiredDate, requiredString } from '../schemas.js';
import { patientSearchOR } from '../lib/search.js';
import { eqStr } from '../lib/filters.js';
import {
  INSTALLMENT_MONTHS,
  buildPlanData,
  getClinicSettings,
  loadReminders,
  monthlyPayment,
  planState,
  setClinicSettings,
} from '../services/installment.service.js';

// Рассрочка клиники (беспроцентная, с графиком платежей). Денежный раздел — скрыт от медсестры.
const ROLES = ['operator', 'admin'];

// Поля рассрочки — общие для этого роутера и для формы операции (routes/operations.ts).
export const installmentFieldsSchema = z.object({
  downPayment: moneyAmount({ positive: true, msg: 'Первоначальный взнос должен быть больше нуля' }),
  months: z.coerce
    .number({ invalid_type_error: 'Необходимо указать срок рассрочки' })
    .refine((m) => (INSTALLMENT_MONTHS as readonly number[]).includes(m), 'Срок рассрочки — 6, 9 или 12 месяцев'),
  contractDate: requiredDate('Необходимо указать дату договора'),
  firstPaymentDate: requiredDate('Необходимо указать дату первого платежа'),
  contractNumber: optionalString(50),
  note: optionalString(),
});

const schema = installmentFieldsSchema.extend({
  operationId: z.coerce.number({ invalid_type_error: 'Необходимо выбрать операцию' }).int().positive('Необходимо выбрать операцию'),
});

const include = {
  patient: { select: { id: true, fio: true, phone: true } },
  items: { orderBy: { seq: 'asc' as const } },
  operation: {
    select: {
      id: true,
      dateOp: true,
      opType: true,
      surgeon: true,
      manager: true,
      cost: true,
      anesthesiaCost: true,
      payments: { where: { deletedAt: null } },
    },
  },
};

// Ответ: запись плана + состояние графика по фактическим оплатам Кассы.
function transform(row: Record<string, unknown>): Record<string, unknown> {
  const op = row.operation as (Parameters<typeof computeOperation>[0] & Record<string, unknown>) | null;
  const items = (row.items ?? []) as Parameters<typeof planState>[0];
  const payments = (op?.payments ?? []) as Parameters<typeof planState>[1];
  const state = planState(items, payments);
  const currentCost = op ? computeOperation(op).totalDue : 0;
  const { payments: _payments, ...operation } = (op ?? {}) as Record<string, unknown>;
  return {
    ...row,
    operation: op ? operation : null,
    monthlyPayment: monthlyPayment(Number(row.totalCost), Number(row.downPayment), Number(row.months)),
    state,
    // Стоимость операции изменили после оформления — график нужно пересохранить.
    costChanged: Math.abs(currentCost - Number(row.totalCost)) > 0.005,
    currentCost,
  };
}

// Специфичные пути — ДО CRUD-роутера, иначе их перехватит «/:id».
const extra = Router();
extra.use(requireAuth, requireRole(...ROLES));

// Напоминания: просрочено / сегодня / в ближайшие 2 дня.
extra.get(
  '/reminders',
  asyncHandler(async (_req, res) => {
    res.json(await loadReminders(prisma));
  }),
);

// Реквизиты для печатной формы графика.
extra.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json(await getClinicSettings(prisma));
  }),
);

const settingsSchema = z.object({
  clinicName: requiredString('Необходимо указать название клиники', 200),
  signatory: requiredString('Необходимо указать подписанта', 200),
});

extra.put(
  '/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = settingsSchema.parse(req.body);
    const before = await getClinicSettings(prisma);
    await prisma.$transaction(async (tx) => {
      await setClinicSettings(tx, data);
      await writeAudit(req, { action: 'update', entity: 'installmentSettings', before, after: data }, tx);
    });
    res.json(data);
  }),
);

// ───────────── График платежей в Excel (с формулами) ─────────────

const MONEY = '#,##0';
const DATE_FMT = 'dd.mm.yyyy';
const ruDate = (v: Date | string) => {
  const d = new Date(v);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};
const MAX_ROWS = 12; // в форме всегда 12 строк; лишние — прочерки (как в образце)

extra.get(
  '/:id/schedule.xlsx',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const plan = await prisma.installmentPlan.findFirst({ where: { id, deletedAt: null }, include });
    if (!plan) throw notFound('Рассрочка не найдена');
    const clinic = await getClinicSettings(prisma);
    const state = planState(plan.items, plan.operation.payments);
    const total = Number(plan.totalCost);
    const down = Number(plan.downPayment);
    const months = plan.months;
    const financed = total - down;
    const monthly = monthlyPayment(total, down, months);

    const wb = new ExcelJS.Workbook();
    wb.calcProperties.fullCalcOnLoad = true; // формулы пересчитываются при открытии
    const ws = wb.addWorksheet('График платежей', {
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
    });
    ws.columns = [{ width: 7 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 26 }];
    const thin = { style: 'thin' as const };
    const border = { top: thin, left: thin, bottom: thin, right: thin };

    const line = (row: number, text: string, opts: Partial<ExcelJS.Style> = {}) => {
      ws.mergeCells(row, 1, row, 5);
      const c = ws.getCell(row, 1);
      c.value = text;
      Object.assign(c, opts);
      return c;
    };
    line(1, 'Приложение № 1', { alignment: { horizontal: 'right' } });
    line(2, 'к Договору о рассрочке оплаты платных медицинских услуг', { alignment: { horizontal: 'right' } });
    line(3, `№ ${plan.contractNumber} от ${ruDate(plan.contractDate)} г.`, { alignment: { horizontal: 'right' } });
    line(5, 'ГРАФИК ПЛАТЕЖЕЙ', { font: { bold: true, size: 14 }, alignment: { horizontal: 'center' } });
    line(6, `Пациент: ${plan.patient.fio}`, { alignment: { horizontal: 'center' } });

    // Параметры: подпись в A:B, значение в C:E. C8, C10, C12 — вводные, остальное — формулы.
    const param = (row: number, label: string, value: ExcelJS.CellValue, numFmt: string) => {
      ws.mergeCells(row, 1, row, 2);
      ws.mergeCells(row, 3, row, 5);
      const l = ws.getCell(row, 1);
      l.value = label;
      l.alignment = { wrapText: true, vertical: 'middle' };
      const v = ws.getCell(row, 3);
      v.value = value;
      v.numFmt = numFmt;
      v.alignment = { horizontal: 'left', vertical: 'middle' };
      for (let c = 1; c <= 5; c++) ws.getCell(row, c).border = border;
    };
    param(8, 'Общая стоимость Услуг при единовременной оплате, тенге', total, MONEY);
    ws.getRow(8).height = 30;
    param(9, 'Общая стоимость Услуг в рассрочку, тенге', { formula: 'C8', result: total }, MONEY);
    param(10, 'Первоначальный взнос, тенге', down, MONEY);
    param(11, 'Сумма рассрочки, тенге', { formula: 'C9-C10', result: financed }, MONEY);
    param(12, 'Срок рассрочки', months, '0" мес."');
    param(13, 'Ежемесячный платёж, тенге', { formula: 'ROUNDUP(C11/C12,0)', result: monthly }, MONEY);

    // Шапка таблицы
    const HEAD = 15;
    const headers = ['№', 'Дата платежа (не позднее)', 'Сумма платежа, тенге', 'Остаток после платежа, тенге', 'Отметка об оплате (дата, № чека)'];
    headers.forEach((h, i) => {
      const c = ws.getCell(HEAD, i + 1);
      c.value = h;
      c.font = { bold: true };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      c.border = border;
    });
    ws.getRow(HEAD).height = 34;

    const mark = (seq: number): string | null => {
      const it = state.items.find((i) => i.seq === seq);
      if (!it) return null;
      if (it.status === 'paid') return `оплачено${it.paidDate ? ' ' + ruDate(it.paidDate) : ''}`;
      if (it.status === 'partial') return `внесено ${Math.round(it.paidAmount).toLocaleString('ru-RU')}`;
      return null;
    };
    const style = (r: number) => {
      for (let c = 1; c <= 5; c++) ws.getCell(r, c).border = border;
      ws.getCell(r, 1).alignment = { horizontal: 'center' };
      ws.getCell(r, 2).alignment = { horizontal: 'center' };
      ws.getCell(r, 2).numFmt = DATE_FMT;
      ws.getCell(r, 3).alignment = { horizontal: 'right' };
      ws.getCell(r, 3).numFmt = MONEY;
      ws.getCell(r, 4).alignment = { horizontal: 'right' };
      ws.getCell(r, 4).numFmt = MONEY;
      ws.getCell(r, 5).alignment = { horizontal: 'center' };
    };

    // Строка 0 — первоначальный взнос
    const R0 = HEAD + 1;
    ws.getCell(R0, 1).value = 0;
    ws.getCell(R0, 2).value = new Date(plan.contractDate);
    ws.getCell(R0, 3).value = { formula: 'C10', result: down };
    ws.getCell(R0, 4).value = { formula: `C9-C${R0}`, result: financed };
    ws.getCell(R0, 5).value = mark(0) ?? 'первоначальный взнос';
    style(R0);
    ws.getCell(R0, 5).font = { italic: true, size: 9 };

    // Строки 1…12: даты, суммы и остаток — формулами от параметров (C10, C12) и даты первого платежа.
    const R1 = R0 + 1;
    let rest = financed;
    for (let k = 1; k <= MAX_ROWS; k++) {
      const r = R0 + k;
      const active = k <= months;
      const item = plan.items.find((i) => i.seq === k);
      const amount = item ? Number(item.amount) : 0;
      if (active) rest -= amount;
      ws.getCell(r, 1).value = k;
      // Дата первого платежа — вводная ячейка; остальные — EDATE от неё.
      ws.getCell(r, 2).value =
        k === 1
          ? new Date(plan.firstPaymentDate)
          : { formula: `IF(A${r}<=$C$12,EDATE($B$${R1},A${r}-1),"—")`, result: active && item ? new Date(item.dueDate) : '—' };
      ws.getCell(r, 3).value = {
        formula: `IF(A${r}<=$C$12,IF(A${r}<$C$12,$C$13,$C$11-$C$13*($C$12-1)),"—")`,
        result: active ? amount : '—',
      };
      ws.getCell(r, 4).value = {
        formula: `IF(A${r}<=$C$12,D${r - 1}-C${r},"—")`,
        result: active ? Math.max(0, Math.round(rest * 100) / 100) : '—',
      };
      ws.getCell(r, 5).value = active ? mark(k) : '—';
      style(r);
      if (!active) for (let c = 2; c <= 4; c++) ws.getCell(r, c).alignment = { horizontal: 'center' };
    }

    // ИТОГО
    const RT = R0 + MAX_ROWS + 1;
    ws.getCell(RT, 2).value = 'ИТОГО';
    ws.getCell(RT, 3).value = { formula: `SUM(C${R0}:C${RT - 1})`, result: total };
    ws.getCell(RT, 4).value = { formula: `C9-C${RT}`, result: 0 };
    ws.getCell(RT, 5).value = '—';
    style(RT);
    for (let c = 1; c <= 5; c++) ws.getCell(RT, c).font = { bold: true };

    line(
      RT + 1,
      'Если дата платежа приходится на выходной или праздничный день, платёж вносится не позднее следующего рабочего дня (п. 3.2 Договора).',
      { font: { italic: true, size: 9 }, alignment: { wrapText: true, vertical: 'top' } },
    );
    ws.getRow(RT + 1).height = 28;

    // Подписи
    const RS = RT + 4;
    ws.mergeCells(RS, 1, RS, 2);
    ws.getCell(RS, 1).value = `Клиника: ${clinic.clinicName}`;
    ws.mergeCells(RS, 3, RS, 5);
    ws.getCell(RS, 3).value = 'Пациент:';
    ws.mergeCells(RS + 2, 1, RS + 2, 2);
    ws.getCell(RS + 2, 1).value = `_______________ / ${clinic.signatory}`;
    ws.mergeCells(RS + 2, 3, RS + 2, 5);
    ws.getCell(RS + 2, 3).value = '_______________ / _______________';
    ws.getCell(RS + 3, 1).value = 'М.П.';

    // Выгрузка ПДн и финансов — фиксируем в аудите.
    await writeAudit(req, { action: 'export', entity: 'installmentPlan', entityId: id });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // Только ASCII: кириллица в заголовке Content-Disposition недопустима.
    res.setHeader('Content-Disposition', `attachment; filename="installment-schedule-${id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

const crud = makeCrudRouter({
  entity: 'installmentPlan',
  model: prisma.installmentPlan,
  roles: ROLES,
  createSchema: schema,
  include,
  orderBy: { id: 'desc' },
  buildWhere: (q) => {
    const where: Record<string, unknown> = {
      // Рассрочки удалённых операций и пациентов не показываем.
      operation: { is: { deletedAt: null, ...(eqStr(q.manager) ? { manager: eqStr(q.manager) } : {}) } },
      patient: { is: { deletedAt: null } },
    };
    if (typeof q.patientId === 'string' && q.patientId) where.patientId = Number(q.patientId);
    if (typeof q.operationId === 'string' && q.operationId) where.operationId = Number(q.operationId);
    return where;
  },
  search: (t) => ({ OR: [...patientSearchOR(t, true), { contractNumber: { contains: t, mode: 'insensitive' } }] }),
  transform,
  prepareData: async (data, req, ctx) => {
    const input = data as z.infer<typeof schema>;
    const planId = ctx.mode === 'update' ? Number(req.params.id) : undefined;
    // Операцию у оформленной рассрочки не меняем — берём её из существующей записи.
    let operationId = input.operationId;
    if (planId) {
      const existing = await ctx.tx.installmentPlan.findUnique({ where: { id: planId } });
      if (existing) operationId = existing.operationId;
    }
    const { data: planData, items } = await buildPlanData(ctx.tx, { ...input, operationId }, { excludePlanId: planId });
    const { operationId: opId, patientId, ...scalars } = planData as Record<string, unknown>;
    const itemsCreate = items.map((i) => ({ seq: i.seq, dueDate: i.dueDate, amount: i.amount }));
    return ctx.mode === 'create'
      ? { ...scalars, operation: { connect: { id: opId } }, patient: { connect: { id: patientId } }, items: { create: itemsCreate } }
      : { ...scalars, items: { deleteMany: {}, create: itemsCreate } };
  },
  // Оформление, правка и удаление рассрочки меняют начисления врачам по операции.
  afterCreate: async (created, _req, tx) => {
    await recalcOperation(created.operationId as number, tx);
  },
  afterUpdate: async (updated, _before, _req, tx) => {
    await recalcOperation(updated.operationId as number, tx);
  },
  afterDelete: async (record, _req, tx) => {
    await recalcOperation(record.operationId as number, tx);
  },
  afterRestore: async (restored, _req, tx) => {
    const other = await tx.installmentPlan.findFirst({
      where: { operationId: restored.operationId as number, deletedAt: null, id: { not: restored.id as number } },
    });
    if (other) throw badRequest(`По этой операции уже оформлена другая рассрочка (договор ${other.contractNumber})`);
    await recalcOperation(restored.operationId as number, tx);
  },
});

const router = Router();
router.use(extra);
router.use(crud);

export default router;
