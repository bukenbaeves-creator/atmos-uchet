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
};
