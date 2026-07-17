import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { serialize } from '../lib/serialize.js';
import { stripCost } from '../services/expense-visibility.service.js';
import { optionalString } from '../schemas.js';
import { reduceStock } from '../services/revision.service.js';

// Ревизия (инвентаризация) склада. Читают/заполняют nurse и admin; ПРИМЕНЯЕТ
// (проводит корректировки остатков) только admin. Все изменения партий — в транзакции.
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

// Что отдаём по одной ревизии: позиции + краткая карточка номенклатуры.
const revInclude = {
  items: {
    orderBy: { id: 'asc' as const },
    include: {
      nomenclature: {
        select: { id: true, nameDisplay: true, type: true, unitWriteoff: true, minStock: true, isExpiryTracked: true },
      },
    },
  },
};

// Список ревизий с краткой сводкой (без цен — безопасно для медсестры).
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await prisma.revision.findMany({
      where: { deletedAt: null },
      include: { items: { select: { systemQty: true, countedQty: true } } },
      orderBy: { date: 'desc' },
      take: 200,
    });
    const items = rows.map((r) => {
      const counted = r.items.filter((i) => i.countedQty !== null);
      const diffs = counted.filter((i) => !i.countedQty!.equals(i.systemQty));
      return {
        id: r.id,
        date: r.date,
        status: r.status,
        note: r.note,
        appliedAt: r.appliedAt,
        total: r.items.length,
        counted: counted.length,
        diffs: diffs.length,
      };
    });
    res.json({ items: serialize(items) });
  }),
);

// Одна ревизия со всеми позициями.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const rev = await prisma.revision.findFirst({ where: { id, deletedAt: null }, include: revInclude });
    if (!rev) throw notFound('Ревизия не найдена');
    res.json(stripCost(serialize(rev), req.user!.role));
  }),
);

// Создать черновик ревизии: снимок текущих остатков по всем активным позициям.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { note } = z.object({ note: optionalString(500) }).parse(req.body ?? {});
    const created = await prisma.$transaction(async (tx) => {
      const noms = await tx.nomenclature.findMany({
        where: { deletedAt: null, status: 'active' },
        include: { batches: { where: { qtyRemaining: { gt: 0 } } } },
        orderBy: { nameDisplay: 'asc' },
      });
      const revision = await tx.revision.create({
        data: {
          note: note ?? null,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
          items: {
            create: noms.map((n) => ({
              nomenclatureId: n.id,
              systemQty: n.batches.reduce((s, b) => s.add(b.qtyRemaining), new Prisma.Decimal(0)),
            })),
          },
        },
        include: revInclude,
      });
      await writeAudit(req, { action: 'create', entity: 'revision', entityId: revision.id, after: { items: noms.length } }, tx);
      return revision;
    });
    res.status(201).json(stripCost(serialize(created), req.user!.role));
  }),
);

// Сохранить введённые фактические остатки (черновик). Доступно nurse и admin.
const itemsSchema = z.object({
  items: z.array(
    z.object({
      nomenclatureId: z.coerce.number().int().positive(),
      countedQty: z.coerce.number().nonnegative('Количество не может быть отрицательным').max(1_000_000).nullable().optional(),
      surplusPrice: z.coerce.number().nonnegative('Цена не может быть отрицательной').max(100_000_000).nullable().optional(),
      note: optionalString(300),
    }),
  ),
});
router.put(
  '/:id/items',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const data = itemsSchema.parse(req.body);
    const rev = await prisma.revision.findFirst({ where: { id, deletedAt: null } });
    if (!rev) throw notFound('Ревизия не найдена');
    if (rev.status !== 'draft') throw badRequest('Ревизия уже применена — изменения недоступны');

    await prisma.$transaction(async (tx) => {
      for (const it of data.items) {
        await tx.revisionItem.updateMany({
          where: { revisionId: id, nomenclatureId: it.nomenclatureId },
          data: {
            countedQty: it.countedQty ?? null,
            surplusPrice: it.surplusPrice ?? null,
            note: it.note ?? null,
          },
        });
      }
      await tx.revision.update({ where: { id }, data: { updatedBy: req.user!.id } });
    });

    const full = await prisma.revision.findFirst({ where: { id }, include: revInclude });
    res.json(stripCost(serialize(full), req.user!.role));
  }),
);

// Применить ревизию (только admin): провести корректировки остатков. Недостача
// списывается с партий FEFO/FIFO с себестоимостью; излишек приходуется новой партией
// по введённой цене (служебный приход source='revision'). Всё атомарно.
router.patch(
  '/:id/apply',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const applied = await prisma.$transaction(async (tx) => {
      const rev = await tx.revision.findFirst({
        where: { id, deletedAt: null },
        include: { items: { include: { nomenclature: { select: { nameDisplay: true } } } } },
      });
      if (!rev) throw notFound('Ревизия не найдена');
      if (rev.status !== 'draft') throw badRequest('Ревизия уже применена');

      const counted = rev.items.filter((i) => i.countedQty !== null);
      if (!counted.length) throw badRequest('Не введён ни один фактический остаток');

      let surplusReceiptId: number | null = null;
      for (const item of counted) {
        // Считаем от ЖИВОГО остатка (мог измениться после начала ревизии).
        const liveBatches = await tx.batch.findMany({ where: { nomenclatureId: item.nomenclatureId, qtyRemaining: { gt: 0 } } });
        const liveSystem = liveBatches.reduce((s, b) => s.add(b.qtyRemaining), new Prisma.Decimal(0));
        const countedQty = new Prisma.Decimal(item.countedQty!);
        const diff = countedQty.sub(liveSystem);
        let costDelta = new Prisma.Decimal(0);

        if (diff.isNegative()) {
          // Недостача — снимаем с партий.
          const { cost } = await reduceStock(item.nomenclatureId, diff.abs(), tx);
          costDelta = cost.negated();
        } else if (diff.isPositive()) {
          // Излишек — нужна цена, оприходуем новой партией.
          if (item.surplusPrice === null) {
            throw badRequest(`Укажите цену излишка для позиции «${item.nomenclature.nameDisplay}»`);
          }
          if (!surplusReceiptId) {
            const rc = await tx.receipt.create({
              data: { date: rev.date, source: 'revision', note: `Ревизия #${rev.id}`, createdBy: req.user!.id, updatedBy: req.user!.id },
            });
            surplusReceiptId = rc.id;
          }
          const price = new Prisma.Decimal(item.surplusPrice);
          await tx.batch.create({
            data: {
              receiptId: surplusReceiptId,
              nomenclatureId: item.nomenclatureId,
              qtyIn: diff,
              qtyRemaining: diff,
              purchasePrice: price,
              receivedAt: rev.date,
              createdBy: req.user!.id,
            },
          });
          costDelta = diff.mul(price);
        }

        await tx.revisionItem.update({ where: { id: item.id }, data: { systemQty: liveSystem, costDelta } });
      }

      const updated = await tx.revision.update({
        where: { id },
        data: { status: 'applied', appliedBy: req.user!.id, appliedAt: new Date(), updatedBy: req.user!.id },
        include: revInclude,
      });
      await writeAudit(req, { action: 'update', entity: 'revision', entityId: id, before: rev, after: { status: 'applied', applied: counted.length } }, tx);
      return updated;
    });
    res.json(stripCost(serialize(applied), req.user!.role));
  }),
);

// Удалить (отменить) черновик ревизии — только admin. Применённую удалять нельзя.
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const rev = await prisma.revision.findFirst({ where: { id, deletedAt: null } });
    if (!rev) throw notFound('Ревизия не найдена');
    if (rev.status === 'applied') throw badRequest('Применённую ревизию удалить нельзя');
    await prisma.revision.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: req.user!.id } });
    res.json({ ok: true });
  }),
);

export default router;
