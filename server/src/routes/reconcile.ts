import { Router } from 'express';
import multer from 'multer';
import { asyncHandler, badRequest } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { parseStatement, reconcile } from '../services/reconcile.service.js';

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Загрузка банковской выписки (Excel/CSV) и сверка с платежами кассы.
router.post(
  '/',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Файл выписки не загружен');
    const tolerance = Math.max(0, Math.min(30, Number(req.body?.toleranceDays ?? 2)));

    const { rows, headers } = await parseStatement(req.file.buffer, req.file.originalname);
    if (!rows.length) {
      throw badRequest(
        `Не удалось распознать колонки выписки. Нужны столбцы с датой и суммой (поступление). ` +
          (headers.length ? `Найденные заголовки: ${headers.filter(Boolean).join(', ')}` : ''),
      );
    }

    const result = await reconcile(rows, tolerance);
    res.json({ toleranceDays: tolerance, ...result });
  }),
);

export default router;
