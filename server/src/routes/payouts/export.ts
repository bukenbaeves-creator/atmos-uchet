import { Router } from 'express';
import ExcelJS from 'exceljs';
import { asyncHandler } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { writeAudit } from '../../services/audit.service.js';
import { getSheet, getSheetRegistry } from '../../services/payout-sheet.service.js';

// Выгрузка ведомости в Excel (Э4-3): сводный лист + лист на каждого врача с реестром.
// Колонки, порядок и итоги — как на экране. Числовой формат «# ##0», закреплённая шапка.
const router = Router();
router.use(requireAuth, requireAdmin);

const num = (v: unknown) => (v == null ? 0 : Number(v));
const MONEY = '# ##0';
const dstr = (v: Date | string | null) => (v ? new Date(v).toLocaleDateString('ru-RU') : '');
const safeSheetName = (s: string) => s.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);

router.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const sheet = await getSheet(id);
    const wb = new ExcelJS.Workbook();

    // --- Сводный лист ---
    const sum = wb.addWorksheet('Сводка');
    sum.columns = [
      { header: 'Врач', key: 'fio', width: 28 },
      { header: 'Операций', key: 'ops', width: 12 },
      { header: 'Начислено', key: 'accrued', width: 16 },
      { header: 'Удержания', key: 'withh', width: 14 },
      { header: 'К выплате', key: 'toPay', width: 16 },
      { header: 'Выплачено', key: 'paid', width: 16 },
      { header: 'Остаток', key: 'debt', width: 14 },
    ];
    sum.getRow(1).font = { bold: true };
    sum.views = [{ state: 'frozen', ySplit: 1 }];
    let tA = 0;
    let tP = 0;
    let tPaid = 0;
    let tD = 0;
    for (const l of sheet.lines) {
      const withh = ((l.withholdings as Array<{ amount: number }>) ?? []).reduce((s, w) => s + num(w.amount), 0);
      const debt = num(l.toPay) - num(l.paidTotal);
      sum.addRow({ fio: l.payee?.fio ?? '—', ops: l.operationsCount, accrued: num(l.accruedTotal), withh, toPay: num(l.toPay), paid: num(l.paidTotal), debt });
      tA += num(l.accruedTotal);
      tP += num(l.toPay);
      tPaid += num(l.paidTotal);
      tD += debt;
    }
    const totalRow = sum.addRow({ fio: 'ИТОГО', accrued: tA, toPay: tP, paid: tPaid, debt: tD });
    totalRow.font = { bold: true };
    for (const k of ['accrued', 'withh', 'toPay', 'paid', 'debt']) sum.getColumn(k).numFmt = MONEY;

    // --- Лист на каждого врача (реестр с динамическими колонками) ---
    let idx = 0;
    for (const l of sheet.lines) {
      idx += 1;
      const reg = await getSheetRegistry(id, l.payeeId);
      const ws = wb.addWorksheet(safeSheetName(`${idx}. ${l.payee?.fio ?? 'врач ' + l.payeeId}`));
      ws.columns = [
        { header: 'Дата', key: 'date', width: 12 },
        { header: 'Пациент', key: 'patient', width: 26 },
        { header: 'Вид операции', key: 'opType', width: 20 },
        { header: 'База', key: 'base', width: 14 },
        ...reg.columns.map((c) => ({ header: c.label, key: `c_${c.code}`, width: 16 })),
        { header: 'Доля', key: 'share', width: 8 },
        { header: 'Начислено', key: 'amount', width: 16 },
      ];
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];
      for (const r of reg.rows) {
        const row: Record<string, unknown> = {
          date: dstr(r.dateOp),
          patient: r.patient ?? (r.isCorrection ? 'корректировка' : ''),
          opType: r.opType ?? '',
          base: r.base,
          share: `${Math.round(r.sharePct * 100)}%`,
          amount: r.amount,
        };
        for (const c of reg.columns) row[`c_${c.code}`] = r.components[c.code] ?? 0;
        ws.addRow(row);
      }
      const tr = ws.addRow({
        patient: 'ИТОГО',
        amount: reg.totals.amount,
        ...Object.fromEntries(reg.columns.map((c) => [`c_${c.code}`, reg.totals.perComponent[c.code]])),
      });
      tr.font = { bold: true };
      for (const k of ['base', 'amount', ...reg.columns.map((c) => `c_${c.code}`)]) ws.getColumn(k).numFmt = MONEY;
    }

    await writeAudit(req, { action: 'export', entity: 'payoutSheet', entityId: id, after: { number: sheet.number } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payout-sheet-${id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

export default router;
