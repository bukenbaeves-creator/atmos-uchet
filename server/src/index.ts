import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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

const app = express();

app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'atmos-uchet' }));

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

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`ATMOS сервер запущен на порту ${config.port} (${config.nodeEnv})`);
});
