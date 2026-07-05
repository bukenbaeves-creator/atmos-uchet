// В production JWT_SECRET обязателен — иначе можно подделать токены со слабым дефолтом.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET не задан в production — приложение остановлено в целях безопасности');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // Срок жизни сессии (автовыход по неактивности реализуется коротким TTL токена,
  // обновляемого при активности на клиенте через /auth/me).
  jwtTtl: '12h',
  // Порог аномально большой суммы (тенге) — раздел 10 ТЗ.
  anomalyAmount: 30_000_000,
};
