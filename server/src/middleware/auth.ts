import type { NextFunction, Request, Response } from 'express';
import { COOKIE_NAME, verifyToken } from '../lib/auth.js';
import { unauthorized } from '../lib/http.js';

// Проверяет JWT из httpOnly-cookie и кладёт пользователя в req.user.
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next(unauthorized());
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(unauthorized('Сессия истекла, войдите заново'));
  }
}
