import { z } from 'zod';

// Обязательная строка с русским сообщением при любом отсутствии/пустоте.
export const requiredString = (msg: string) =>
  z.string({ required_error: msg, invalid_type_error: msg }).min(1, msg);

// Обязательная дата: пусто/неверно ('' , null, undefined, Invalid) -> русская ошибка.
export const requiredDate = (msg: string) =>
  z.preprocess((v) => {
    if (v === '' || v == null) return undefined;
    const d = v instanceof Date ? v : new Date(v as string);
    return isNaN(d.getTime()) ? undefined : d;
  }, z.date({ required_error: msg, invalid_type_error: msg }));

// Необязательная дата: пусто/неверно -> null.
export const optionalDate = z.preprocess((v) => {
  if (v === '' || v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
}, z.date().nullable());

// Встроенные данные пациента (вводятся прямо в форме журнала).
// Город обязателен по требованию заказчика.
export const patientInputSchema = z.object({
  fio: requiredString('Необходимо указать ФИО пациента'),
  phone: z
    .string({ required_error: 'Необходимо указать телефон пациента', invalid_type_error: 'Необходимо указать телефон пациента' })
    .min(3, 'Необходимо указать телефон пациента'),
  city: requiredString('Необходимо указать город'),
  birthDate: optionalDate,
});
