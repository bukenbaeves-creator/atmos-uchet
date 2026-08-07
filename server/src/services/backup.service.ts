import dayjs from 'dayjs';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../lib/http.js';
import { isMailConfigured, sendMail } from '../lib/mailer.js';

const RECIPIENT_KEY = 'backup_email_to';
const LAST_RUN_KEY = 'backup_last_run';

// Все таблицы в порядке «родители → дети» — чтобы будущее восстановление шло без
// нарушения внешних ключей. load — тунк, читающий таблицу целиком.
const TABLES: { key: string; load: () => Promise<unknown[]> }[] = [
  { key: 'user', load: () => prisma.user.findMany() },
  { key: 'dictionaryItem', load: () => prisma.dictionaryItem.findMany() },
  { key: 'setting', load: () => prisma.setting.findMany() },
  { key: 'patient', load: () => prisma.patient.findMany() },
  { key: 'consultation', load: () => prisma.consultation.findMany() },
  { key: 'operation', load: () => prisma.operation.findMany() },
  { key: 'payment', load: () => prisma.payment.findMany() },
  { key: 'auditLog', load: () => prisma.auditLog.findMany() },
  { key: 'expenseCategory', load: () => prisma.expenseCategory.findMany() },
  { key: 'nomenclature', load: () => prisma.nomenclature.findMany() },
  { key: 'nomenclatureAlias', load: () => prisma.nomenclatureAlias.findMany() },
  { key: 'receipt', load: () => prisma.receipt.findMany() },
  { key: 'receiptLine', load: () => prisma.receiptLine.findMany() },
  { key: 'batch', load: () => prisma.batch.findMany() },
  { key: 'expenseWriteoff', load: () => prisma.expenseWriteoff.findMany() },
  { key: 'writeoffBatchAllocation', load: () => prisma.writeoffBatchAllocation.findMany() },
  { key: 'revision', load: () => prisma.revision.findMany() },
  { key: 'revisionItem', load: () => prisma.revisionItem.findMany() },
];

export interface Backup {
  filename: string;
  json: string;
  counts: Record<string, number>;
}

// Логический бэкап всей БД: читаем все таблицы через Prisma и собираем один JSON.
// Не зависит от pg_dump и версии Postgres. Содержит ВСЕ данные, включая
// хэши паролей (для полного восстановления) — файл секретный.
export async function buildBackup(): Promise<Backup> {
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const { key, load } of TABLES) {
    const rows = await load();
    // Сырые строки: JSON.stringify сам отдаёт Date как ISO, а Prisma.Decimal — строкой
    // (через toJSON), сохраняя точность денег (в отличие от serialize(), где Decimal→number).
    data[key] = rows;
    counts[key] = rows.length;
  }
  const payload = {
    meta: { format: 1, generatedAt: new Date().toISOString(), tables: TABLES.map((t) => t.key), counts },
    data,
  };
  return {
    filename: `atmos-backup-${dayjs().format('YYYY-MM-DD-HHmm')}.json`,
    json: JSON.stringify(payload), // без pretty-print — меньше пиковая память
    counts,
  };
}

export async function getRecipient(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: RECIPIENT_KEY } });
  return row?.value ?? '';
}

export async function setRecipient(value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key: RECIPIENT_KEY },
    create: { key: RECIPIENT_KEY, value },
    update: { value },
  });
}

export async function getLastRun(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: LAST_RUN_KEY } });
  return row?.value ?? null;
}

async function markRun(): Promise<void> {
  const value = new Date().toISOString();
  await prisma.setting.upsert({
    where: { key: LAST_RUN_KEY },
    create: { key: LAST_RUN_KEY, value },
    update: { value },
  });
}

// Собирает бэкап и отправляет письмом с вложением получателю из настроек.
// Бросает понятную ошибку, если почта или получатель не настроены.
export async function sendBackupEmail(): Promise<{ recipient: string; counts: Record<string, number> }> {
  if (!isMailConfigured()) {
    throw new ApiError(400, 'Почта не настроена: задайте SMTP_HOST, SMTP_USER, SMTP_PASS в переменных окружения.');
  }
  const recipient = (await getRecipient()).trim();
  if (!recipient) {
    throw new ApiError(400, 'Не указан адрес получателя. Впишите e-mail на странице «Резервные копии».');
  }
  const backup = await buildBackup();
  const total = Object.values(backup.counts).reduce((s, n) => s + n, 0);
  await sendMail({
    to: recipient,
    subject: `Резервная копия ATMOS · ${dayjs().format('DD.MM.YYYY HH:mm')}`,
    text:
      `Во вложении резервная копия базы данных ATMOS (${backup.filename}).\n` +
      `Всего записей: ${total}.\n\n` +
      `Храните файл в надёжном месте — он содержит персональные данные пациентов.`,
    attachments: [{ filename: backup.filename, content: backup.json, contentType: 'application/json' }],
  });
  await markRun();
  return { recipient, counts: backup.counts };
}
