import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (m: string) => new ApiError(400, m);
export const unauthorized = (m = 'Требуется авторизация') => new ApiError(401, m);
export const forbidden = (m = 'Недостаточно прав') => new ApiError(403, m);
export const notFound = (m = 'Запись не найдена') => new ApiError(404, m);

// Оборачивает async-обработчик, чтобы ошибки уходили в errorHandler.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
