import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { hashPassword } from '../lib/auth.js';
import { writeAudit } from '../services/audit.service.js';

const router = Router();
router.use(requireAuth, requireAdmin);

const publicUser = { id: true, login: true, fio: true, role: true, active: true, createdAt: true } as const;

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ select: publicUser, orderBy: { id: 'asc' } });
    res.json({ items: users });
  }),
);

const createSchema = z.object({
  login: z.string().min(3, 'Логин минимум 3 символа'),
  fio: z.string().min(1, 'ФИО обязательно'),
  role: z.enum(['admin', 'operator', 'nurse']),
  password: z.string().min(6, 'Пароль минимум 6 символов'),
  active: z.coerce.boolean().default(true),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { password, ...rest } = createSchema.parse(req.body);
    const passwordHash = await hashPassword(password);
    const created = await prisma.user.create({
      data: { ...rest, passwordHash },
      select: publicUser,
    });
    await writeAudit(req, { action: 'create', entity: 'user', entityId: created.id, after: created });
    res.status(201).json(created);
  }),
);

const updateSchema = z.object({
  fio: z.string().min(1).optional(),
  role: z.enum(['admin', 'operator', 'nurse']).optional(),
  active: z.coerce.boolean().optional(),
  password: z.string().min(6).optional(),
});

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.user.findUnique({ where: { id }, select: publicUser });
    if (!before) throw notFound('Пользователь не найден');
    const { password, ...rest } = updateSchema.parse(req.body);
    // Защита от блокировки системы: нельзя лишить прав/деактивировать последнего админа
    const losesAdmin = (rest.role && rest.role !== 'admin') || rest.active === false;
    if (before.role === 'admin' && before.active && losesAdmin) {
      const activeAdmins = await prisma.user.count({ where: { role: 'admin', active: true } });
      if (activeAdmins <= 1) throw badRequest('Нельзя лишить прав единственного администратора');
    }
    const data: Record<string, unknown> = { ...rest };
    if (password) data.passwordHash = await hashPassword(password);
    const updated = await prisma.user.update({ where: { id }, data, select: publicUser });
    await writeAudit(req, { action: 'update', entity: 'user', entityId: id, before, after: updated });
    res.json(updated);
  }),
);

// Блокировка/разблокировка
router.patch(
  '/:id/toggle',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound('Пользователь не найден');
    if (user.role === 'admin' && user.active) {
      const activeAdmins = await prisma.user.count({ where: { role: 'admin', active: true } });
      if (activeAdmins <= 1) throw badRequest('Нельзя заблокировать единственного администратора');
    }
    const updated = await prisma.user.update({
      where: { id },
      data: { active: !user.active },
      select: publicUser,
    });
    await writeAudit(req, { action: 'update', entity: 'user', entityId: id, before: { active: user.active }, after: { active: updated.active } });
    res.json(updated);
  }),
);

export default router;
