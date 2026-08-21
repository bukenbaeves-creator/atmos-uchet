// Ввод суммы с разбивкой на разряды на лету: «1 500 000». Хранит чистое число строкой.
// Поддерживает один десятичный разделитель («,» или «.») до 2 знаков: «12,50» → 12.5.
// Раньше запятая вырезалась и «12,50» превращалось в 1250 (цена ×100) — исправлено.

// Разбор ввода: цифры + первый встреченный разделитель, дробная часть до 2 цифр.
function parseRaw(raw: string): string {
  const cleaned = raw.replace(/[^\d.,]/g, '');
  const sep = cleaned.search(/[.,]/);
  if (sep === -1) return cleaned;
  const int = cleaned.slice(0, sep).replace(/\D/g, '');
  const frac = cleaned.slice(sep + 1).replace(/\D/g, '').slice(0, 2);
  return `${int}.${frac}`;
}

// Отображение: целая часть с пробелами разрядов, дробная — через запятую.
// Хвостовой разделитель сохраняется («12,» — пользователь продолжает ввод).
function formatDisplay(v: number | string | null | undefined): string {
  if (v === '' || v == null) return '';
  const s = String(v);
  const sep = s.indexOf('.');
  const int = (sep === -1 ? s : s.slice(0, sep)).replace(/\D/g, '');
  const intFmt = int ? Number(int).toLocaleString('ru-RU') : sep !== -1 ? '0' : '';
  if (sep === -1) return intFmt;
  const frac = s.slice(sep + 1).replace(/\D/g, '');
  return `${intFmt},${frac}`;
}

export function MoneyInput({
  value,
  onChange,
  required,
}: {
  value: number | string | null | undefined;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <input
      className="input text-right tabular-nums"
      inputMode="decimal"
      required={required}
      placeholder="0"
      value={formatDisplay(value)}
      onChange={(e) => onChange(parseRaw(e.target.value))}
    />
  );
}
