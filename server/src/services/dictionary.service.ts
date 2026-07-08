import type { Request } from 'express';
import { prisma, type PrismaClientOrTx } from '../lib/prisma.js';
import { badRequest } from '../lib/http.js';
import { writeAudit } from './audit.service.js';

// Категории справочников
// Категория surgeon упразднена: врач операции берётся из общего справочника doctor
export const DICTIONARY_CATEGORIES = [
  'city',
  'doctor',
  'op_type',
  'pay_method',
  'terminal',
  'service_type',
  'consultation_stage',
  'vid',
  'zapis',
  'manager',
] as const;

export type DictionaryCategory = (typeof DICTIONARY_CATEGORIES)[number];

// Проверяет, что значение допустимо для категории (есть в справочнике и активно).
// Пустые значения пропускаются (для необязательных полей).
export async function assertDictionaryValue(
  category: DictionaryCategory,
  value: string | null | undefined,
  client: PrismaClientOrTx = prisma,
) {
  if (value === null || value === undefined || value === '') return;
  const found = await client.dictionaryItem.findFirst({
    where: { category, label: value, active: true },
  });
  if (!found) {
    throw badRequest(`Недопустимое значение «${value}» для справочника «${category}»`);
  }
}

// Гарантирует наличие активного значения в справочнике. Для полей, где пользователь
// может ввести свой вариант (итог консультации): отсутствующее значение создаётся
// в конце списка, неактивное — реактивируется. Сравнение без учёта регистра, чтобы
// «успех» не плодил дубль к «Успех». Создание/изменение пишется в аудит.
export async function ensureDictionaryValue(
  category: DictionaryCategory,
  value: string | null | undefined,
  req: Request,
  client: PrismaClientOrTx = prisma,
) {
  if (value === null || value === undefined || value === '') return;
  const existing = await client.dictionaryItem.findFirst({
    where: { category, label: { equals: value, mode: 'insensitive' } },
  });
  if (existing?.active) return;
  if (existing) {
    const updated = await client.dictionaryItem.update({ where: { id: existing.id }, data: { active: true } });
    await writeAudit(req, { action: 'update', entity: 'dictionary', entityId: existing.id, before: existing, after: updated }, client);
    return;
  }
  const max = await client.dictionaryItem.aggregate({ where: { category }, _max: { sortOrder: true } });
  const created = await client.dictionaryItem.create({
    data: { category, label: value, sortOrder: (max._max.sortOrder ?? 0) + 1 },
  });
  await writeAudit(req, { action: 'create', entity: 'dictionary', entityId: created.id, after: created }, client);
}

export async function listByCategory(category: string) {
  return prisma.dictionaryItem.findMany({
    where: { category },
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
  });
}

// Все справочники разом (для загрузки селектов на клиенте).
export async function allDictionaries() {
  const items = await prisma.dictionaryItem.findMany({
    where: { active: true },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
  });
  const grouped: Record<string, { id: number; label: string }[]> = {};
  for (const cat of DICTIONARY_CATEGORIES) grouped[cat] = [];
  for (const it of items) {
    (grouped[it.category] ??= []).push({ id: it.id, label: it.label });
  }
  return grouped;
}
