import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { serialize } from '../lib/serialize.js';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, string>;
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50)));

    const where: Record<string, unknown> = {};
    if (q.entity) where.entity = q.entity;
    if (q.action) where.action = q.action;
    if (q.userId) where.userId = Number(q.userId);
    if (q.from || q.to) {
      where.timestamp = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to + 'T23:59:59') } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    res.json({ items: serialize(rows), total, page, pageSize });
  }),
);

export default router;
