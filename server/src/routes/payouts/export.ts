import { Router } from 'express';
import ExcelJS from 'exceljs';
import { asyncHandler } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { writeAudit } from '../../services/audit.service.js';
import { getSheet, getSheetRegistry } from '../../services/payout-sheet.service.js';

// Выгрузка ведомости в Excel (Э4-3 + доработка): сводный лист + лист на каждого врача.
// Ячейки «Начислено» и итоги — ЖИВЫЕ ФОРМУЛЫ Excel: (База − Σ вычетов до доли) × Доля −
// Σ вычетов после доли; итоги через =SUM(). Числовой формат «# ##0», закреплённая шапка.
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

    // --- Сводный лист (итоги — формулы =SUM) ---
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
    let r = 1;
    for (const l of sheet.lines) {
      r++;
      const withh = ((l.withholdings as Array<{ amount: number }>) ?? []).reduce((s, w) => s + num(w.amount), 0);
      const row = sum.addRow({ fio: l.payee?.fio ?? '—', ops: l.operationsCount, accrued: num(l.accruedTotal), withh, toPay: num(l.toPay), paid: num(l.paidTotal) });
      // Остаток = К выплате − Выплачено (формула).
      row.getCell('debt').value = { formula: `E${r}-F${r}`, result: num(l.toPay) - num(l.paidTotal) };
    }
    if (sheet.lines.length) {
      const last = r;
      const tr = sum.addRow({ fio: 'ИТОГО' });
      for (const [key, col] of [['accrued', 'C'], ['withh', 'D'], ['toPay', 'E'], ['paid', 'F'], ['debt', 'G']] as const) {
        tr.getCell(key).value = { formula: `SUM(${col}2:${col}${last})`, result: undefined };
      }
      tr.font = { bold: true };
    }
    for (const k of ['accrued', 'withh', 'toPay', 'paid', 'debt']) sum.getColumn(k).numFmt = MONEY;

    // --- Лист на каждого врача (реестр + формула начисления) ---
    let idx = 0;
    for (const l of sheet.lines) {
      idx += 1;
      const reg = await getSheetRegistry(id, l.payeeId);
      const ws = wb.addWorksheet(safeSheetName(`${idx}. ${l.payee?.fio ?? 'врач ' + l.payeeId}`));
      const hasMaterials = reg.columns.some((c) => c.code === 'materials_fact');
      ws.columns = [
        { header: 'Дата', key: 'date', width: 12 },
        { header: 'Пациент', key: 'patient', width: 26 },
        { header: 'Вид операции', key: 'opType', width: 20 },
        { header: 'База', key: 'base', width: 14 },
        ...reg.columns.map((c) => ({ header: c.label, key: `c_${c.code}`, width: 16 })),
        ...(hasMaterials ? [{ header: 'Метод расхода', key: 'method', width: 16 }] : []),
        { header: 'Доля', key: 'share', width: 9 },
        { header: 'Начислено', key: 'amount', width: 16 },
      ];
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 2 }];

      // Выражение вычетов стадии для формулы: обычные компоненты складываются, а материалы
      // берутся как MAX(факт; норматив) — в расчёт идёт больший.
      const baseCol = ws.getColumn('base').letter;
      const shareCol = ws.getColumn('share').letter;
      const stageExpr = (stage: string, rn: number): string => {
        const cols = reg.columns.filter((c) => c.stage === stage);
        const parts = cols.filter((c) => c.code !== 'materials_fact' && c.code !== 'materials_norm').map((c) => `${ws.getColumn(`c_${c.code}`).letter}${rn}`);
        const f = cols.find((c) => c.code === 'materials_fact');
        const nrm = cols.find((c) => c.code === 'materials_norm');
        if (f && nrm) parts.push(`MAX(${ws.getColumn('c_materials_fact').letter}${rn},${ws.getColumn('c_materials_norm').letter}${rn})`);
        return parts.length ? parts.join('+') : '0';
      };

      let rn = 1; // строка шапки
      for (const row of reg.rows) {
        rn++;
        const xr = ws.addRow({
          date: dstr(row.dateOp),
          patient: row.patient ?? (row.isCorrection ? 'корректировка' : ''),
          opType: row.opType ?? '',
          base: row.base,
          share: row.sharePct,
          method: row.materialsMethod ? (row.materialsMethod === 'факт' ? 'по факту' : 'по нормативу') : '',
        });
        for (const c of reg.columns) xr.getCell(`c_${c.code}`).value = row.components[c.code] ?? 0;
        // Начислено = (База − Σ вычетов до доли) × Доля − Σ вычетов после доли.
        const formula = `(${baseCol}${rn}-(${stageExpr('before_share', rn)}))*${shareCol}${rn}-(${stageExpr('after_share', rn)})`;
        xr.getCell('amount').value = { formula, result: row.amount };
      }
      // Итоги (=SUM) по числовым колонкам.
      if (reg.rows.length) {
        const last = rn;
        const tr = ws.addRow({ patient: 'ИТОГО' });
        for (const key of ['base', ...reg.columns.map((c) => `c_${c.code}`), 'amount']) {
          const L = ws.getColumn(key).letter;
          tr.getCell(key).value = { formula: `SUM(${L}2:${L}${last})`, result: undefined };
        }
        tr.font = { bold: true };
      }
      for (const k of ['base', 'amount', ...reg.columns.map((c) => `c_${c.code}`)]) ws.getColumn(k).numFmt = MONEY;
      ws.getColumn('share').numFmt = '0%';
    }

    await writeAudit(req, { action: 'export', entity: 'payoutSheet', entityId: id, after: { number: sheet.number } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payout-sheet-${id}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

export default router;
