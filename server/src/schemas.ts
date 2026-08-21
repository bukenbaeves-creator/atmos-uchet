import { z } from 'zod';
import { normalizePhone } from './lib/phone.js';

// Обязательная строка с русским сообщением при любом отсутствии/пустоте.
// .trim() отсекает строки из одних пробелов и чистит края.
export const requiredString = (msg: string, max = 500) =>
  z.string({ required_error: msg, invalid_type_error: msg }).trim().min(1, msg).max(max, 'Слишком длинное значение');

// Необязательная строка с ограничением длины (защита от «простыней» в БД).
export const optionalString = (max = 2000) =>
  z.string().trim().max(max, 'Слишком длинное значение').optional().nullable();

// Разумные границы бизнес-дат: не раньше 2020 и не позже «сегодня + 2 года».
// Будущее РАЗРЕШЕНО (оплата раньше консультации, плановая операция), но в пределах.
const DATE_MIN = new Date('2020-01-01T00:00:00.000Z');
const dateMax = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 2);
  return d;
};
function inBounds(d: Date): boolean {
  return d.getTime() >= DATE_MIN.getTime() && d.getTime() <= dateMax().getTime();
}

// Сообщение для дат вне бизнес-диапазона — раньше сливалось с «необходимо указать
// дату», из-за чего пользователь не понимал, что дата УКАЗАНА, но не проходит границы.
const OUT_OF_RANGE_MSG = 'Дата вне допустимого диапазона (с 2020 года и не дальше чем через 2 года)';

// Обязательная дата: пусто/нераспознано -> required-сообщение; вне диапазона -> своё сообщение.
export const requiredDate = (msg: string) =>
  z.preprocess((v) => {
    if (v === '' || v == null) return undefined;
    const d = v instanceof Date ? v : new Date(v as string);
    if (isNaN(d.getTime())) return undefined;
    return inBounds(d) ? d : NaN; // NaN -> invalid_type_error (диапазон)
  }, z.date({ required_error: msg, invalid_type_error: OUT_OF_RANGE_MSG }));

// Необязательная дата: пусто/неверно -> null; вне разумного диапазона -> ошибка.
export const optionalDate = z.preprocess((v) => {
  if (v === '' || v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  if (isNaN(d.getTime())) return null;
  return inBounds(d) ? d : NaN;
}, z.date({ invalid_type_error: OUT_OF_RANGE_MSG }).nullable());

// Срок годности: СВОЯ верхняя граница (+15 лет). У медикаментов срок годности законно
// дальше бизнес-горизонта обычных дат (+2 года) — из-за общей границы приход медсестры
// «периодически» падал на позициях со сроком 2029+.
const expiryMax = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 15);
  return d;
};
export const expiryDateSchema = z.preprocess((v) => {
  if (v === '' || v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  if (isNaN(d.getTime())) return null;
  return d.getTime() >= DATE_MIN.getTime() && d.getTime() <= expiryMax().getTime() ? d : NaN;
}, z.date({ invalid_type_error: 'Недопустимый срок годности (проверьте год: допустимо с 2020 до +15 лет)' }).nullable());

// Дата рождения: не в будущем, не раньше 1900.
export const birthDateSchema = z.preprocess((v) => {
  if (v === '' || v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  if (isNaN(d.getTime())) return null;
  const tooOld = d.getTime() < new Date('1900-01-01').getTime();
  const future = d.getTime() > Date.now();
  return tooOld || future ? NaN : d;
}, z.date({ invalid_type_error: 'Некорректная дата рождения' }).nullable());

// Денежная сумма: конечное неотрицательное число до 1 млрд, максимум 2 знака.
// Отсекает Infinity (из «1e400»), NaN и абсурдно большие суммы.
export const moneyAmount = (opts: { positive?: boolean; msg?: string } = {}) => {
  const base = z.coerce
    .number({ invalid_type_error: 'Сумма должна быть числом' })
    .finite('Недопустимая сумма')
    .max(1_000_000_000, 'Сумма слишком большая');
  return opts.positive
    ? base.positive(opts.msg ?? 'Сумма должна быть больше нуля')
    : base.nonnegative('Сумма не может быть отрицательной');
};

// Встроенные данные пациента (вводятся прямо в форме журнала).
// Город обязателен по требованию заказчика. Телефон проверяется ПОСЛЕ нормализации
// (иначе «abc» прошёл бы min(3), а после нормализации стал бы пустым).
export const patientInputSchema = z.object({
  fio: requiredString('Необходимо указать ФИО пациента', 200),
  phone: z
    .string({ required_error: 'Необходимо указать телефон пациента', invalid_type_error: 'Необходимо указать телефон пациента' })
    .transform((v) => normalizePhone(v))
    .refine((v) => v.replace(/\D/g, '').length >= 10, 'Необходимо указать корректный телефон пациента'),
  city: requiredString('Необходимо указать город', 100),
  birthDate: birthDateSchema,
});
