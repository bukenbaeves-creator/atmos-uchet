/**
 * Интеграционные тесты ведомостей (Э3-2): Т11 (недельная), Т13 (внеочередная),
 * Т14 (возврат после выплаты → корректировка), Т15 (роспуск + запрет повторного
 * включения). Сценарий разворачивается в локальной БД и удаляется в конце.
 *
 * Запуск: npm run test:sheets   (нужен DATABASE_URL)
 */
import { prisma } from '../lib/prisma.js';
import { recalcOperation } from '../services/payout-engine.service.js';
import { previewSheet, createSheet, approveSheet, dissolveSheet } from '../services/payout-sheet.service.js';

const TAG = 'SHEET_TEST';
const PHONE = '+70000000099';
let failed = 0;
const sheetIds: number[] = [];
const check = (label: string, cond: boolean, extra = '') => {
  if (!cond) failed++;
  console.log(`   ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};

async function cleanup() {
  const ops = await prisma.operation.findMany({ where: { opType: TAG }, select: { id: true } });
  const opIds = ops.map((o) => o.id);
  for (const sid of sheetIds) {
    await prisma.payoutPayment.deleteMany({ where: { line: { sheetId: sid } } });
    await prisma.payoutSheetLine.deleteMany({ where: { sheetId: sid } });
    await prisma.payoutAccrual.updateMany({ where: { sheetId: sid }, data: { sheetId: null } });
    await prisma.payoutSheet.deleteMany({ where: { id: sid } });
  }
  if (opIds.length) {
    await prisma.payoutAccrual.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.payment.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.operationParticipant.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.operation.deleteMany({ where: { id: { in: opIds } } });
  }
  const payee = await prisma.doctorPayee.findFirst({ where: { fio: `${TAG} Хирург` } });
  if (payee) {
    await prisma.payoutScheme.deleteMany({ where: { payeeId: payee.id } });
    await prisma.doctorPayee.delete({ where: { id: payee.id } });
  }
  await prisma.patient.deleteMany({ where: { phone: PHONE } });
}

async function main() {
  await cleanup();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'admin' } });
  const req = { user: { id: admin.id, fio: admin.fio }, ip: 'test-runner' } as never;

  const payee = await prisma.doctorPayee.create({ data: { fio: `${TAG} Хирург`, kind: 'surgeon' } });
  await prisma.payoutScheme.create({
    data: { payeeId: payee.id, name: `${TAG} 50%`, kind: 'share_based', shareMode: 'constant', shareValue: 0.5, validFrom: new Date('2020-01-01T00:00:00Z'), version: 1 },
  });
  const patient = await prisma.patient.create({ data: { fio: `${TAG} Пациент`, phone: PHONE, city: 'Алматы' } });

  // Операция с полной оплатой на заданную дату → начисление cost*0.5.
  async function makeOp(payDate: string) {
    const op = await prisma.operation.create({
      data: {
        patientId: patient.id, dateOp: new Date('2026-08-01T00:00:00Z'), cost: 1000000, anesthesiaCost: 0,
        zapis: 'КЛИНИКА', opType: TAG, participants: { create: [{ payeeId: payee.id, role: 'surgeon' }] },
      },
    });
    await prisma.payment.create({ data: { operationId: op.id, patientId: patient.id, direction: 'payment', date: new Date(payDate + 'T00:00:00Z'), amount: 1000000, terminal: 'Наличные' } });
    await recalcOperation(op.id, prisma);
    return op.id;
  }
  const A = await makeOp('2026-08-03');
  const B = await makeOp('2026-08-06');
  const C = await makeOp('2026-08-12');
  const E = await makeOp('2026-08-20');

  console.log('=== Т11 — недельная ведомость (03–09 берёт две, третья в следующую) ===');
  const wk1 = await previewSheet({ kind: 'weekly', from: '2026-08-03', to: '2026-08-09', payeeIds: [payee.id] });
  check('в неделю 03–09 попали 2 операции', wk1.groups[0]?.operationsCount === 2, `итог ${wk1.totalAccrued}`);
  check('итог недели = 1 000 000', wk1.totalAccrued === 1000000);
  const sheet1 = await createSheet({ kind: 'weekly', from: '2026-08-03', to: '2026-08-09', payeeIds: [payee.id] }, null, req);
  sheetIds.push(sheet1.id);
  const appr1 = await approveSheet(sheet1.id, req);
  check('ведомость утверждена, номер ВВ-', appr1.status === 'approved' && appr1.number.startsWith('ВВ-'), appr1.number);
  const wk2 = await previewSheet({ kind: 'weekly', from: '2026-08-10', to: '2026-08-16', payeeIds: [payee.id] });
  check('третья операция (12.08) в следующей неделе', wk2.groups[0]?.operationsCount === 1);

  console.log('\n=== Т13 — внеочередная (adhoc) исключается из месячной ===');
  const cAccr = await prisma.payoutAccrual.findFirst({ where: { operationId: C, status: 'free' } });
  const adhoc = await createSheet({ kind: 'adhoc', accrualIds: [cAccr!.id] }, 'внеочередная по C', req);
  sheetIds.push(adhoc.id);
  await approveSheet(adhoc.id, req);
  const monthly = await previewSheet({ kind: 'monthly', from: '2026-08-01', to: '2026-08-31', payeeIds: [payee.id] });
  const cInMonthly = monthly.groups.some((g) => g.accrualIds.includes(cAccr!.id));
  check('C (adhoc, locked) не появляется в месячной', !cInMonthly);
  check('A,B (в ведомости 1) тоже не в месячной', !monthly.groups.some((g) => g.operationsCount >= 2));

  console.log('\n=== Т15 — роспуск возвращает начисления в свободные; повтор невозможен ===');
  const sheetE = await createSheet({ kind: 'weekly', from: '2026-08-17', to: '2026-08-23', payeeIds: [payee.id] }, null, req);
  sheetIds.push(sheetE.id);
  await approveSheet(sheetE.id, req);
  const eLockedBefore = await prisma.payoutAccrual.count({ where: { operationId: E, status: 'locked' } });
  await dissolveSheet(sheetE.id, 'ошибка периода', req);
  const eFreeAfter = await prisma.payoutAccrual.count({ where: { operationId: E, status: 'free', sheetId: null } });
  const sheetEGone = !(await prisma.payoutSheet.findUnique({ where: { id: sheetE.id } }));
  check('до роспуска E было locked', eLockedBefore === 1);
  check('после роспуска E снова free', eFreeAfter === 1);
  check('распущенная ведомость удалена', sheetEGone);
  let reincludeBlocked = false;
  try {
    await createSheet({ kind: 'adhoc', accrualIds: [cAccr!.id] }, null, req); // C уже locked
  } catch {
    reincludeBlocked = true;
  }
  check('нельзя повторно включить уже заблокированное начисление', reincludeBlocked);

  console.log('\n=== Т14 — возврат после выплаты → отрицательная корректировка ===');
  // По операции A (начисление 500 000 заблокировано в ведомости 1) пациент вернул 50%.
  await prisma.payment.create({ data: { operationId: A, patientId: patient.id, direction: 'refund', date: new Date('2026-08-25T00:00:00Z'), amount: 500000, terminal: 'Наличные' } });
  await recalcOperation(A, prisma);
  const aLocked = await prisma.payoutAccrual.findFirst({ where: { operationId: A, status: 'locked', isCorrection: false } });
  const aNeg = await prisma.payoutAccrual.findFirst({ where: { operationId: A, status: 'free', amount: { lt: 0 } } });
  check('утверждённое начисление A не изменилось (500 000, locked)', aLocked != null && Number(aLocked.amount) === 500000);
  check('создано отрицательное свободное начисление -250 000', aNeg != null && Number(aNeg.amount) === -250000);

  await cleanup();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (failed) { console.error(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nВсе тесты ведомостей (Т11, Т13, Т14, Т15) пройдены.');
    process.exit(0);
  })
  .catch(async (e) => { console.error('Ошибка теста ведомостей:', e); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
