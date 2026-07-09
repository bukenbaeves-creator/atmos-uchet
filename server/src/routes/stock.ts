import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

// Складские остатки: по каждой позиции остаток = сумма qtyRemaining партий.
// Для admin добавляется суммарная стоимость остатка (по цене закупа партий),
// для nurse — только количество и признак «ниже минимума».
const router = Router();
router.use(requireAuth, requireRole('nurse', 'admin'));

// Порог «скоро истекает» (дней до срока годности)
const EXPIRY_SOON_DAYS = 30;

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const isAdmin = req.user!.role === 'admin';
    const noms = await prisma.nomenclature.findMany({
      where: { deletedAt: null, status: 'active' },
      include: { batches: { where: { qtyRemaining: { gt: 0 } } } },
      orderBy: { nameDisplay: 'asc' },
    });

    const now = Date.now();
    const soonThreshold = now + EXPIRY_SOON_DAYS * 24 * 60 * 60 * 1000;
    const items = noms.map((n) => {
      const stock = n.batches.reduce((s, b) => s.add(b.qtyRemaining), new Prisma.Decimal(0));
      const nearestExpiry = n.batches
        .filter((b) => b.expiryDate)
        .map((b) => b.expiryDate as Date)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      // Есть ли в остатке партия с истёкшим сроком (для подсветки красным)
      const hasExpired = n.batches.some((b) => b.expiryDate && (b.expiryDate as Date).getTime() < now);
      // Есть ли непросроченная партия, срок которой наступит в пределах порога (янтарная подсветка)
      const expiringSoon = n.batches.some((b) => {
        if (!b.expiryDate) return false;
        const t = (b.expiryDate as Date).getTime();
        return t >= now && t <= soonThreshold;
      });
      // Сколько нужно докупить до минимума
      const deficit = Number(Prisma.Decimal.max(n.minStock.sub(stock), new Prisma.Decimal(0)));
      const row: Record<string, unknown> = {
        id: n.id,
        name: n.nameDisplay,
        type: n.type,
        unitWriteoff: n.unitWriteoff,
        minStock: Number(n.minStock),
        stock: Number(stock),
        belowMin: stock.lt(n.minStock),
        deficit,
        nearestExpiry: nearestExpiry ? nearestExpiry.toISOString() : null,
        hasExpired,
        expiringSoon,
      };
      if (isAdmin) {
        // Стоимость остатка по цене закупа — только администратору
        const totalCost = n.batches.reduce((s, b) => s.add(b.qtyRemaining.mul(b.purchasePrice)), new Prisma.Decimal(0));
        row.totalCost = Number(totalCost);
      }
      return row;
    });

    res.json({ items });
  }),
);

export default router;
