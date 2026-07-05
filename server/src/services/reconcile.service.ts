import ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { prisma } from '../lib/prisma.js';

dayjs.extend(customParseFormat);

export interface BankRow {
  date: string | null; // ISO
  amount: number;
  description: string;
}

const AMOUNT_RE = /сумма|amount|приход|кредит|поступлен|credit|оборот/i;
const DATE_RE = /дата|date/i;
const DESC_RE = /назнач|коммент|описан|детал|purpose|контрагент|плательщик|detail/i;

function parseAmount(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function parseDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = dayjs(s, ['DD.MM.YYYY', 'D.M.YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY'], true);
  return d.isValid() ? d.toISOString() : null;
}

// Приводим содержимое файла к массиву строк-ячеек
async function readGrid(buffer: Buffer, filename: string): Promise<string[][]> {
  const isCsv = /\.csv$/i.test(filename) || (!/\.xlsx?$/i.test(filename) && buffer.slice(0, 4).toString() !== 'PK');
  if (isCsv) {
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const semi = (lines[0].match(/;/g) || []).length;
    const comma = (lines[0].match(/,/g) || []).length;
    const delim = semi >= comma ? ';' : ',';
    return lines.map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim()));
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const grid: string[][] = [];
  ws.eachRow((row) => {
    const vals = (row.values as unknown[]).slice(1); // exceljs: индекс 0 пустой
    grid.push(vals.map((c) => (c instanceof Date ? c.toISOString() : c == null ? '' : String(c))));
  });
  return grid;
}

// Разбор выписки: ищем строку заголовка и колонки даты/суммы/назначения
export async function parseStatement(
  buffer: Buffer,
  filename: string,
): Promise<{ rows: BankRow[]; headers: string[] }> {
  const grid = await readGrid(buffer, filename);
  if (!grid.length) return { rows: [], headers: [] };

  let headerIdx = -1;
  let amountCol = -1;
  let dateCol = -1;
  let descCol = -1;

  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const r = grid[i];
    const a = r.findIndex((c) => AMOUNT_RE.test(c));
    const d = r.findIndex((c) => DATE_RE.test(c));
    if (a >= 0 && d >= 0) {
      headerIdx = i;
      amountCol = a;
      dateCol = d;
      descCol = r.findIndex((c) => DESC_RE.test(c));
      break;
    }
  }

  if (headerIdx < 0) {
    // не нашли по заголовкам — вернём первые строки, чтобы показать пользователю
    return { rows: [], headers: grid[0] ?? [] };
  }

  const rows: BankRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    const amount = parseAmount(r[amountCol]);
    if (!amount || amount <= 0) continue; // только поступления
    rows.push({
      date: parseDate(r[dateCol]),
      amount: Math.round(amount),
      description: descCol >= 0 ? r[descCol] ?? '' : '',
    });
  }
  return { rows, headers: grid[headerIdx] };
}

export interface MatchedPair {
  bank: BankRow;
  payment: { id: number; date: string | null; amount: number; patient: string };
}

// Сопоставление по сумме и дате (± допуск в днях)
export async function reconcile(bankRows: BankRow[], toleranceDays: number) {
  const dates = bankRows.map((r) => r.date).filter(Boolean) as string[];
  const min = dates.length ? dayjs(dates.reduce((a, b) => (a < b ? a : b))).subtract(toleranceDays + 1, 'day') : null;
  const max = dates.length ? dayjs(dates.reduce((a, b) => (a > b ? a : b))).add(toleranceDays + 1, 'day') : null;

  const payments = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      ...(min && max ? { date: { gte: min.toDate(), lte: max.toDate() } } : {}),
    },
    include: { patient: { select: { fio: true } } },
    orderBy: { date: 'asc' },
  });

  const pool = payments.map((p) => ({
    id: p.id,
    date: p.date ? p.date.toISOString() : null,
    amount: Math.round(Number(p.amount)),
    patient: p.patient?.fio ?? '—',
    used: false,
  }));

  const matched: MatchedPair[] = [];
  const unmatchedBank: BankRow[] = [];

  for (const row of bankRows) {
    const idx = pool.findIndex((p) => {
      if (p.used || p.amount !== row.amount) return false;
      if (!row.date || !p.date) return true; // если даты нет — сверяем только по сумме
      return Math.abs(dayjs(p.date).diff(dayjs(row.date), 'day')) <= toleranceDays;
    });
    if (idx >= 0) {
      pool[idx].used = true;
      const { used, ...pay } = pool[idx];
      matched.push({ bank: row, payment: pay });
    } else {
      unmatchedBank.push(row);
    }
  }

  const unmatchedSystem = pool
    .filter((p) => !p.used)
    .map(({ used, ...p }) => p);

  const sum = (arr: { amount: number }[]) => arr.reduce((s, x) => s + x.amount, 0);

  return {
    summary: {
      bankCount: bankRows.length,
      bankTotal: sum(bankRows),
      matchedCount: matched.length,
      matchedTotal: sum(matched.map((m) => m.bank)),
      unmatchedBankCount: unmatchedBank.length,
      unmatchedBankTotal: sum(unmatchedBank),
      unmatchedSystemCount: unmatchedSystem.length,
      unmatchedSystemTotal: sum(unmatchedSystem),
    },
    matched,
    unmatchedBank,
    unmatchedSystem,
  };
}
