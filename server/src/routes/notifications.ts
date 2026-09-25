import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';

// Сводка «требует внимания»: счётчики для бейджей в меню и баннеров на экранах.
// Лёгкий запрос (только count) — клиент опрашивает его периодически.
const router = Router();
router.use(requireAuth);

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const role = req.user!.role;
    const isAdmin = role === 'admin';
    const isNurse = role === 'nurse';
    // Приходы на согласовании: администратору — все (он согласовывает),
    // медсестре — только её собственные (чтобы видела, что ещё не одобрено).
    const receiptsPending =
      isAdmin || isNurse
        ? await prisma.receipt.count({
            where: { deletedAt: null, status: 'pending', ...(isAdmin ? {} : { createdBy: req.user!.id }) },
          })
        : 0;
    // Позиции номенклатуры на подтверждении (создаются при приходе новых наименований).
    const nomenclatureDraft =
      isAdmin || isNurse ? await prisma.nomenclature.count({ where: { deletedAt: null, status: 'draft' } }) : 0;
    res.json({ receiptsPending, nomenclatureDraft });
  }),
);

export default router;
