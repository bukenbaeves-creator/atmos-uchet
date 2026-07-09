import { Router } from 'express';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { expenseAnalytics, type AnalyticsPeriod } from '../services/expense-analytics.service.js';

// Аналитика расхода материалов. Доступна медсестре и администратору; стоимость —
// только администратору (усечена в сервисе по роли).
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

// Границы периода в UTC (полуоткрытый интервал), как в денежных отчётах.
function parsePeriod(q: Record<string, unknown>): AnalyticsPeriod {
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
  '/',
  asyncHandler(async (req, res) => {
    const period = parsePeriod(req.query as Record<string, unknown>);
    const isAdmin = req.user!.role === 'admin';
    res.json(await expenseAnalytics(period, isAdmin));
  }),
);

export default router;
