import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { dashboard, prepayments, errorCheck, type Period } from '../services/report.service.js';

const router = Router();
router.use(requireAuth, requireRole('operator', 'admin')); // денежные отчёты — скрыты от медсестры

// Границы периода в UTC (согласованно с хранением дат как UTC-полночь):
// from = 00:00 UTC начального дня; to = 00:00 UTC дня ПОСЛЕ конечного (полуоткрытый
// интервал [from, toExclusive) — dateFilter применит lt, чтобы весь конечный день вошёл).
function parsePeriod(q: Record<string, unknown>): Period {
  const from = typeof q.from === 'string' && q.from ? new Date(q.from + 'T00:00:00.000Z') : undefined;
  let toExclusive: Date | undefined;
  if (typeof q.to === 'string' && q.to) {
    const d = new Date(q.to + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + 1);
    toExclusive = d;
  }
  return { from, toExclusive };
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
