import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { serialize } from '../../lib/serialize.js';
import {
  previewSheet,
  createSheet,
  excludeAccruals,
  approveSheet,
  dissolveSheet,
  listSheets,
  getSheet,
  setWithholdings,
  addLinePayment,
  getSheetRegistry,
} from '../../services/payout-sheet.service.js';

// Ведомости выплат (Э3-2). Только администратор.
const router = Router();
router.use(requireAuth, requireAdmin);

const filterSchema = z.object({
  kind: z.enum(['weekly', 'monthly', 'custom', 'adhoc']),
  from: z.string().optional(),
  to: z.string().optional(),
  payeeIds: z.array(z.coerce.number().int().positive()).optional(),
  accrualIds: z.array(z.coerce.number().int().positive()).optional(),
});

router.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const f = filterSchema.parse(req.body);
    res.json(serialize(await previewSheet(f)));
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = filterSchema.extend({ note: z.string().trim().max(1000).optional().nullable() }).parse(req.body);
    const sheet = await createSheet(body, body.note ?? null, req);
    res.status(201).json(serialize(sheet));
  }),
);

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ items: serialize(await listSheets()) });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(serialize(await getSheet(Number(req.params.id))));
  }),
);

// Реестр по врачу (Э4-2): динамические колонки по схеме врача.
router.get(
  '/:id/registry',
  asyncHandler(async (req, res) => {
    const payeeId = Number(req.query.payeeId);
    if (!payeeId) throw badRequest('Не указан payeeId');
    res.json(serialize(await getSheetRegistry(Number(req.params.id), payeeId)));
  }),
);

router.patch(
  '/:id/exclude',
  asyncHandler(async (req, res) => {
    const { accrualIds } = z.object({ accrualIds: z.array(z.coerce.number().int().positive()).min(1) }).parse(req.body);
    res.json(serialize(await excludeAccruals(Number(req.params.id), accrualIds, req)));
  }),
);

router.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    res.json(serialize(await approveSheet(Number(req.params.id), req)));
  }),
);

router.post(
  '/:id/dissolve',
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(1, 'Укажите причину роспуска').max(500) }).parse(req.body);
    if (!reason) throw badRequest('Укажите причину роспуска');
    res.json(await dissolveSheet(Number(req.params.id), reason, req));
  }),
);

// Э3-3: удержания по строке (пересчёт toPay).
router.patch(
  '/:id/lines/:lineId/withholdings',
  asyncHandler(async (req, res) => {
    const { withholdings } = z
      .object({
        withholdings: z.array(
          z.object({ type: z.string().trim().min(1), amount: z.coerce.number(), comment: z.string().trim().max(500).optional().nullable() }),
        ),
      })
      .parse(req.body);
    res.json(serialize(await setWithholdings(Number(req.params.id), Number(req.params.lineId), withholdings, req)));
  }),
);

// Э3-3: фиксация выплаты по строке.
router.post(
  '/:id/lines/:lineId/payments',
  asyncHandler(async (req, res) => {
    const p = z
      .object({
        date: z.string().min(1, 'Укажите дату выплаты'),
        amount: z.coerce.number().positive('Сумма выплаты должна быть больше нуля'),
        channel: z.string().trim().min(1, 'Укажите канал выплаты'),
        note: z.string().trim().max(500).optional().nullable(),
      })
      .parse(req.body);
    res.json(serialize(await addLinePayment(Number(req.params.id), Number(req.params.lineId), p, req)));
  }),
);

export default router;
