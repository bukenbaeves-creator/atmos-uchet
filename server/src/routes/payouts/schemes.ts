import { Router } from 'express';
import { z } from 'zod';
import { SchemeKind, ShareMode, CalcStage } from '@prisma/client';
import { asyncHandler, badRequest } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { serialize } from '../../lib/serialize.js';
import { requiredString, requiredDate, optionalString, moneyAmount } from '../../schemas.js';
import {
  createOrVersionScheme,
  updateSchemeMeta,
  listSchemes,
  getScheme,
  getSchemeForDate,
} from '../../services/payout-scheme.service.js';

// Схемы выплат с версионностью. Условия правятся только через новую версию (POST),
// PUT меняет лишь name/note. Только администратор.
const router = Router();
router.use(requireAuth, requireAdmin);

const itemSchema = z.object({
  componentId: z.coerce.number().int().positive(),
  enabled: z.coerce.boolean().default(true),
  stage: z.nativeEnum(CalcStage),
  useOwnValue: z.coerce.boolean().default(false),
  value: z.coerce.number().optional().nullable(),
  filter: z.any().optional(),
  sortOrder: z.coerce.number().int().optional(),
});
const createSchema = z.object({
  payeeId: z.coerce.number().int().positive(),
  name: requiredString('Название схемы обязательно', 200),
  kind: z.nativeEnum(SchemeKind).default('share_based'),
  shareMode: z.nativeEnum(ShareMode).default('constant'),
  shareValue: z.coerce.number().min(0).max(1).optional().nullable(),
  costRecovery: z.enum(['proportional', 'costs_first']).default('proportional'),
  withholdIpPct: z.coerce.number().min(0).max(100).default(0),
  validFrom: requiredDate('Дата начала действия обязательна'),
  note: optionalString(),
  items: z.array(itemSchema).optional(),
  shareValues: z.array(z.object({ key: requiredString('Ключ доли', 100), share: z.coerce.number().min(0).max(1) })).optional(),
  tariffs: z
    .array(
      z.object({
        anesthesiaType: requiredString('Тип наркоза', 100),
        minCount: z.coerce.number().int().min(1).default(1),
        maxCount: z.coerce.number().int().positive().optional().nullable(),
        amount: moneyAmount(),
        validFrom: requiredDate('Дата начала действия тарифа'),
      }),
    )
    .optional(),
});
const updateSchema = z.object({ name: optionalString(200), note: optionalString() });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const payeeId = req.query.payeeId ? Number(req.query.payeeId) : undefined;
    const rows = await listSchemes(payeeId);
    res.json({ items: serialize(rows) });
  }),
);

// Действующая версия схемы на дату (для расчёта и проверки). Литеральный путь — до /:id.
router.get(
  '/for-date',
  asyncHandler(async (req, res) => {
    const payeeId = Number(req.query.payeeId);
    if (!payeeId) throw badRequest('Не указан payeeId');
    const date = requiredDate('Не указана дата').parse(req.query.date);
    const scheme = await getSchemeForDate(payeeId, date);
    res.json(scheme ? serialize(scheme) : null);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const scheme = await getScheme(Number(req.params.id));
    res.json(serialize(scheme));
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const created = await createOrVersionScheme(input, req);
    res.status(201).json(serialize(created));
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const updated = await updateSchemeMeta(Number(req.params.id), data, req);
    res.json(serialize(updated));
  }),
);

export default router;
