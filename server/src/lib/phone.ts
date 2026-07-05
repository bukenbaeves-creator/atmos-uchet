// Приведение телефона к единому формату (раздел 10 ТЗ).
// Казахстан/Россия: 11 цифр, ведущая 8 -> +7. Иначе сохраняем цифры с ведущим +.
export function normalizePhone(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  let d = digits;
  if (d.length === 11 && (d.startsWith('8') || d.startsWith('7'))) {
    d = '7' + d.slice(1);
  } else if (d.length === 10) {
    d = '7' + d;
  }
  return '+' + d;
}
