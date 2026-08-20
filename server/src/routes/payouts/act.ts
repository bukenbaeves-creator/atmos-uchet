import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, notFound } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { getSheet, getSheetRegistry } from '../../services/payout-sheet.service.js';

// Печатная форма акта выполненных работ (Э4-4). HTML-страница (не PDF-библиотека):
// реквизиты клиники, ФИО и ИИН врача, период, перечень услуг, сумма, места для
// подписей. Суммы — те же, что в реестре. Только администратор.
const router = Router();
router.use(requireAuth, requireAdmin);

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const money = (v: number) => Number(v).toLocaleString('ru-RU');
const dstr = (v: Date | string | null) => (v ? new Date(v).toLocaleDateString('ru-RU') : '');

router.get(
  '/:id/lines/:lineId/act',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const lineId = Number(req.params.lineId);
    const sheet = await getSheet(id);
    const line = sheet.lines.find((l) => l.id === lineId);
    if (!line) throw notFound('Строка ведомости не найдена');
    const payee = await prisma.doctorPayee.findUnique({ where: { id: line.payeeId } });
    const reg = await getSheetRegistry(id, line.payeeId);

    const withhold = ((line.withholdings as Array<{ type: string; amount: number }>) ?? []).reduce((s, w) => s + Number(w.amount), 0);
    const rows = reg.rows
      .map(
        (r, i) => `<tr>
        <td>${i + 1}</td>
        <td>${dstr(r.dateOp)}</td>
        <td>${esc(r.patient ?? (r.isCorrection ? 'корректировка' : ''))}</td>
        <td>${esc(r.opType ?? '')}</td>
        <td class="r">${money(r.amount)}</td>
      </tr>`,
      )
      .join('');

    const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Акт · ${esc(payee?.fio ?? '')}</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:820px;margin:24px auto;padding:0 16px}
  h1{font-size:20px;text-align:center;margin:0 0 4px}
  .sub{text-align:center;color:#555;margin-bottom:20px}
  .req{color:#555;font-size:13px;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;margin:12px 0}
  th,td{border:1px solid #bbb;padding:6px 8px;text-align:left}
  th{background:#f3f4f6}
  td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
  tfoot td{font-weight:700}
  .totals{margin:12px 0}
  .totals div{display:flex;justify-content:space-between;max-width:360px;margin-left:auto}
  .sign{display:flex;justify-content:space-between;margin-top:48px}
  .sign div{width:45%}
  .line{border-top:1px solid #333;margin-top:32px;padding-top:4px;color:#555;font-size:12px}
  .print{margin:16px 0}
  @media print{.print{display:none}}
</style></head>
<body>
  <div class="print"><button onclick="window.print()">Печать</button></div>
  <div class="req">Исполнитель: клиника пластической хирургии (реквизиты заполняются организацией)</div>
  <h1>АКТ выполненных работ ${line.actNumber ? '№ ' + esc(line.actNumber) : ''}</h1>
  <div class="sub">по ведомости ${esc(sheet.number)}${sheet.periodFrom ? ` за период ${dstr(sheet.periodFrom)} — ${dstr(sheet.periodTo)}` : ''}</div>

  <p>Врач: <b>${esc(payee?.fio ?? '')}</b>${payee?.iin ? `, ИИН ${esc(payee.iin)}` : ''}.
  Операций: <b>${line.operationsCount}</b>.</p>

  <table>
    <thead><tr><th>№</th><th>Дата</th><th>Пациент</th><th>Вид операции</th><th class="r">Начислено, ₸</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="4">Итого начислено</td><td class="r">${money(reg.totals.amount)}</td></tr></tfoot>
  </table>

  <div class="totals">
    <div><span>Начислено:</span><span>${money(Number(line.accruedTotal))} ₸</span></div>
    <div><span>Удержания:</span><span>${money(withhold)} ₸</span></div>
    <div><span><b>К выплате:</b></span><span><b>${money(Number(line.toPay))} ₸</b></span></div>
  </div>

  <div class="sign">
    <div><div class="line">Исполнитель (клиника)</div></div>
    <div><div class="line">Врач ${esc(payee?.fio ?? '')}</div></div>
  </div>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }),
);

export default router;
