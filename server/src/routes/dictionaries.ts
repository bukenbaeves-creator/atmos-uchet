import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.service.js';
import {
  DICTIONARY_CATEGORIES,
  allDictionaries,
  listByCategory,
} from '../services/dictionary.service.js';

const router = Router();
router.use(requireAuth);

// Все справочники разом (для селектов на клиенте)
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await allDictionaries());
  }),
);

// Список значений категории (для экрана управления справочниками)
router.get(
  '/:category',
  asyncHandler(async (req, res) => {
    const category = req.params.category;
    if (!DICTIONARY_CATEGORIES.includes(category as never)) throw badRequest('Неизвестная категория');
    res.json(await listByCategory(category));
  }),
);

const itemSchema = z.object({
  category: z.enum(DICTIONARY_CATEGORIES),
  label: z.string().min(1, 'Значение обязательно'),
  sortOrder: z.coerce.number().int().default(0),
  active: z.coerce.boolean().default(true),
});

// Справочниками управляют и операторы, и админы (requireAuth на роутере).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = itemSchema.parse(req.body);
    const created = await prisma.dictionaryItem.create({ data });
    await writeAudit(req, { action: 'create', entity: 'dictionary', entityId: created.id, after: created });
    res.status(201).json(created);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.dictionaryItem.findUnique({ where: { id } });
    if (!before) throw badRequest('Значение не найдено');
    const data = itemSchema.partial().parse(req.body);
    const updated = await prisma.dictionaryItem.update({ where: { id }, data });
    await writeAudit(req, {
      action: 'update',
      entity: 'dictionary',
      entityId: id,
      before,
      after: updated,
    });
    res.json(updated);
  }),
);

// Деактивация значения (мягко — историю не ломаем)
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.dictionaryItem.findUnique({ where: { id } });
    if (!before) throw badRequest('Значение не найдено');
    const updated = await prisma.dictionaryItem.update({ where: { id }, data: { active: false } });
    await writeAudit(req, {
      action: 'update',
      entity: 'dictionary',
      entityId: id,
      before,
      after: updated,
    });
    res.json({ ok: true });
  }),
);

export default router;
