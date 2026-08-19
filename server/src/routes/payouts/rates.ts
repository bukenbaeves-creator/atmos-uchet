import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { writeAudit } from '../../services/audit.service.js';
import { serialize } from '../../lib/serialize.js';
import { requiredString, requiredDate, moneyAmount, optionalString } from '../../schemas.js';

// Ставки эквайринга, тарифы анестезиологов, нормативы материалов. Все APPEND-ONLY:
// изменение = новая запись с новой validFrom, старые сохраняются для прошлых расчётов.
// Только администратор.
const router = Router();
router.use(requireAuth, requireAdmin);

// ---------- Ставки эквайринга ----------
const acquiringSchema = z.object({
  terminal: requiredString('Укажите терминал', 100),
  ratePct: z.coerce.number({ invalid_type_error: 'Ставка должна быть числом' }).min(0).max(100),
  validFrom: requiredDate('Укажите дату начала действия'),
  note: optionalString(500),
});
router.get(
  '/rates/acquiring',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.acquiringRate.findMany({ orderBy: [{ terminal: 'asc' }, { validFrom: 'desc' }] });
    res.json({ items: serialize(rows) });
  }),
);
router.post(
  '/rates/acquiring',
  asyncHandler(async (req, res) => {
    const d = acquiringSchema.parse(req.body);
    const created = await prisma.acquiringRate.create({
      data: { terminal: d.terminal, ratePct: d.ratePct, validFrom: d.validFrom, note: d.note ?? null, createdBy: req.user!.id },
    });
    await writeAudit(req, { action: 'create', entity: 'acquiring_rate', entityId: created.id, after: created });
    res.status(201).json(serialize(created));
  }),
);

// ---------- Тарифы анестезиологов ----------
const anesthesiaSchema = z.object({
  schemeId: z.coerce.number().int().positive().optional().nullable(),
  anesthesiaType: requiredString('Укажите тип наркоза', 100),
  minCount: z.coerce.number().int().min(1).default(1),
  maxCount: z.coerce.number().int().positive().optional().nullable(),
  amount: moneyAmount(),
  validFrom: requiredDate('Укажите дату начала действия'),
});
router.get(
  '/tariffs/anesthesia',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.anesthesiaTariff.findMany({ orderBy: [{ validFrom: 'desc' }, { minCount: 'asc' }] });
    res.json({ items: serialize(rows) });
  }),
);
router.post(
  '/tariffs/anesthesia',
  asyncHandler(async (req, res) => {
    const d = anesthesiaSchema.parse(req.body);
    const created = await prisma.anesthesiaTariff.create({
      data: {
        schemeId: d.schemeId ?? null,
        anesthesiaType: d.anesthesiaType,
        minCount: d.minCount,
        maxCount: d.maxCount ?? null,
        amount: d.amount,
        validFrom: d.validFrom,
        createdBy: req.user!.id,
      },
    });
    await writeAudit(req, { action: 'create', entity: 'anesthesia_tariff', entityId: created.id, after: created });
    res.status(201).json(serialize(created));
  }),
);

// ---------- Нормативы материалов ----------
const normSchema = z.object({
  opType: requiredString('Укажите вид операции', 200),
  amount: moneyAmount(),
  validFrom: requiredDate('Укажите дату начала действия'),
});
router.get(
  '/norms',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.materialNorm.findMany({ orderBy: [{ opType: 'asc' }, { validFrom: 'desc' }] });
    res.json({ items: serialize(rows) });
  }),
);
router.post(
  '/norms',
  asyncHandler(async (req, res) => {
    const d = normSchema.parse(req.body);
    const created = await prisma.materialNorm.create({
      data: { opType: d.opType, amount: d.amount, validFrom: d.validFrom, createdBy: req.user!.id },
    });
    await writeAudit(req, { action: 'create', entity: 'material_norm', entityId: created.id, after: created });
    res.status(201).json(serialize(created));
  }),
);

export default router;
