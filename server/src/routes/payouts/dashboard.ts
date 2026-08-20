import { Router } from 'express';
import { asyncHandler, badRequest } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { serialize } from '../../lib/serialize.js';
import { dashboardSummary, dashboardByDoctor, dashboardTrend, dashboardSignals } from '../../services/payout-dashboard.service.js';

// Дашборд выплат (Э5-1). Только администратор.
const router = Router();
router.use(requireAuth, requireAdmin);

function period(req: { query: Record<string, unknown> }): { from: Date; to: Date } {
  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  if (!from || !to || isNaN(from.getTime()) || isNaN(to.getTime())) throw badRequest('Укажите период (from, to).');
  return { from, to };
}

router.get('/summary', asyncHandler(async (req, res) => {
  const { from, to } = period(req);
  res.json(serialize(await dashboardSummary(from, to)));
}));

router.get('/share', asyncHandler(async (req, res) => {
  const { from, to } = period(req);
  res.json({ items: serialize(await dashboardByDoctor(from, to)) });
}));

router.get('/trend', asyncHandler(async (req, res) => {
  const { from, to } = period(req);
  res.json({ items: serialize(await dashboardTrend(from, to)) });
}));

router.get('/signals', asyncHandler(async (_req, res) => {
  res.json({ items: serialize(await dashboardSignals()) });
}));

export default router;
