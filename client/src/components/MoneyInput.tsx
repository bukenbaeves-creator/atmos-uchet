// Ввод суммы с разбивкой на разряды на лету: «1 500 000». Хранит чистое число.
export function MoneyInput({
  value,
  onChange,
}: {
  value: number | string | null | undefined;
  onChange: (v: string) => void;
}) {
  const digits = value === '' || value == null ? '' : String(value).replace(/\D/g, '');
  const display = digits ? Number(digits).toLocaleString('ru-RU') : '';
  return (
    <input
      className="input text-right tabular-nums"
      inputMode="numeric"
      placeholder="0"
      value={display}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
    />
  );
}
