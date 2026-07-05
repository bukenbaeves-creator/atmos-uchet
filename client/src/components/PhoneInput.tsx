// Ввод телефона с форматом «+7 700 111 22 33». Backend всё равно нормализует.
export function formatPhone(raw: string): string {
  let d = (raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d[0] === '8') d = '7' + d.slice(1);
  if (d[0] !== '7') d = '7' + d;
  d = d.slice(0, 11);
  const p = d.slice(1); // 10 значащих цифр
  let out = '+7';
  if (p.length > 0) out += ' ' + p.slice(0, 3);
  if (p.length >= 4) out += ' ' + p.slice(3, 6);
  if (p.length >= 7) out += ' ' + p.slice(6, 8);
  if (p.length >= 9) out += ' ' + p.slice(8, 10);
  return out;
}

export function PhoneInput({
  value,
  onChange,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <input
      className="input tabular-nums"
      inputMode="tel"
      required={required}
      placeholder="+7 700 000 00 00"
      value={formatPhone(value ?? '')}
      onChange={(e) => onChange(formatPhone(e.target.value))}
    />
  );
}
