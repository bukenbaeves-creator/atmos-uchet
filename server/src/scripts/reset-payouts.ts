/**
 * Полный сброс данных модуля «Выплаты врачам» (начать настройку с нуля).
 * Удаляет ВСЕ данные модуля, не трогая клиническую базу (операции, пациенты,
 * платежи, справочники). Системные CalcComponent сохраняются (их пересоздаёт сид).
 *
 * Запуск: npm run reset:payouts   (нужен DATABASE_URL)
 */
import { prisma } from '../lib/prisma.js';

async function main() {
  const steps: [string, () => Promise<{ count: number }>][] = [
    ['PayoutPayment', () => prisma.payoutPayment.deleteMany({})],
    ['PayoutSheetLine', () => prisma.payoutSheetLine.deleteMany({})],
    ['PayoutAccrual', () => prisma.payoutAccrual.deleteMany({})],
    ['PayoutSheet', () => prisma.payoutSheet.deleteMany({})],
    ['OperationParticipant', () => prisma.operationParticipant.deleteMany({})],
    ['SchemeComponent', () => prisma.schemeComponent.deleteMany({})],
    ['SchemeShareValue', () => prisma.schemeShareValue.deleteMany({})],
    ['AnesthesiaTariff', () => prisma.anesthesiaTariff.deleteMany({})],
    ['PayoutScheme', () => prisma.payoutScheme.deleteMany({})],
    ['AcquiringRate', () => prisma.acquiringRate.deleteMany({})],
    ['MaterialNorm', () => prisma.materialNorm.deleteMany({})],
    ['DoctorPayee', () => prisma.doctorPayee.deleteMany({})],
  ];
  console.log('=== Сброс данных модуля «Выплаты» ===');
  for (const [name, fn] of steps) {
    const r = await fn();
    console.log(`  удалено ${name}: ${r.count}`);
  }
  console.log('Готово. Клиническая база (операции/пациенты/платежи/справочники) и системные компоненты не тронуты.');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('Ошибка сброса:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
