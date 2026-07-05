import type { NextFunction, Request, Response } from 'express';
import { COOKIE_NAME, verifyToken } from '../lib/auth.js';
import { unauthorized } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';

// Проверяет JWT из httpOnly-cookie и сверяет пользователя с БД:
// роль и признак active берутся из БД, поэтому блокировка/смена роли действуют
// сразу, а не после истечения токена.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next(unauthorized());
  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (!user || !user.active) return next(unauthorized('Доступ отключён. Войдите заново.'));
    req.user = { id: user.id, login: user.login, role: user.role, fio: user.fio };
    next();
  } catch {
    next(unauthorized('Сессия истекла, войдите заново'));
  }
}
