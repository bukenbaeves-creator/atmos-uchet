/**
 * Тест вывода получателя из Operation.surgeon (доработка по фидбеку): начисление
 * считается по УЖЕ имеющейся операции без ручного ввода участника — движок находит
 * получателя по dictionaryLabel = Operation.surgeon.
 *
 * Запуск: npm run test:derive   (нужен DATABASE_URL)
 */
import { prisma } from '../lib/prisma.js';
import { recalcOperation } from '../services/payout-engine.service.js';

const TAG = 'DERIVE_TEST';
const PHONE = '+70000000055';
let failed = 0;
const check = (label: string, cond: boolean, extra = '') => {
  if (!cond) failed++;
  console.log(`   ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};

async function cleanup() {
  const pat = await prisma.patient.findUnique({ where: { phone: PHONE } });
  if (pat) {
    const pids = (await prisma.operation.findMany({ where: { patientId: pat.id }, select: { id: true } })).map((o) => o.id);
    if (pids.length) {
      await prisma.payoutAccrual.deleteMany({ where: { operationId: { in: pids } } });
      await prisma.operationParticipant.deleteMany({ where: { operationId: { in: pids } } });
    }
    await prisma.payment.deleteMany({ where: { patientId: pat.id } });
    await prisma.operation.deleteMany({ where: { patientId: pat.id } });
    await prisma.consultation.deleteMany({ where: { patientId: pat.id } });
    await prisma.patient.delete({ where: { id: pat.id } });
  }
  const payee = await prisma.doctorPayee.findFirst({ where: { fio: `${TAG} Врач` } });
  if (payee) {
    await prisma.payoutScheme.deleteMany({ where: { payeeId: payee.id } });
    await prisma.doctorPayee.delete({ where: { id: payee.id } });
  }
}

async function main() {
  await cleanup();
  // Получатель с меткой справочника = имени хирурга в операциях.
  const payee = await prisma.doctorPayee.create({ data: { fio: `${TAG} Врач`, kind: 'surgeon', dictionaryLabel: `${TAG}-Хирург` } });
  await prisma.payoutScheme.create({
    data: { payeeId: payee.id, name: `${TAG} 50%`, kind: 'share_based', shareMode: 'constant', shareValue: 0.5, validFrom: new Date('2020-01-01T00:00:00Z'), version: 1 },
  });
  const patient = await prisma.patient.create({ data: { fio: `${TAG} Пациент`, phone: PHONE, city: 'Алматы' } });
  // Операция БЕЗ участников, только строковое поле surgeon (как у существующих данных).
  const op = await prisma.operation.create({
    data: { patientId: patient.id, dateOp: new Date('2026-07-10T00:00:00Z'), cost: 1000000, anesthesiaCost: 0, zapis: 'КЛИНИКА', opType: TAG, surgeon: `${TAG}-Хирург` },
  });
  await prisma.payment.create({ data: { operationId: op.id, patientId: patient.id, direction: 'payment', date: new Date('2026-07-12T00:00:00Z'), amount: 1000000, terminal: 'Наличные' } });

  const partsBefore = await prisma.operationParticipant.count({ where: { operationId: op.id } });
  await recalcOperation(op.id, prisma);
  const accr = await prisma.payoutAccrual.findFirst({ where: { operationId: op.id, payeeId: payee.id } });

  console.log('=== Вывод получателя из Operation.surgeon (без явного участника) ===');
  check('явных участников нет', partsBefore === 0);
  check('начисление создано по строке surgeon', accr != null);
  check('сумма = 500 000 (1 000 000 × 0.5)', accr != null && Number(accr.amount) === 500000);

  await cleanup();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (failed) { console.error(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nТест вывода получателя пройден.');
    process.exit(0);
  })
  .catch(async (e) => { console.error('Ошибка теста:', e); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
