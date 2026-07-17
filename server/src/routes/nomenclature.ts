import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { serialize } from '../lib/serialize.js';

// Справочник номенклатуры. Читают nurse и admin; модерация (подтверждение draft,
// правка атрибутов) — только admin. Стоимости в этой сущности нет (цена — в партии).
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

// Список. ?status=draft|active — фильтр; по умолчанию активные для выбора в формах.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const where: Record<string, unknown> = { deletedAt: null };
    if (q.status === 'draft' || q.status === 'active') where.status = q.status;
    const search = typeof q.search === 'string' ? q.search.trim() : '';
    if (search) where.nameDisplay = { contains: search, mode: 'insensitive' };
    const items = await prisma.nomenclature.findMany({
      where,
      orderBy: [{ status: 'asc' }, { nameDisplay: 'asc' }],
      take: 500,
    });
    res.json({ items: serialize(items) });
  }),
);

// Атрибуты, которые администратор заполняет при подтверждении позиции.
const attrsSchema = z.object({
  nameDisplay: z.string().trim().min(1).max(300).optional(),
  type: z.enum(['drug', 'consumable']).optional(),
  unitMeasure: z.string().trim().max(50).optional().nullable(),
  unitWriteoff: z.string().trim().max(50).optional().nullable(),
  packFactor: z.coerce.number().positive().max(1_000_000).optional(),
  minStock: z.coerce.number().nonnegative().max(1_000_000).optional(),
  isSpecial: z.coerce.boolean().optional(),
  isExpiryTracked: z.coerce.boolean().optional(),
});

// Правка атрибутов позиции (admin).
router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.nomenclature.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw notFound();
    const data = attrsSchema.parse(req.body);
    const updated = await prisma.nomenclature.update({ where: { id }, data: { ...data, updatedBy: req.user!.id } });
    await writeAudit(req, { action: 'update', entity: 'nomenclature', entityId: id, before, after: updated });
    res.json(serialize(updated));
  }),
);

// Подтверждение позиции из draft в active (admin): переносит из очереди модерации
// в «чистый» справочник; можно заодно передать атрибуты.
router.patch(
  '/:id/confirm',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.nomenclature.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw notFound();
    if (before.status === 'active') throw badRequest('Позиция уже подтверждена');
    const data = attrsSchema.parse(req.body ?? {});
    const updated = await prisma.nomenclature.update({
      where: { id },
      data: { ...data, status: 'active', confirmedBy: req.user!.id, confirmedAt: new Date(), updatedBy: req.user!.id },
    });
    await writeAudit(req, { action: 'update', entity: 'nomenclature', entityId: id, before, after: updated });
    res.json(serialize(updated));
  }),
);

// Массовое подтверждение (admin): переводит выбранные позиции из draft в active.
// Можно передать общие атрибуты (attrs) — они применятся сразу ко всем выбранным
// (кроме наименования — оно у каждой позиции своё). Переданы только те поля,
// которые администратор реально указал; остальное у позиций не меняется. Уже
// подтверждённые/несуществующие среди выбранных просто игнорируются.
const bulkAttrsSchema = attrsSchema.omit({ nameDisplay: true });
const bulkSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).min(1, 'Не выбрано ни одной позиции').max(1000),
  attrs: bulkAttrsSchema.optional(),
});
router.patch(
  '/confirm-bulk',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { ids, attrs } = bulkSchema.parse(req.body);
    const drafts = await prisma.nomenclature.findMany({
      where: { id: { in: ids }, status: 'draft', deletedAt: null },
    });
    if (!drafts.length) throw badRequest('Среди выбранных нет позиций на подтверждении');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      for (const n of drafts) {
        const updated = await tx.nomenclature.update({
          where: { id: n.id },
          data: { ...(attrs ?? {}), status: 'active', confirmedBy: req.user!.id, confirmedAt: now, updatedBy: req.user!.id },
        });
        await writeAudit(req, { action: 'update', entity: 'nomenclature', entityId: n.id, before: n, after: updated }, tx);
      }
    });
    res.json({ confirmed: drafts.length });
  }),
);

// Слияние дубля номенклатуры в основную позицию (admin). Переносит партии,
// списания и алиасы, дубль помечается удалённым и хранит ссылку mergedIntoId.
router.post(
  '/:id/merge',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { intoId } = z.object({ intoId: z.coerce.number().int().positive() }).parse(req.body);
    if (id === intoId) throw badRequest('Нельзя объединить позицию саму с собой');

    await prisma.$transaction(async (tx) => {
      const dup = await tx.nomenclature.findFirst({ where: { id, deletedAt: null } });
      const target = await tx.nomenclature.findFirst({ where: { id: intoId, deletedAt: null } });
      if (!dup) throw notFound('Позиция-дубль не найдена');
      if (!target) throw notFound('Основная позиция не найдена');
      if (target.status !== 'active') throw badRequest('Основная позиция должна быть подтверждена');

      // Переносим движения и партии на основную позицию
      await tx.batch.updateMany({ where: { nomenclatureId: id }, data: { nomenclatureId: intoId } });
      await tx.expenseWriteoff.updateMany({ where: { nomenclatureId: id }, data: { nomenclatureId: intoId } });
      // Алиасы дубля переносим на цель; конфликтующие по уникальному ключу удаляем
      const dupAliases = await tx.nomenclatureAlias.findMany({ where: { nomenclatureId: id } });
      for (const a of dupAliases) {
        const clash = await tx.nomenclatureAlias.findFirst({
          where: { aliasNormalized: a.aliasNormalized, NOT: { id: a.id } },
        });
        if (clash) await tx.nomenclatureAlias.delete({ where: { id: a.id } });
        else await tx.nomenclatureAlias.update({ where: { id: a.id }, data: { nomenclatureId: intoId } });
      }

      const updated = await tx.nomenclature.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: req.user!.id, mergedIntoId: intoId, updatedBy: req.user!.id },
      });
      await writeAudit(req, { action: 'update', entity: 'nomenclature', entityId: id, before: dup, after: updated }, tx);
    });
    res.json({ ok: true });
  }),
);

export default router;
