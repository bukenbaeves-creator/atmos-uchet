import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, unauthorized } from '../lib/http.js';
import { COOKIE_NAME, signToken, verifyPassword } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../services/audit.service.js';
import { config } from '../lib/config.js';

const router = Router();

const loginSchema = z.object({
  login: z.string().min(1),
  password: z.string().min(1),
});

// Блокировка при переборе: после 5 неверных попыток — на 15 минут.
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

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
    // Единое сообщение — не раскрываем, существует ли логин
    if (!user || !user.active) throw unauthorized('Неверный логин или пароль');

    // Временная блокировка при переборе
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw unauthorized('Аккаунт временно заблокирован из-за попыток входа. Повторите позже.');
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const failed = user.failedAttempts + 1;
      const lock = failed >= MAX_FAILED;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: lock ? 0 : failed,
          lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : user.lockedUntil,
        },
      });
      // Фиксируем неудачную попытку (логин + IP, без пароля)
      await writeAudit(req, { action: 'login_failed', entity: 'user', entityId: user.id, after: { login } });
      throw unauthorized(
        lock ? 'Слишком много неверных попыток. Аккаунт заблокирован на 15 минут.' : 'Неверный логин или пароль',
      );
    }

    // Успех — сбрасываем счётчик/блокировку
    if (user.failedAttempts || user.lockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
    }
    const payload = { id: user.id, login: user.login, role: user.role, fio: user.fio };
    const token = signToken(payload);
    res.cookie(COOKIE_NAME, token, cookieOptions);
    req.user = payload;
    await writeAudit(req, { action: 'login', entity: 'user', entityId: user.id });
    res.json({ user: payload });
  }),
);

// Публичная саморегистрация закрыта: пользователей заводит только администратор
// в разделе «Пользователи». Эндпоинт отвечает 403, чтобы не оставлять открытой
// точки создания аккаунтов.
router.post('/register', (_req, res) => {
  res.status(403).json({ error: 'Регистрация закрыта. Обратитесь к администратору.' });
});

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
