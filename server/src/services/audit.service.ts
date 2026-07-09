import type { Request } from 'express';
import { prisma } from '../lib/prisma.js';
import type { PrismaClientOrTx } from '../lib/prisma.js';
import { serialize } from '../lib/serialize.js';

interface AuditInput {
  action: 'create' | 'update' | 'delete' | 'restore' | 'login' | 'login_failed' | 'export';
  entity: string;
  entityId?: number | null;
  before?: unknown;
  after?: unknown;
}

// IP берём из req.ip (Express учитывает trust proxy — за Render/Nginx это реальный
// клиентский адрес, а сырой X-Forwarded-For клиент мог бы подделать).
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? '';
}

// Пишет запись аудита со снимками «до/после» (JSON). client — для записи внутри
// транзакции (по умолчанию глобальный prisma).
export async function writeAudit(req: Request, input: AuditInput, client: PrismaClientOrTx = prisma) {
  await client.auditLog.create({
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
