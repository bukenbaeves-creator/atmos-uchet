// JWT_SECRET обязателен во всех окружениях, КРОМЕ локальной разработки
// (NODE_ENV пуст или 'development'). Иначе можно подделать токены со слабым дефолтом.
const isLocalDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
if (!isLocalDev && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET не задан — приложение остановлено в целях безопасности');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // Срок жизни сессии (автовыход по неактивности реализуется коротким TTL токена,
  // обновляемого при активности на клиенте через /auth/me).
  jwtTtl: '12h' as const,
  // Порог аномально большой суммы (тенге) — раздел 10 ТЗ.
  anomalyAmount: 30_000_000,
  // SMTP для отправки резервных копий на почту. Секреты только из env; если не
  // заданы — почта считается «не настроенной» (кнопка вернёт понятную ошибку).
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 465),
    // secure=true для 465 (SSL), false для 587 (STARTTLS) — если явно не задано.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT ?? 465) === 465,
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  },
  backup: {
    // Общий секрет для внешнего планировщика (GitHub Actions), дёргающего /cron
    // без сессии. Пусто → cron-эндпоинт отключён (всегда 401).
    cronToken: process.env.BACKUP_CRON_TOKEN ?? '',
  },
};
