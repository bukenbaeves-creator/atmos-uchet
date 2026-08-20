import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { config } from './lib/config.js';
import { errorHandler } from './middleware/error.js';

import authRouter from './routes/auth.js';
import patientsRouter from './routes/patients.js';
import consultationsRouter from './routes/consultations.js';
import operationsRouter from './routes/operations.js';
import paymentsRouter from './routes/payments.js';
import dictionariesRouter from './routes/dictionaries.js';
import usersRouter from './routes/users.js';
import auditRouter from './routes/audit.js';
import reportsRouter from './routes/reports.js';
import exportRouter from './routes/export.js';
import reconcileRouter from './routes/reconcile.js';
import kpiRouter from './routes/kpi.js';
import nomenclatureRouter from './routes/nomenclature.js';
import expenseCategoriesRouter from './routes/expense-categories.js';
import receiptsRouter from './routes/receipts.js';
import writeoffsRouter from './routes/writeoffs.js';
import stockRouter from './routes/stock.js';
import expenseExportRouter from './routes/expense-export.js';
import expenseAnalyticsRouter from './routes/expense-analytics.js';
import revisionsRouter from './routes/revisions.js';
import backupRouter from './routes/backup.js';
// Модуль «Выплаты врачам» — конструктор (Э0-3)
import payoutPayeesRouter from './routes/payouts/payees.js';
import payoutComponentsRouter from './routes/payouts/components.js';
import payoutRatesRouter from './routes/payouts/rates.js';
import payoutSchemesRouter from './routes/payouts/schemes.js';
import payoutCalcRouter from './routes/payouts/calc.js';

const app = express();

// За обратным прокси (Render/Nginx): доверяем заголовкам X-Forwarded-* —
// нужно для secure-cookie по HTTPS и корректного IP в аудите.
if (config.nodeEnv === 'production') app.set('trust proxy', 1);

// Заголовки безопасности. Приложение самодостаточно (внешних CDN нет, один origin),
// поэтому строгая CSP. HSTS — только в production (по https).
const isProd = config.nodeEnv === 'production';
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline-стили (recharts/атрибуты)
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"], // анти-clickjacking
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
    hsts: isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false, // не мешаем загрузке ресурсов SPA
  }),
);

app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'atmos-uchet' }));

// Анти-перебор: вход и регистрация — по 10 попыток за 15 мин с одного IP.
// Вешаем только на login/register (не на /auth/me — его дёргает клиент часто).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Повторите через 15 минут.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.use('/api/auth', authRouter);
app.use('/api/patients', patientsRouter);
app.use('/api/consultations', consultationsRouter);
app.use('/api/operations', operationsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/dictionaries', dictionariesRouter);
app.use('/api/users', usersRouter);
app.use('/api/audit', auditRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/export', exportRouter);
app.use('/api/reconcile', reconcileRouter);
app.use('/api/kpi', kpiRouter);
// Модуль учёта материальных расходов
app.use('/api/nomenclature', nomenclatureRouter);
app.use('/api/expense-categories', expenseCategoriesRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/writeoffs', writeoffsRouter);
app.use('/api/stock', stockRouter);
app.use('/api/expense-export', expenseExportRouter);
app.use('/api/expense-analytics', expenseAnalyticsRouter);
app.use('/api/revisions', revisionsRouter);
app.use('/api/backup', backupRouter);
// Выплаты врачам — конструктор. Специфичные пути (payees/components) до общего /payouts.
app.use('/api/payouts/payees', payoutPayeesRouter);
app.use('/api/payouts/components', payoutComponentsRouter);
app.use('/api/payouts/schemes', payoutSchemesRouter);
app.use('/api/payouts', payoutCalcRouter); // /recalculate, /schemes/preview
app.use('/api/payouts', payoutRatesRouter); // /rates/acquiring, /tariffs/anesthesia, /norms

// Production: раздаём собранный фронтенд (single-origin) + SPA-fallback.
// В dev папки public нет — блок пропускается, клиент обслуживает Vite.
const publicDir = path.resolve(process.cwd(), 'public');
if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      setHeaders: (res, filePath) => {
        // index.html не кэшируем — браузер всегда берёт свежий манифест бандлов,
        // поэтому новые версии подхватываются сразу после деплоя. Хэшированные
        // ассеты (/assets/*) кэшируем надолго: их имена меняются при каждой сборке.
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.set('Cache-Control', 'no-cache'); // SPA-fallback тоже отдаёт свежий index.html
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`ATMOS сервер запущен на порту ${config.port} (${config.nodeEnv})`);
});
