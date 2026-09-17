import { Router } from 'express';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { computeOperation } from '../services/compute.js';
import { writeAudit } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth, requireRole('operator', 'admin')); // выгрузки продаж — скрыты от медсестры

const num = (v: unknown) => (v == null ? 0 : Number(v));
const d = (v: Date | null | undefined) => (v ? new Date(v).toLocaleDateString('ru-RU') : '');

// Период выгрузки: ?from=YYYY-MM-DD&to=YYYY-MM-DD (обе границы включительно).
// Считаем полуоткрытым интервалом [from, to+1день) в UTC — как в остальных отчётах.
export interface ExportPeriod {
  from?: string;
  to?: string;
}
function parseDay(v: string): Date {
  const d = new Date(v + 'T00:00:00.000Z');
  if (isNaN(d.getTime())) throw badRequest('Некорректная дата периода выгрузки (нужен формат ГГГГ-ММ-ДД)');
  return d;
}
function dateWhere(p: ExportPeriod): Record<string, Date> | undefined {
  const range: Record<string, Date> = {};
  if (p.from) range.gte = parseDay(p.from);
  if (p.to) {
    const toExclusive = parseDay(p.to);
    toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
    range.lt = toExclusive;
  }
  return Object.keys(range).length ? range : undefined;
}

type Row = Record<string, unknown>;
interface Column {
  header: string;
  key: string;
  width?: number;
}

async function buildData(journal: string, period: ExportPeriod): Promise<{ columns: Column[]; rows: Row[]; sheet: string }> {
  const range = dateWhere(period);
  switch (journal) {
    case 'patients': {
      // Для пациентов период — по дате добавления в систему.
      const items = await prisma.patient.findMany({ where: { deletedAt: null, ...(range ? { createdAt: range } : {}) }, orderBy: { fio: 'asc' } });
      return {
        sheet: 'Пациенты',
        columns: [
          { header: 'ID', key: 'id', width: 8 },
          { header: 'ФИО', key: 'fio', width: 30 },
          { header: 'Телефон', key: 'phone', width: 18 },
          { header: 'Дата рождения', key: 'birthDate', width: 15 },
          { header: 'Город', key: 'city', width: 18 },
        ],
        rows: items.map((p) => ({ ...p, birthDate: d(p.birthDate) })),
      };
    }
    case 'consultations': {
      const items = await prisma.consultation.findMany({
        where: { deletedAt: null, ...(range ? { dateKons: range } : {}) },
        include: { patient: true },
        orderBy: { dateKons: 'desc' },
      });
      return {
        sheet: 'Консультации',
        columns: [
          { header: 'ID', key: 'id', width: 8 },
          { header: 'Пациент', key: 'patient', width: 28 },
          { header: 'Дата записи', key: 'dateZapis', width: 14 },
          { header: 'Дата консультации', key: 'dateKons', width: 16 },
          { header: 'Вид', key: 'vid', width: 12 },
          { header: 'Врач', key: 'doctor', width: 16 },
          { header: 'Интерес', key: 'interestOperation', width: 20 },
          { header: 'Стадия итога', key: 'stage', width: 32 },
          { header: 'Сумма', key: 'amount', width: 14 },
          { header: 'Способ оплаты', key: 'payMethod', width: 18 },
        ],
        rows: items.map((c) => ({
          ...c,
          patient: c.patient.fio,
          dateZapis: d(c.dateZapis),
          dateKons: d(c.dateKons),
          amount: num(c.amount),
        })),
      };
    }
    case 'operations': {
      const items = await prisma.operation.findMany({
        where: { deletedAt: null, ...(range ? { dateOp: range } : {}) },
        include: { patient: true, payments: { where: { deletedAt: null } } },
        orderBy: { dateOp: 'desc' },
      });
      return {
        sheet: 'Операции',
        columns: [
          { header: 'ID', key: 'id', width: 8 },
          { header: 'Пациент', key: 'patient', width: 28 },
          { header: 'Дата', key: 'dateOp', width: 14 },
          { header: 'Тип операции', key: 'opType', width: 24 },
          { header: 'Врач', key: 'surgeon', width: 16 },
          { header: 'Стоимость', key: 'cost', width: 14 },
          { header: 'Наркоз', key: 'anesthesiaCost', width: 14 },
          { header: 'К оплате', key: 'totalDue', width: 14 },
          { header: 'Оплачено', key: 'paid', width: 14 },
          { header: 'Остаток', key: 'balance', width: 14 },
          { header: 'Договор', key: 'contract', width: 10 },
          { header: 'Статус', key: 'status', width: 16 },
        ],
        rows: items.map((op) => {
          const c = computeOperation(op);
          return {
            ...op,
            patient: op.patient.fio,
            dateOp: d(op.dateOp),
            cost: num(op.cost),
            anesthesiaCost: num(op.anesthesiaCost),
            totalDue: c.totalDue,
            paid: c.paid,
            balance: c.balance,
            contract: op.contractSigned ? 'да' : 'нет',
            status: c.fullyPaid ? 'Оплачено 100%' : 'Есть остаток',
          };
        }),
      };
    }
    case 'payments': {
      const items = await prisma.payment.findMany({
        where: { deletedAt: null, ...(range ? { date: range } : {}) },
        include: {
          patient: true,
          operation: { select: { id: true, opType: true, dateOp: true, surgeon: true } },
          consultation: { select: { id: true, dateKons: true } },
        },
        orderBy: { date: 'desc' },
      });
      // Кто внёс платёж — ФИО вместо служебного id.
      const userIds = [...new Set(items.flatMap((p) => [p.createdBy, p.updatedBy]).filter((v): v is number => v != null))];
      const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fio: true } }) : [];
      const userFio = new Map(users.map((u) => [u.id, u.fio]));
      return {
        sheet: 'Касса',
        columns: [
          { header: 'ID', key: 'id', width: 8 },
          { header: 'Пациент', key: 'patient', width: 28 },
          { header: 'Телефон', key: 'phone', width: 16 },
          { header: 'Дата платежа', key: 'date', width: 14 },
          { header: 'Дата записи', key: 'createdAt', width: 14 },
          { header: 'Тип', key: 'kind', width: 12 },
          { header: 'Вид услуги', key: 'serviceType', width: 18 },
          { header: 'Вид операции', key: 'opType', width: 22 },
          { header: 'Сумма', key: 'amount', width: 14 },
          { header: 'Способ оплаты', key: 'payMethod', width: 18 },
          { header: 'Терминал', key: 'terminal', width: 12 },
          { header: 'Источник записи', key: 'zapis', width: 16 },
          { header: 'Врач', key: 'doctor', width: 18 },
          { header: 'За операцию', key: 'operationInfo', width: 26 },
          { header: 'Хирург операции', key: 'operationSurgeon', width: 18 },
          { header: 'К консультации', key: 'consultationInfo', width: 18 },
          { header: 'Уточнение', key: 'payNote', width: 28 },
          { header: 'Кто внёс', key: 'createdByFio', width: 20 },
        ],
        rows: items.map((p) => ({
          ...p,
          patient: p.patient.fio,
          phone: p.patient.phone,
          date: d(p.date),
          createdAt: d(p.createdAt),
          kind: p.direction === 'refund' ? 'Возврат' : 'Платёж',
          // Возврат — со знаком «минус» для корректной суммы в 1С
          amount: p.direction === 'refund' ? -num(p.amount) : num(p.amount),
          operationInfo: p.operation ? `${p.operation.opType ?? 'операция'} · ${d(p.operation.dateOp)}` : '',
          operationSurgeon: p.operation?.surgeon ?? '',
          consultationInfo: p.consultation ? d(p.consultation.dateKons) : '',
          createdByFio: p.createdBy != null ? (userFio.get(p.createdBy) ?? '') : '',
        })),
      };
    }
    default:
      throw badRequest('Неизвестный журнал для экспорта');
  }
}

router.get(
  '/:journal',
  asyncHandler(async (req, res) => {
    const journal = req.params.journal.replace(/\.xlsx$/, '');
    const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const period: ExportPeriod = {
      from: isDate(req.query.from) ? req.query.from : undefined,
      to: isDate(req.query.to) ? req.query.to : undefined,
    };
    const { columns, rows, sheet } = await buildData(journal, period);

    // Массовая выгрузка ПДн/финансов — фиксируем в аудите (кто, что, период, сколько строк).
    await writeAudit(req, { action: 'export', entity: journal, after: { rows: rows.length, from: period.from ?? null, to: period.to ?? null } });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // Только ASCII: кириллица в заголовке Content-Disposition недопустима.
    const suffix = period.from && period.to ? `_${period.from}--${period.to}` : period.from ? `_since-${period.from}` : period.to ? `_until-${period.to}` : '';
    res.setHeader('Content-Disposition', `attachment; filename="${journal}${suffix}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

export default router;
