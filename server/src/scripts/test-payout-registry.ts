/**
 * Тест реестра по врачу (Э4-2, Т16): у Кулесбаева нет колонок «Импланты» и
 * «Медсестра» (в схеме выключены), есть «Аренда дня»; итог реестра сходится со
 * строкой ведомости. Изолированный сценарий с очисткой.
 *
 * Запуск: npm run test:registry   (нужен DATABASE_URL)
 */
import { prisma } from '../lib/prisma.js';
import { recalcOperation } from '../services/payout-engine.service.js';
import { createSheet, approveSheet, getSheetRegistry } from '../services/payout-sheet.service.js';

const TAG = 'REG_TEST';
const PHONE = '+70000000077';
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
  const payee = await prisma.doctorPayee.findFirst({ where: { fio: `${TAG} Кулесбаев` } });
  if (payee) {
    await prisma.schemeComponent.deleteMany({ where: { scheme: { payeeId: payee.id } } });
    await prisma.payoutScheme.deleteMany({ where: { payeeId: payee.id } });
    await prisma.doctorPayee.delete({ where: { id: payee.id } });
  }
}

async function main() {
  await cleanup();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'admin' } });
  const req = { user: { id: admin.id, fio: admin.fio }, ip: 'test-runner' } as never;

  const comps = Object.fromEntries((await prisma.calcComponent.findMany({})).map((c) => [c.code, c.id]));
  const payee = await prisma.doctorPayee.create({ data: { fio: `${TAG} Кулесбаев`, kind: 'surgeon' } });
  // Схема Кулесбаева: наркоз + расходники «до доли», аренда дня «после доли».
  // Импланты и медсестра НЕ включены.
  await prisma.payoutScheme.create({
    data: {
      payeeId: payee.id, name: `${TAG} 50%`, kind: 'share_based', shareMode: 'constant', shareValue: 0.5,
      validFrom: new Date('2020-01-01T00:00:00Z'), version: 1,
      items: {
        create: [
          { componentId: comps['anesthesia'], enabled: true, stage: 'before_share' },
          { componentId: comps['materials'], enabled: true, stage: 'before_share' },
          { componentId: comps['day_rent'], enabled: true, stage: 'after_share', useOwnValue: true, value: 10000 },
        ],
      },
    },
  });
  const patient = await prisma.patient.create({ data: { fio: `${TAG} Пациент`, phone: PHONE, city: 'Алматы' } });
  const op = await prisma.operation.create({
    data: {
      patientId: patient.id, dateOp: new Date('2026-07-10T00:00:00Z'), cost: 900000, anesthesiaCost: 100000,
      zapis: 'КЛИНИКА', opType: TAG, participants: { create: [{ payeeId: payee.id, role: 'surgeon' }] },
    },
  });
  await prisma.payment.create({ data: { operationId: op.id, patientId: patient.id, direction: 'payment', date: new Date('2026-07-12T00:00:00Z'), amount: 1000000, terminal: 'Наличные' } });
  await recalcOperation(op.id, prisma);

  const sheet = await createSheet({ kind: 'monthly', from: '2026-07-01', to: '2026-07-31', payeeIds: [payee.id] }, null, req);
  sheetIds.push(sheet.id);
  const appr = await approveSheet(sheet.id, req);
  const line = appr.lines[0];

  console.log('=== Т16 — реестр по врачу (динамические колонки по схеме) ===');
  const reg = await getSheetRegistry(sheet.id, payee.id);
  const codes = reg.columns.map((c) => c.code);
  check('есть колонка «Аренда дня» (day_rent)', codes.includes('day_rent'));
  check('есть «Наркоз» и «Расходники»', codes.includes('anesthesia') && codes.includes('materials'));
  check('НЕТ колонки «Импланты»', !codes.includes('implants'));
  check('НЕТ колонки «Медсестра» (assistant)', !codes.includes('assistant'));
  const dr = reg.columns.find((c) => c.code === 'day_rent');
  check('«Аренда дня» — стадия after_share', dr?.stage === 'after_share');
  check('строк реестра = 1', reg.rows.length === 1);
  check('итог реестра = начислению 440 000', reg.totals.amount === 440000);
  check('итог реестра совпадает со строкой ведомости', reg.totals.amount === Number(line.accruedTotal));

  await cleanup();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (failed) { console.error(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nТест реестра (Т16) пройден.');
    process.exit(0);
  })
  .catch(async (e) => { console.error('Ошибка теста реестра:', e); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
