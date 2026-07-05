import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { dashboard, prepayments, errorCheck, type Period } from '../services/report.service.js';

const router = Router();
router.use(requireAuth);

function parsePeriod(q: Record<string, unknown>): Period {
  const from = typeof q.from === 'string' && q.from ? new Date(q.from) : undefined;
  const to = typeof q.to === 'string' && q.to ? new Date(q.to + 'T23:59:59') : undefined;
  return { from, to };
}

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    res.json(await dashboard(parsePeriod(req.query as Record<string, unknown>)));
  }),
);

router.get(
  '/prepayments',
  asyncHandler(async (req, res) => {
    const filter = typeof req.query.filter === 'string' ? req.query.filter : undefined;
    res.json(await prepayments(filter));
  }),
);

router.get(
  '/errors',
  asyncHandler(async (_req, res) => {
    res.json(await errorCheck());
  }),
);

export default router;
