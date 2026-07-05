// Условия поиска пациента по ФИО и телефону.
// Телефон ищем по значащим цифрам, отбрасывая ведущую 8/7 (код страны),
// чтобы «87001112233», «7001112233» и «+7 700 111 22 33» находили одну запись.
export function patientSearchOR(term: string, viaRelation = false): Record<string, unknown>[] {
  const t = (term ?? '').trim();
  const digits = t.replace(/\D/g, '');
  const local = digits.length >= 11 && (digits[0] === '8' || digits[0] === '7') ? digits.slice(1) : digits;

  const fioCond = viaRelation
    ? { patient: { fio: { contains: t, mode: 'insensitive' } } }
    : { fio: { contains: t, mode: 'insensitive' } };

  const or: Record<string, unknown>[] = [fioCond];
  if (digits) {
    or.push(viaRelation ? { patient: { phone: { contains: local } } } : { phone: { contains: local } });
  }
  return or;
}
