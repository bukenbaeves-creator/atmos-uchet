import { Router } from 'express';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { computeOperation } from '../services/compute.js';

const router = Router();
router.use(requireAuth);

const num = (v: unknown) => (v == null ? 0 : Number(v));
const d = (v: Date | null | undefined) => (v ? new Date(v).toLocaleDateString('ru-RU') : '');

type Row = Record<string, unknown>;
interface Column {
  header: string;
  key: string;
  width?: number;
}

async function buildData(journal: string): Promise<{ columns: Column[]; rows: Row[]; sheet: string }> {
  switch (journal) {
    case 'patients': {
      const items = await prisma.patient.findMany({ where: { deletedAt: null }, orderBy: { fio: 'asc' } });
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
        where: { deletedAt: null },
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
        where: { deletedAt: null },
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
          { header: 'Хирург', key: 'surgeon', width: 16 },
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
        where: { deletedAt: null },
        include: { patient: true },
        orderBy: { date: 'desc' },
      });
      return {
        sheet: 'Касса',
        columns: [
          { header: 'ID', key: 'id', width: 8 },
          { header: 'Пациент', key: 'patient', width: 28 },
          { header: 'Дата', key: 'date', width: 14 },
          { header: 'Вид услуги', key: 'serviceType', width: 18 },
          { header: 'Сумма', key: 'amount', width: 14 },
          { header: 'Способ оплаты', key: 'payMethod', width: 18 },
          { header: 'Терминал', key: 'terminal', width: 10 },
          { header: 'Врач', key: 'doctor', width: 16 },
          { header: 'Уточнение', key: 'payNote', width: 24 },
        ],
        rows: items.map((p) => ({
          ...p,
          patient: p.patient.fio,
          date: d(p.date),
          amount: num(p.amount),
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
    const { columns, rows, sheet } = await buildData(journal);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${journal}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

export default router;
