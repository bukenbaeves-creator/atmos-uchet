import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, notFound } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';

// Справочник категорий расхода (операция/реабилитация). Читают nurse и admin,
// ведёт — только admin.
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const items = await prisma.expenseCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ items });
  }),
);

const schema = z.object({ name: z.string().trim().min(1, 'Название обязательно').max(100) });

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name } = schema.parse(req.body);
    const created = await prisma.expenseCategory.create({ data: { name } });
    await writeAudit(req, { action: 'create', entity: 'expense_category', entityId: created.id, after: created });
    res.status(201).json(created);
  }),
);

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.expenseCategory.findUnique({ where: { id } });
    if (!before) throw notFound();
    const updated = await prisma.expenseCategory.update({ where: { id }, data: { isActive: false } });
    await writeAudit(req, { action: 'update', entity: 'expense_category', entityId: id, before, after: updated });
    res.json({ ok: true });
  }),
);

export default router;
