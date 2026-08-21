/**
 * Тесты тарифов анестезиологов (Э6-1): Т5а (тариф без шкалы), Т5б (регрессивная
 * шкала: недельная — нижняя ставка, месячная — фактическая ступень + корректировка),
 * Т18Б (корректировка 6×2000). Изолированный сценарий с очисткой.
 *
 * Запуск: npm run test:anesthesia   (нужен DATABASE_URL)
 */
import { prisma } from '../lib/prisma.js';
import { recalcOperation } from '../services/payout-engine.service.js';
import { createSheet, approveSheet } from '../services/payout-sheet.service.js';

const TAG = 'ANES_TEST';
const PHONE = '+70000000066';
let failed = 0;
const sheetIds: number[] = [];
const check = (label: string, cond: boolean, extra = '') => {
  if (!cond) failed++;
  console.log(`   ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};

async function cleanup() {
  for (const sid of sheetIds) {
    await prisma.payoutSheetLine.deleteMany({ where: { sheetId: sid } });
    await prisma.payoutAccrual.updateMany({ where: { sheetId: sid }, data: { sheetId: null } });
    await prisma.payoutSheet.deleteMany({ where: { id: sid } });
  }
  const pat = await prisma.patient.findUnique({ where: { phone: PHONE } });
  if (pat) {
    const pops = await prisma.operation.findMany({ where: { patientId: pat.id }, select: { id: true } });
    const pids = pops.map((o) => o.id);
    if (pids.length) {
      await prisma.payoutAccrual.deleteMany({ where: { operationId: { in: pids } } });
      await prisma.operationParticipant.deleteMany({ where: { operationId: { in: pids } } });
    }
    await prisma.payment.deleteMany({ where: { patientId: pat.id } });
    await prisma.operation.deleteMany({ where: { patientId: pat.id } });
    await prisma.consultation.deleteMany({ where: { patientId: pat.id } });
    await prisma.patient.delete({ where: { id: pat.id } });
  }
  for (const fio of [`${TAG} Анест-шкала`, `${TAG} Анест-флэт`]) {
    const p = await prisma.doctorPayee.findFirst({ where: { fio } });
    if (p) {
      await prisma.anesthesiaTariff.deleteMany({ where: { scheme: { payeeId: p.id } } });
      await prisma.payoutScheme.deleteMany({ where: { payeeId: p.id } });
      await prisma.doctorPayee.delete({ where: { id: p.id } });
    }
  }
}

async function main() {
  await cleanup();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'admin' } });
  const req = { user: { id: admin.id, fio: admin.fio }, ip: 'test-runner' } as never;
  const patient = await prisma.patient.create({ data: { fio: `${TAG} Пациент`, phone: PHONE, city: 'Алматы' } });

  const scale = await prisma.doctorPayee.create({ data: { fio: `${TAG} Анест-шкала`, kind: 'anesthesiologist' } });
  await prisma.payoutScheme.create({
    data: {
      payeeId: scale.id, name: `${TAG} шкала`, kind: 'tariff_based', shareMode: 'constant', validFrom: new Date('2020-01-01T00:00:00Z'), version: 1,
      tariffs: {
        create: [
          { anesthesiaType: 'общий', minCount: 1, maxCount: 5, amount: 40000, validFrom: new Date('2020-01-01T00:00:00Z') },
          { anesthesiaType: 'общий', minCount: 6, maxCount: 8, amount: 37000, validFrom: new Date('2020-01-01T00:00:00Z') },
          { anesthesiaType: 'общий', minCount: 9, maxCount: null, amount: 35000, validFrom: new Date('2020-01-01T00:00:00Z') },
        ],
      },
    },
  });
  const flat = await prisma.doctorPayee.create({ data: { fio: `${TAG} Анест-флэт`, kind: 'anesthesiologist' } });
  await prisma.payoutScheme.create({
    data: {
      payeeId: flat.id, name: `${TAG} флэт`, kind: 'tariff_based', shareMode: 'constant', validFrom: new Date('2020-01-01T00:00:00Z'), version: 1,
      tariffs: { create: [{ anesthesiaType: 'общий', minCount: 1, maxCount: null, amount: 35000, validFrom: new Date('2020-01-01T00:00:00Z') }] },
    },
  });

  async function makeOp(payeeId: number, dateOp: string) {
    // Право требует базу > 0 и оплату 100% — операция с реальной стоимостью и полной оплатой.
    const op = await prisma.operation.create({
      data: { patientId: patient.id, dateOp: new Date(dateOp + 'T00:00:00Z'), cost: 500000, opType: TAG, zapis: 'КЛИНИКА', participants: { create: [{ payeeId, role: 'anesthesiologist', anesthesiaType: 'общий' }] } },
    });
    await prisma.payment.create({ data: { operationId: op.id, patientId: patient.id, direction: 'payment', date: new Date(dateOp + 'T00:00:00Z'), amount: 500000, terminal: 'Наличные' } });
    await recalcOperation(op.id, prisma);
    return op.id;
  }
  const corr = (payeeId: number, sheetId: number) =>
    prisma.payoutAccrual.findFirst({ where: { sheetId, payeeId, isCorrection: true } });

  console.log('=== Т5а — тариф без шкалы (3 операции × 35 000) ===');
  for (let i = 0; i < 3; i++) await makeOp(flat.id, '2026-07-1' + i);
  const s5a = await createSheet({ kind: 'monthly', from: '2026-07-01', to: '2026-07-31', payeeIds: [flat.id] }, null, req);
  sheetIds.push(s5a.id);
  const a5a = await approveSheet(s5a.id, req);
  check('итог = 105 000', Number(a5a.lines[0].accruedTotal) === 105000);
  check('корректировки нет', (await corr(flat.id, s5a.id)) == null);

  console.log('\n=== Т5б — месячная: 4 операции, ступень 40 000, корректировка 20 000 ===');
  for (let i = 0; i < 4; i++) await makeOp(scale.id, '2026-08-1' + i);
  const s5b = await createSheet({ kind: 'monthly', from: '2026-08-01', to: '2026-08-31', payeeIds: [scale.id] }, null, req);
  sheetIds.push(s5b.id);
  const a5b = await approveSheet(s5b.id, req);
  const c5b = await corr(scale.id, s5b.id);
  check('корректировка = 20 000', c5b != null && Number(c5b.amount) === 20000);
  check('итог = 160 000 (4×40 000)', Number(a5b.lines[0].accruedTotal) === 160000);

  console.log('\n=== Т5б — недельная: нижняя ставка, без корректировки (4×35 000=140 000) ===');
  for (let i = 1; i <= 4; i++) await makeOp(scale.id, '2026-09-0' + i);
  const s5w = await createSheet({ kind: 'weekly', from: '2026-08-31', to: '2026-09-06', payeeIds: [scale.id] }, null, req);
  sheetIds.push(s5w.id);
  const a5w = await approveSheet(s5w.id, req);
  check('итог недели = 140 000', Number(a5w.lines[0].accruedTotal) === 140000);
  check('в недельной корректировки нет', (await corr(scale.id, s5w.id)) == null);

  console.log('\n=== Т18Б — месячная: 6 операций, ступень 37 000, корректировка 6×2 000=12 000 ===');
  for (let i = 1; i <= 6; i++) await makeOp(scale.id, '2026-10-0' + i);
  const s18 = await createSheet({ kind: 'monthly', from: '2026-10-01', to: '2026-10-31', payeeIds: [scale.id] }, null, req);
  sheetIds.push(s18.id);
  const a18 = await approveSheet(s18.id, req);
  const c18 = await corr(scale.id, s18.id);
  check('корректировка = 12 000', c18 != null && Number(c18.amount) === 12000);
  check('итог = 222 000 (6×37 000)', Number(a18.lines[0].accruedTotal) === 222000);

  await cleanup();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (failed) { console.error(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nТесты анестезиологов (Т5а, Т5б, Т18Б) пройдены.');
    process.exit(0);
  })
  .catch(async (e) => { console.error('Ошибка теста анестезиологов:', e); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
