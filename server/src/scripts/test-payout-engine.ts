/**
 * Интеграционные тесты событийного движка (Э2-2): Т12 (частичная оплата в разных
 * периодах) и Т17 (идемпотентность). Сценарий разворачивается в локальной БД под
 * уникальными именами и удаляется в конце. Числа — из docs/tests/fixtures-payout.json.
 *
 * Отдельный терминал со ставкой 1,5% используется намеренно: в общей таблице ставок
 * могли остаться прочие записи «Каспи Т1», а экономическое содержание Т12 — комиссия 1,5%.
 *
 * Запуск: npm run test:engine   (нужен DATABASE_URL)
 */
import { prisma } from '../lib/prisma.js';
import { recalcOperation } from '../services/payout-engine.service.js';

const TAG = 'ENGINE_T12';
const PHONE = '+70000000012';
const TERMINAL = 'T12-terminal';

let failed = 0;
function check(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 0.005;
  if (!ok) failed++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}: получили ${got}, ожидали ${want}`);
}

async function cleanup() {
  const ops = await prisma.operation.findMany({ where: { opType: TAG }, select: { id: true } });
  const opIds = ops.map((o) => o.id);
  if (opIds.length) {
    await prisma.payoutAccrual.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.operationParticipant.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.payment.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.operation.deleteMany({ where: { id: { in: opIds } } });
  }
  const payee = await prisma.doctorPayee.findFirst({ where: { fio: `${TAG} Хирург` } });
  if (payee) {
    const schemes = await prisma.payoutScheme.findMany({ where: { payeeId: payee.id }, select: { id: true } });
    const sIds = schemes.map((s) => s.id);
    if (sIds.length) {
      await prisma.schemeComponent.deleteMany({ where: { schemeId: { in: sIds } } });
      await prisma.schemeShareValue.deleteMany({ where: { schemeId: { in: sIds } } });
      await prisma.payoutScheme.deleteMany({ where: { id: { in: sIds } } });
    }
    await prisma.doctorPayee.delete({ where: { id: payee.id } });
  }
  await prisma.patient.deleteMany({ where: { phone: PHONE } });
  await prisma.acquiringRate.deleteMany({ where: { terminal: TERMINAL } });
}

async function main() {
  await cleanup(); // на случай остатков от прошлого запуска

  const payee = await prisma.doctorPayee.create({ data: { fio: `${TAG} Хирург`, kind: 'surgeon' } });
  await prisma.acquiringRate.create({ data: { terminal: TERMINAL, ratePct: 1.5, validFrom: new Date('2020-01-01T00:00:00Z') } });
  const acquiring = await prisma.calcComponent.findUniqueOrThrow({ where: { code: 'acquiring' } });

  await prisma.payoutScheme.create({
    data: {
      payeeId: payee.id,
      name: `${TAG} схема 50%`,
      kind: 'share_based',
      shareMode: 'constant',
      shareValue: 0.5,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      version: 1,
      items: { create: [{ componentId: acquiring.id, enabled: true, stage: 'before_share', useOwnValue: false }] },
    },
  });

  const patient = await prisma.patient.create({ data: { fio: `${TAG} Пациент`, phone: PHONE, city: 'Алматы' } });
  const op = await prisma.operation.create({
    data: {
      patientId: patient.id,
      dateOp: new Date('2026-08-01T00:00:00Z'),
      cost: 1000000,
      anesthesiaCost: 0,
      zapis: 'КЛИНИКА',
      opType: TAG,
      participants: { create: [{ payeeId: payee.id, role: 'surgeon' }] },
    },
  });
  await prisma.payment.createMany({
    data: [
      { operationId: op.id, patientId: patient.id, direction: 'payment', date: new Date('2026-08-05T00:00:00Z'), amount: 400000, terminal: TERMINAL },
      { operationId: op.id, patientId: patient.id, direction: 'payment', date: new Date('2026-09-12T00:00:00Z'), amount: 600000, terminal: TERMINAL },
    ],
  });

  // Т12 — первый пересчёт
  await recalcOperation(op.id, prisma);
  const accr = () =>
    prisma.payoutAccrual.findMany({ where: { operationId: op.id, isCorrection: false }, orderBy: { eventDate: 'asc' } });
  let rows = await accr();
  const comp = (r: (typeof rows)[number], code: string) => {
    const arr = r.components as Array<{ code: string; amount: number }>;
    const c = arr.find((x) => x.code === code);
    return c ? c.amount : NaN;
  };

  console.log('=== Т12 — частичная оплата в разных периодах ===');
  check('число начислений', rows.length, 2);
  if (rows.length === 2) {
    check('событие1 paidRatio', Number(rows[0].paidRatio), 0.4);
    check('событие1 acquiring', comp(rows[0], 'acquiring'), 6000);
    check('событие1 amountFull', Number(rows[0].amountFull), 497000);
    check('событие1 amount', Number(rows[0].amount), 198800);
    check('событие2 paidRatio', Number(rows[1].paidRatio), 1.0);
    check('событие2 acquiring', comp(rows[1], 'acquiring'), 15000);
    check('событие2 amountFull', Number(rows[1].amountFull), 492500);
    check('событие2 amount', Number(rows[1].amount), 293700);
    check('итого по операции', Number(rows[0].amount) + Number(rows[1].amount), 492500);
  }

  console.log('\n=== Т17 — идемпотентность (пересчёт ещё дважды) ===');
  const before = rows.map((r) => ({ id: r.id, amount: Number(r.amount) }));
  await recalcOperation(op.id, prisma);
  await recalcOperation(op.id, prisma);
  rows = await accr();
  check('число начислений не изменилось', rows.length, 2);
  const same =
    rows.length === before.length &&
    rows.every((r, i) => r.id === before[i].id && Math.abs(Number(r.amount) - before[i].amount) < 0.005);
  console.log(`   ${same ? '✅' : '❌'} суммы и id начислений не изменились`);
  if (!same) failed++;

  await cleanup();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (failed) {
      console.error(`\nПРОВАЛЕНО проверок: ${failed}`);
      process.exit(1);
    }
    console.log('\nВсе тесты движка (Т12, Т17) пройдены.');
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('Ошибка теста движка:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
