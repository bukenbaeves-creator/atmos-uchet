import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { recalcOperation, buildCalcScheme, loadRecalcContext } from '../../services/payout-engine.service.js';
import { calcPayout, SYSTEM_COMPONENT_META, type CalcScheme, type AcquiringRateInput } from '../../services/payout-calc.service.js';
import { getSchemeForDate } from '../../services/payout-scheme.service.js';

// Массовый пересчёт начислений и предпросмотр схемы (Э2-4). Только администратор.
const router = Router();
router.use(requireAuth, requireAdmin);

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------- Массовый пересчёт ----------
const recalcSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  operationIds: z.array(z.coerce.number().int().positive()).optional(),
});
router.post(
  '/recalculate',
  asyncHandler(async (req, res) => {
    const d = recalcSchema.parse(req.body);
    const where: Record<string, unknown> = { deletedAt: null, participants: { some: {} } };
    if (d.operationIds?.length) {
      where.id = { in: d.operationIds };
    } else if (d.from || d.to) {
      const range: Record<string, Date> = {};
      if (d.from) range.gte = new Date(d.from);
      if (d.to) range.lt = new Date(d.to); // полуоткрытый интервал [from, to)
      where.dateOp = range;
    }
    const ops = await prisma.operation.findMany({ where, select: { id: true } });

    const start = Date.now();
    const rctx = await loadRecalcContext(prisma); // ставки и компоненты — один раз на весь пакет
    for (const o of ops) {
      await prisma.$transaction((tx) => recalcOperation(o.id, tx, rctx));
    }
    const opIds = ops.map((o) => o.id);
    const grouped = opIds.length
      ? await prisma.payoutAccrual.groupBy({ by: ['operationId'], where: { operationId: { in: opIds } }, _count: { _all: true } })
      : [];
    const accruals = grouped.reduce((s, g) => s + g._count._all, 0);
    res.json({
      processed: ops.length,
      accruals,
      skipped: ops.length - grouped.length, // без начислений (нет схемы / кривая схема)
      ms: Date.now() - start,
    });
  }),
);

// ---------- Предпросмотр схемы «было / стало» ----------
// Пре-сейв предпросмотр: предлагаемая схема приходит в теле (до сохранения версии) —
// иначе критерий «показать разницу ДО сохранения» невыполним. Сравнивается с текущей
// действующей схемой врача на последних 10 его операциях.
const compSchema = z.object({
  code: z.string(),
  enabled: z.coerce.boolean().default(true),
  stage: z.enum(['before_share', 'after_share']).default('before_share'),
  useOwnValue: z.coerce.boolean().default(false),
  value: z.coerce.number().optional().nullable(),
});
const previewSchema = z.object({
  payeeId: z.coerce.number().int().positive(),
  proposed: z.object({
    kind: z.enum(['share_based', 'tariff_based']).default('share_based'),
    shareMode: z.enum(['constant', 'by_source', 'by_op_type']).default('constant'),
    shareValue: z.coerce.number().min(0).max(1).optional().nullable(),
    shareBySource: z.record(z.coerce.number()).optional(),
    components: z.array(compSchema).default([]),
  }),
});
router.post(
  '/schemes/preview',
  asyncHandler(async (req, res) => {
    const d = previewSchema.parse(req.body);
    const ops = await prisma.operation.findMany({
      where: { deletedAt: null, participants: { some: { payeeId: d.payeeId } } },
      include: { payments: { where: { deletedAt: null } }, writeoffs: { where: { deletedAt: null } } },
      orderBy: { dateOp: 'desc' },
      take: 10,
    });
    const acquiringRates: AcquiringRateInput[] = (await prisma.acquiringRate.findMany({})).map((r) => ({
      terminal: r.terminal,
      ratePct: Number(r.ratePct),
      validFrom: iso(r.validFrom),
    }));
    const componentsById = new Map((await prisma.calcComponent.findMany({})).map((c) => [c.id, c as never]));

    const proposed: CalcScheme = {
      kind: d.proposed.kind,
      shareMode: d.proposed.shareMode,
      shareValue: d.proposed.shareValue ?? null,
      shareBySource: d.proposed.shareBySource,
      components: d.proposed.components.map((c) => {
        const meta = SYSTEM_COMPONENT_META[c.code];
        if (!meta) throw badRequest(`Неизвестный компонент «${c.code}»`);
        return {
          code: c.code,
          label: meta.label,
          valueSource: meta.valueSource,
          direction: meta.direction,
          operationField: meta.operationField,
          stage: c.stage,
          enabled: c.enabled,
          useOwnValue: c.useOwnValue,
          value: c.value ?? null,
        };
      }),
    };

    const rows: { operationId: number; dateOp: string; before: number | null; after: number | null; diff: number | null }[] = [];
    let devSum = 0;
    let devN = 0;
    for (const op of ops) {
      if (!op.dateOp) continue;
      const operation = {
        cost: Number(op.cost),
        anesthesiaCost: Number(op.anesthesiaCost),
        implantsCost: Number(op.implantsCost),
        assistantCost: Number(op.assistantCost),
        zapis: op.zapis,
        opType: op.opType,
        dateOp: iso(op.dateOp),
      };
      const payments = op.payments.map((p) => ({
        amount: Number(p.amount),
        terminal: p.terminal,
        date: p.date ? iso(p.date) : operation.dateOp,
        direction: (p.direction as 'payment' | 'refund') ?? 'payment',
      }));
      const materialsFact = op.writeoffs.length ? op.writeoffs.reduce((s, w) => s + Number(w.costTotal), 0) : null;
      let materialNorm: number | null = null;
      if (op.opType) {
        const n = await prisma.materialNorm.findFirst({ where: { opType: op.opType, validFrom: { lte: op.dateOp } }, orderBy: { validFrom: 'desc' } });
        materialNorm = n ? Number(n.amount) : null;
      }
      const current = await getSchemeForDate(d.payeeId, op.dateOp);
      let before: number | null = null;
      try {
        if (current && current.kind === 'share_based') {
          before = calcPayout({ operation, payments, scheme: buildCalcScheme(current as never, componentsById), acquiringRates, materialsFact, materialNorm }).amountFull;
        }
      } catch {
        before = null;
      }
      let after: number | null = null;
      try {
        after = calcPayout({ operation, payments, scheme: proposed, acquiringRates, materialsFact, materialNorm }).amountFull;
      } catch {
        after = null;
      }
      const diff = before != null && after != null ? Math.round((after - before) * 100) / 100 : null;
      if (before && before > 0 && after != null) {
        devSum += Math.abs(after - before) / before;
        devN++;
      }
      rows.push({ operationId: op.id, dateOp: operation.dateOp, before, after, diff });
    }
    const avgDeviationPct = devN ? Math.round((devSum / devN) * 10000) / 100 : 0;
    res.json({
      rows,
      avgDeviationPct,
      warning: avgDeviationPct > 20 ? `Среднее отклонение ${avgDeviationPct}% (>20%) — требуется отдельное подтверждение.` : null,
    });
  }),
);

export default router;
