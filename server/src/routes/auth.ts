import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { ApiError, asyncHandler, badRequest, unauthorized } from '../lib/http.js';
import { COOKIE_NAME, hashPassword, signToken, verifyPassword } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { config } from '../lib/config.js';

const router = Router();

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

const registerSchema = z.object({
  login: z.string().min(3, 'Логин минимум 3 символа'),
  fio: z.string().min(1, 'Укажите ФИО'),
  password: z.string().min(6, 'Пароль минимум 6 символов'),
  code: z.string().min(1, 'Укажите код регистрации'),
});

async function getRegCodes() {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['reg_code_operator', 'reg_code_admin'] } },
  });
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { operator: m.reg_code_operator ?? '', admin: m.reg_code_admin ?? '' };
}

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.nodeEnv === 'production',
  maxAge: 12 * 60 * 60 * 1000,
  path: '/',
};

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { login, password } = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { login } });
    if (!user || !user.active) throw unauthorized('Неверный логин или пароль');
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw unauthorized('Неверный логин или пароль');

    const payload = { id: user.id, login: user.login, role: user.role, fio: user.fio };
    const token = signToken(payload);
    res.cookie(COOKIE_NAME, token, cookieOptions);
    req.user = payload;
    await writeAudit(req, { action: 'login', entity: 'user', entityId: user.id });
    res.json({ user: payload });
  }),
);

// Регистрация по коду. Роль определяется введённым кодом (задаётся админом).
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { login, fio, password, code } = registerSchema.parse(req.body);
    const codes = await getRegCodes();

    let role: 'admin' | 'operator' | null = null;
    if (codes.admin && code === codes.admin) role = 'admin';
    else if (codes.operator && code === codes.operator) role = 'operator';
    if (!role) throw badRequest('Неверный код регистрации');

    const exists = await prisma.user.findUnique({ where: { login } });
    if (exists) throw new ApiError(409, 'Пользователь с таким логином уже существует');

    const user = await prisma.user.create({
      data: { login, fio, role, passwordHash: await hashPassword(password) },
    });

    const payload = { id: user.id, login: user.login, role: user.role, fio: user.fio };
    const token = signToken(payload);
    res.cookie(COOKIE_NAME, token, cookieOptions);
    req.user = payload;
    await writeAudit(req, { action: 'create', entity: 'user', entityId: user.id, after: { login, fio, role } });
    res.status(201).json({ user: payload });
  }),
);

// Просмотр/изменение кодов регистрации (только админ)
router.get(
  '/reg-codes',
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getRegCodes());
  }),
);

router.put(
  '/reg-codes',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = z.object({ operator: z.string(), admin: z.string() }).parse(req.body);
    for (const [key, value] of [
      ['reg_code_operator', body.operator],
      ['reg_code_admin', body.admin],
    ] as const) {
      await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    await writeAudit(req, { action: 'update', entity: 'reg_codes' });
    res.json(await getRegCodes());
  }),
);

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    // Подтверждаем, что пользователь всё ещё активен
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user || !user.active) throw unauthorized();
    res.json({ user: req.user });
  }),
);

export default router;
