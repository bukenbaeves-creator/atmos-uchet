import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/http.js';

// Требует роль admin.
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== 'admin') return next(forbidden('Действие доступно только администратору'));
  next();
}

// Требует одну из перечисленных ролей (например, requireRole('nurse', 'admin')).
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('Недостаточно прав для этого раздела'));
    next();
  };
}

// Правило редактирования для оператора: он может менять только СВОЮ запись,
// созданную СЕГОДНЯ. Админ — любую. Используется в CRUD-фабрике.
export function canEditRecord(
  user: { id: number; role: string },
  record: { createdBy: number | null; createdAt: Date },
): boolean {
  if (user.role === 'admin') return true;
  if (record.createdBy !== user.id) return false;
  const created = new Date(record.createdAt);
  const now = new Date();
  return (
    created.getFullYear() === now.getFullYear() &&
    created.getMonth() === now.getMonth() &&
    created.getDate() === now.getDate()
  );
}
