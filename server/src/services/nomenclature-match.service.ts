import type { Request } from 'express';
import type { PrismaClientOrTx } from '../lib/prisma.js';
import { writeAudit } from './audit.service.js';

// Нормализация наименования для сопоставления: нижний регистр, схлопывание
// пробелов, унификация единиц (ml→мл), латиница-двойники→кириллица, удаление
// разделителей. Цель — чтобы «Шприц 5мл», «шприц 5 ml», «Шприц 5 МЛ» сводились
// к одному ключу и не плодили дубли в справочнике.
const LATIN_TO_CYR: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

export function normalizeName(raw: string): string {
  let s = (raw ?? '').toLowerCase().trim();
  // Разделяем число и буквы пробелом, чтобы «5мл» == «5 мл» == «5 ml».
  s = s.replace(/(\d)(\p{L})/gu, '$1 $2').replace(/(\p{L})(\d)/gu, '$1 $2');
  // Унификация единиц измерения (латинские записи → кириллица)
  s = s
    .replace(/\bml\b/g, 'мл')
    .replace(/\bmg\b/g, 'мг')
    .replace(/\bg\b/g, 'г')
    .replace(/\bpcs\b/g, 'шт')
    .replace(/\bшт\.?\b/g, 'шт');
  // Латинские буквы, визуально совпадающие с кириллицей, → кириллица
  s = s.replace(/[abcehkmoptxy]/g, (ch) => LATIN_TO_CYR[ch] ?? ch);
  // Убираем всё, кроме букв/цифр/пробелов; схлопываем пробелы
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

export interface MatchResult {
  nomenclatureId: number;
  created: boolean; // была создана новая позиция (draft)
}

// Находит позицию номенклатуры по наименованию из прихода (по нормализованному
// имени и по алиасам) либо создаёт новую в статусе draft (очередь модерации).
// Новое написание уже известной позиции добавляется как alias.
export async function matchOrCreateNomenclature(
  rawName: string,
  req: Request,
  tx: PrismaClientOrTx,
): Promise<MatchResult> {
  const display = (rawName ?? '').trim();
  const normalized = normalizeName(display);
  if (!normalized) throw new Error('Пустое наименование позиции');

  // 1) Прямое совпадение по нормализованному имени позиции
  const direct = await tx.nomenclature.findFirst({ where: { nameNormalized: normalized, deletedAt: null } });
  if (direct) {
    await ensureAlias(direct.id, display, normalized, tx);
    return { nomenclatureId: direct.id, created: false };
  }

  // 2) Совпадение по алиасу
  const alias = await tx.nomenclatureAlias.findUnique({ where: { aliasNormalized: normalized } });
  if (alias) {
    await ensureAlias(alias.nomenclatureId, display, normalized, tx);
    return { nomenclatureId: alias.nomenclatureId, created: false };
  }

  // 3) Не нашли — создаём позицию в статусе draft (на подтверждение администратором)
  const created = await tx.nomenclature.create({
    data: {
      nameDisplay: display,
      nameNormalized: normalized,
      status: 'draft',
      createdBy: req.user!.id,
      updatedBy: req.user!.id,
    },
  });
  await tx.nomenclatureAlias.create({
    data: { nomenclatureId: created.id, aliasRaw: display, aliasNormalized: normalized },
  });
  await writeAudit(req, { action: 'create', entity: 'nomenclature', entityId: created.id, after: created }, tx);
  return { nomenclatureId: created.id, created: true };
}

// Добавляет новое написание как alias, если такого ещё нет.
async function ensureAlias(nomenclatureId: number, raw: string, normalized: string, tx: PrismaClientOrTx) {
  const exists = await tx.nomenclatureAlias.findUnique({ where: { aliasNormalized: normalized } });
  if (!exists) {
    await tx.nomenclatureAlias.create({ data: { nomenclatureId, aliasRaw: raw, aliasNormalized: normalized } });
  }
}
