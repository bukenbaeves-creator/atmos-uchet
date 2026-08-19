import type { Request } from 'express';
import type { CalcStage, SchemeKind, ShareMode } from '@prisma/client';
import { prisma, type PrismaClientOrTx } from '../lib/prisma.js';
import { badRequest, notFound } from '../lib/http.js';
import { writeAudit } from './audit.service.js';

// Схема выплаты со всеми настройками (для расчёта и экранов).
const schemeInclude = { items: true, shareValues: true, tariffs: true } as const;

const fmt = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

// Версия схемы, действовавшая на дату операции. ЕДИНСТВЕННЫЙ способ получить схему
// в расчёте: берём запись, чей период [validFrom, validTo] покрывает дату.
export function getSchemeForDate(payeeId: number, date: Date, tx: PrismaClientOrTx = prisma) {
  return tx.payoutScheme.findFirst({
    where: {
      payeeId,
      validFrom: { lte: date },
      OR: [{ validTo: null }, { validTo: { gte: date } }],
    },
    include: schemeInclude,
    orderBy: { validFrom: 'desc' },
  });
}

export interface SchemeItemInput {
  componentId: number;
  enabled?: boolean;
  stage: CalcStage;
  useOwnValue?: boolean;
  value?: number | null;
  filter?: unknown;
  sortOrder?: number;
}
export interface SchemeInput {
  payeeId: number;
  name: string;
  kind?: SchemeKind;
  shareMode?: ShareMode;
  shareValue?: number | null;
  costRecovery?: string;
  withholdIpPct?: number;
  validFrom: Date;
  note?: string | null;
  items?: SchemeItemInput[];
  shareValues?: { key: string; share: number }[];
  tariffs?: { anesthesiaType: string; minCount?: number; maxCount?: number | null; amount: number; validFrom: Date }[];
}

// Создание схемы ИЛИ новой версии существующей. У текущей открытой версии проставляется
// validTo = validFrom−1 день и replacedById; у новой version = prev.version+1.
export async function createOrVersionScheme(input: SchemeInput, req: Request) {
  const userId = req.user!.id;
  return prisma.$transaction(async (tx) => {
    const payee = await tx.doctorPayee.findFirst({ where: { id: input.payeeId, deletedAt: null } });
    if (!payee) throw badRequest('Получатель выплаты не найден');

    // Текущая открытая версия (validTo=null) — её будем закрывать.
    const openPrev = await tx.payoutScheme.findFirst({
      where: { payeeId: input.payeeId, validTo: null },
      orderBy: { version: 'desc' },
    });
    if (openPrev && input.validFrom <= openPrev.validFrom) {
      throw badRequest(
        `Дата начала новой версии (${fmt(input.validFrom)}) должна быть позже даты начала текущей версии (${fmt(openPrev.validFrom)}). Периоды схем одного врача не пересекаются.`,
      );
    }
    // TODO(этап 3): запретить validFrom внутри периода, по которому уже есть выплаченная ведомость.

    const maxVer = await tx.payoutScheme.aggregate({ where: { payeeId: input.payeeId }, _max: { version: true } });
    const version = (maxVer._max.version ?? 0) + 1;

    const created = await tx.payoutScheme.create({
      data: {
        payeeId: input.payeeId,
        name: input.name,
        kind: input.kind ?? 'share_based',
        shareMode: input.shareMode ?? 'constant',
        shareValue: input.shareValue ?? null,
        costRecovery: input.costRecovery ?? 'proportional',
        withholdIpPct: input.withholdIpPct ?? 0,
        validFrom: input.validFrom,
        version,
        note: input.note ?? null,
        createdBy: userId,
        updatedBy: userId,
        items: input.items?.length
          ? {
              create: input.items.map((i, idx) => ({
                componentId: i.componentId,
                enabled: i.enabled ?? true,
                stage: i.stage,
                useOwnValue: i.useOwnValue ?? false,
                value: i.value ?? null,
                filter: (i.filter ?? undefined) as never,
                sortOrder: i.sortOrder ?? idx,
              })),
            }
          : undefined,
        shareValues: input.shareValues?.length
          ? { create: input.shareValues.map((s) => ({ key: s.key, share: s.share })) }
          : undefined,
        tariffs: input.tariffs?.length
          ? {
              create: input.tariffs.map((t) => ({
                anesthesiaType: t.anesthesiaType,
                minCount: t.minCount ?? 1,
                maxCount: t.maxCount ?? null,
                amount: t.amount,
                validFrom: t.validFrom,
              })),
            }
          : undefined,
      },
      include: schemeInclude,
    });

    if (openPrev) {
      const validTo = new Date(input.validFrom);
      validTo.setUTCDate(validTo.getUTCDate() - 1);
      await tx.payoutScheme.update({
        where: { id: openPrev.id },
        data: { validTo, replacedById: created.id, updatedBy: userId },
      });
    }

    await writeAudit(req, { action: 'create', entity: 'payoutScheme', entityId: created.id, after: created }, tx);
    return created;
  });
}

// Правка условий схемы запрещена — меняются только name и note (условия = новая версия).
export async function updateSchemeMeta(id: number, data: { name?: string | null; note?: string | null }, req: Request) {
  const before = await prisma.payoutScheme.findUnique({ where: { id } });
  if (!before) throw notFound('Схема не найдена');
  const updated = await prisma.payoutScheme.update({
    where: { id },
    data: { name: data.name ?? before.name, note: data.note === undefined ? before.note : data.note, updatedBy: req.user!.id },
    include: schemeInclude,
  });
  await writeAudit(req, { action: 'update', entity: 'payoutScheme', entityId: id, before, after: updated });
  return updated;
}

export function listSchemes(payeeId?: number) {
  return prisma.payoutScheme.findMany({
    where: payeeId ? { payeeId } : {},
    include: schemeInclude,
    orderBy: [{ payeeId: 'asc' }, { validFrom: 'desc' }],
  });
}

export async function getScheme(id: number) {
  const s = await prisma.payoutScheme.findUnique({ where: { id }, include: schemeInclude });
  if (!s) throw notFound('Схема не найдена');
  return s;
}
