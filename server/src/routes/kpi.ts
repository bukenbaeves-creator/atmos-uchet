import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireRole } from '../middleware/rbac.js';
import { writeAudit } from '../services/audit.service.js';
import { getRates, setRates, kpiReport, kpiReportRange, type Period } from '../services/kpi.service.js';
import { getKpiSettings, setKpiSettings, qualityReport } from '../services/kpi-quality.service.js';

const isDateStr = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

const router = Router();
router.use(requireAuth, requireRole('operator', 'admin')); // отчёты KPI — скрыты от медсестры

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

// Отчёт KPI по менеджерам: произвольный диапазон ?from=&to= (или пресет ?period=&date=)
router.get(
  '/report',
  asyncHandler(async (req, res) => {
    const q = req.query;
    if (isDateStr(q.from) && isDateStr(q.to)) {
      res.json(await kpiReportRange(q.from, q.to));
      return;
    }
    const period = (['month', 'quarter', 'year'].includes(String(q.period)) ? q.period : 'month') as Period;
    const date = typeof q.date === 'string' ? q.date : undefined;
    res.json(await kpiReport(period, date));
  }),
);

// ===== Мини-дашборд качества =====

// Настройки дашборда (пороги/сроки)
router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json(await getKpiSettings());
  }),
);

const settingsSchema = z.object({
  kpi_timeliness_hours: z.coerce.number().nonnegative().max(100000).optional(),
  kpi_min_result_len: z.coerce.number().int().nonnegative().max(100000).optional(),
  kpi_template_days: z.coerce.number().int().nonnegative().max(3650).optional(),
  kpi_conversion_days: z.coerce.number().int().nonnegative().max(3650).optional(),
  kpi_target_quality_green: z.coerce.number().min(0).max(100).optional(),
  kpi_target_quality_yellow: z.coerce.number().min(0).max(100).optional(),
  kpi_target_timeliness_green: z.coerce.number().min(0).max(100).optional(),
  kpi_target_timeliness_yellow: z.coerce.number().min(0).max(100).optional(),
  kpi_target_conversion_green: z.coerce.number().min(0).max(100).optional(),
  kpi_target_conversion_yellow: z.coerce.number().min(0).max(100).optional(),
});

// Изменение настроек дашборда (только админ)
router.put(
  '/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const before = await getKpiSettings();
    const data = settingsSchema.parse(req.body);
    const after = await setKpiSettings(data);
    await writeAudit(req, { action: 'update', entity: 'kpi_settings', before, after });
    res.json(after);
  }),
);

// Отчёт качества по менеджерам: ?from=YYYY-MM-DD&to=YYYY-MM-DD&manager=
router.get(
  '/quality',
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const today = new Date().toISOString().slice(0, 10);
    const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const from = isDate(q.from) ? q.from : today.slice(0, 8) + '01'; // по умолчанию — с начала месяца
    const to = isDate(q.to) ? q.to : today;
    const manager = typeof q.manager === 'string' && q.manager.trim() ? q.manager.trim() : undefined;
    res.json(await qualityReport(from, to, manager));
  }),
);

export default router;
