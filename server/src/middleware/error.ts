import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from '../lib/http.js';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Ошибка валидации',
      details: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Запись с таким уникальным значением уже существует' });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({ error: 'Нарушена связь между записями' });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Запись не найдена' });
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error('Prisma validation:', err.message);
    return res.status(400).json({ error: 'Некорректные данные запроса' });
  }
  console.error('Необработанная ошибка:', err);
  return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}
