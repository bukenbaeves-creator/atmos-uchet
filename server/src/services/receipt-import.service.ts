import ExcelJS from 'exceljs';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(customParseFormat);

export interface ParsedLine {
  name: string;
  qty: number;
  purchasePrice: number;
  series: string | null;
  expiryDate: Date | null; // null = бессрочный
  unit: string | null;
}
export interface ParseError {
  row: number; // номер строки в файле (1-based)
  reason: string;
}

const RE = {
  name: /наимен|назван|позиц|товар|препарат/i,
  qty: /кол-?во|количест|\bqty\b|штук/i,
  price: /цена|закуп|стоим|price/i,
  series: /сери|парти|batch|lot/i,
  expiry: /срок|годн|expir/i,
  date: /дата/i,
  unit: /^ед|единиц|\bunit\b/i,
};

// Приводит файл (xlsx/csv) к сетке строк-ячеек (как в разборе банковской выписки).
async function readGrid(buffer: Buffer, filename: string): Promise<string[][]> {
  const isCsv = /\.csv$/i.test(filename) || (!/\.xlsx?$/i.test(filename) && buffer.slice(0, 2).toString() !== 'PK');
  if (isCsv) {
    const lines = buffer.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
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
  if (!ws) return grid;
  ws.eachRow((row) => {
    const vals = (row.values as unknown[]).slice(1); // exceljs: индекс 0 пустой
    grid.push(vals.map((c) => (c instanceof Date ? c.toISOString() : c == null ? '' : String(c))));
  });
  return grid;
}

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? NaN : n;
}

function parseDate(v: unknown): Date | null | undefined {
  const s = String(v ?? '').trim();
  if (!s) return null; // пусто — допустимо (бессрочный / дата документа)
  const iso = dayjs(s); // ISO из ячейки-даты
  if (s.includes('T') && iso.isValid()) return iso.toDate();
  const d = dayjs(s, ['DD.MM.YYYY', 'D.M.YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY'], true);
  return d.isValid() ? d.toDate() : undefined; // undefined = не распознано (ошибка)
}

// Разбирает файл прихода: ищет строку заголовка, колонки, валидирует строки.
export async function parseReceiptRows(
  buffer: Buffer,
  filename: string,
): Promise<{ rows: ParsedLine[]; errors: ParseError[] }> {
  const grid = await readGrid(buffer, filename);
  if (!grid.length) return { rows: [], errors: [{ row: 0, reason: 'Файл пуст или не распознан' }] };

  // Ищем строку заголовка (где есть колонки «наименование» и «количество»)
  let headerIdx = -1;
  const col: Record<string, number> = {};
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const r = grid[i];
    const found: Record<string, number> = {};
    r.forEach((cell, j) => {
      for (const [key, re] of Object.entries(RE)) {
        if (found[key] === undefined && re.test(cell)) found[key] = j;
      }
    });
    if (found.name !== undefined && found.qty !== undefined) {
      headerIdx = i;
      Object.assign(col, found);
      break;
    }
  }
  if (headerIdx === -1) {
    return { rows: [], errors: [{ row: 0, reason: 'Не найдены колонки «Наименование» и «Количество». Используйте шаблон.' }] };
  }

  const rows: ParsedLine[] = [];
  const errors: ParseError[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i];
    const rowNo = i + 1; // 1-based номер строки в файле
    const name = (r[col.name] ?? '').trim();
    if (!name && r.every((c) => !String(c).trim())) continue; // пустая строка — пропускаем молча
    const problems: string[] = [];
    if (!name) problems.push('пустое наименование');
    const qty = parseNum(r[col.qty]);
    if (!isFinite(qty) || qty <= 0) problems.push('некорректное количество');
    const price = col.price !== undefined ? parseNum(r[col.price]) : 0;
    if (col.price !== undefined && (!isFinite(price) || price < 0)) problems.push('некорректная цена закупа');
    const expiry = col.expiry !== undefined ? parseDate(r[col.expiry]) : null;
    if (expiry === undefined) problems.push('некорректный срок годности');

    if (problems.length) {
      errors.push({ row: rowNo, reason: problems.join('; ') });
      continue;
    }
    rows.push({
      name,
      qty,
      purchasePrice: isFinite(price) ? price : 0,
      series: col.series !== undefined ? (r[col.series] ?? '').trim() || null : null,
      expiryDate: expiry ?? null,
      unit: col.unit !== undefined ? (r[col.unit] ?? '').trim() || null : null,
    });
  }
  return { rows, errors };
}
