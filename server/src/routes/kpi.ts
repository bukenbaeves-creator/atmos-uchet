import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { getRates, setRates, kpiReport, type Period } from '../services/kpi.service.js';

const router = Router();
router.use(requireAuth);

// Текущие ставки KPI
router.get(
  '/rates',
  asyncHandler(async (_req, res) => {
    res.json(await getRates());
  }),
);

const ratesSchema = z.object({
  consultation: z.coerce.number().nonnegative(),
  operation: z.coerce.number().nonnegative(),
});

// Изменение ставок (только админ)
router.put(
  '/rates',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getRates();
    const data = ratesSchema.parse(req.body);
    const after = await setRates(data);
    await writeAudit(req, { action: 'update', entity: 'kpi_rates', before, after });
    res.json(after);
  }),
);

// Отчёт KPI по менеджерам за период
router.get(
  '/report',
  asyncHandler(async (req, res) => {
    const period = (['month', 'quarter', 'year'].includes(String(req.query.period))
      ? req.query.period
      : 'month') as Period;
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    res.json(await kpiReport(period, date));
  }),
);

export default router;
