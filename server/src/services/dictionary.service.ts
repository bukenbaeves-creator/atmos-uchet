import { prisma } from '../lib/prisma.js';
import { badRequest } from '../lib/http.js';

// Категории справочников
export const DICTIONARY_CATEGORIES = [
  'city',
  'doctor',
  'surgeon',
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
) {
  if (value === null || value === undefined || value === '') return;
  const found = await prisma.dictionaryItem.findFirst({
    where: { category, label: value, active: true },
  });
  if (!found) {
    throw badRequest(`Недопустимое значение «${value}» для справочника «${category}»`);
  }
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
