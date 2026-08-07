import { Router } from 'express';
import { z } from 'zod';
import { timingSafeEqual } from 'crypto';
import { asyncHandler, badRequest, unauthorized } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { isMailConfigured } from '../lib/mailer.js';
import { config } from '../lib/config.js';
import { writeAudit } from '../services/audit.service.js';
import { buildBackup, sendBackupEmail, getRecipient, setRecipient, getLastRun } from '../services/backup.service.js';

const router = Router();

// Сравнение секретов за постоянное время (защита от тайминг-атаки на подбор токена).
function tokenMatches(provided: string): boolean {
  const expected = config.backup.cronToken;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Публичный эндпоинт для внешнего планировщика (GitHub Actions) ---
// Объявлен ДО requireAuth/requireAdmin: без сессии, защищён общим токеном.
// Собирает бэкап и отправляет на почту. Токен предпочтительно в заголовке X-Backup-Token
// (в query он утекает в access-логи прокси).
router.post(
  '/cron',
  asyncHandler(async (req, res) => {
    const provided = req.get('X-Backup-Token') || (req.query.token as string) || '';
    if (!tokenMatches(provided)) throw unauthorized('Неверный токен');
    const { counts } = await sendBackupEmail();
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    await writeAudit(req, { action: 'backup', entity: 'backup', after: { mode: 'cron', records: total } });
    res.json({ ok: true, records: total }); // recipient не раскрываем в публичном ответе
  }),
);

// Ниже — только администратор с активной сессией.
router.use(requireAuth, requireAdmin);

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({
      emailConfigured: isMailConfigured(),
      recipient: await getRecipient(),
      lastRun: await getLastRun(),
    });
  }),
);

// Скачивание резервной копии файлом (JSON во вложении).
router.get(
  '/download',
  asyncHandler(async (req, res) => {
    const backup = await buildBackup();
    const total = Object.values(backup.counts).reduce((s, n) => s + n, 0);
    await writeAudit(req, { action: 'backup', entity: 'backup', after: { mode: 'download', records: total } });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${backup.filename}"`);
    res.send(backup.json);
  }),
);

// Создать копию и отправить на почту сейчас.
router.post(
  '/email',
  asyncHandler(async (req, res) => {
    const { recipient, counts } = await sendBackupEmail();
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    await writeAudit(req, { action: 'backup', entity: 'backup', after: { mode: 'email', recipient, records: total } });
    res.json({ ok: true, recipient, records: total });
  }),
);

// Изменить адрес(а) получателя. Несколько адресов — через запятую.
const settingsSchema = z.object({
  recipient: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || v.split(',').every((e) => z.string().email().safeParse(e.trim()).success),
      'Укажите корректный e-mail (несколько — через запятую)',
    ),
});

router.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Некорректные данные');
    await setRecipient(parsed.data.recipient);
    await writeAudit(req, { action: 'backup', entity: 'backup', after: { mode: 'settings', recipient: parsed.data.recipient } });
    res.json({ ok: true, recipient: parsed.data.recipient });
  }),
);

export default router;
