import type { Request } from 'express';
import { prisma } from '../lib/prisma.js';
import { serialize } from '../lib/serialize.js';

interface AuditInput {
  action: 'create' | 'update' | 'delete' | 'restore' | 'login';
  entity: string;
  entityId?: number | null;
  before?: unknown;
  after?: unknown;
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? '';
}

// Пишет запись аудита со снимками «до/после» (JSON).
export async function writeAudit(req: Request, input: AuditInput) {
  await prisma.auditLog.create({
    data: {
      userId: req.user?.id ?? null,
      userFio: req.user?.fio ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      before: input.before ? (serialize(input.before) as object) : undefined,
      after: input.after ? (serialize(input.after) as object) : undefined,
      ip: clientIp(req),
    },
  });
}
