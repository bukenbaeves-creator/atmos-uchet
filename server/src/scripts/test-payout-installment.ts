/**
 * Интеграционный тест: начисления врачу при РАССРОЧКЕ КЛИНИКИ.
 * Правило: со взноса врачу 0; полная выплата распределяется по платежам сверх взноса
 * пропорционально их сумме. Операции без рассрочки считаются по правилу 100% (test:engine).
 *
 * Сценарий: операция 2 000 000, схема 50% без вычетов → полная выплата 1 000 000;
 * рассрочка: взнос 500 000, 9 мес. (166 667 × 8 + 166 664).
 * Данные создаются под уникальными именами и удаляются в конце.
 *
 * Запуск: npm run test:installment-payout   (нужен DATABASE_URL)
 */
import { prisma } from '../lib/prisma.js';
import { recalcOperation } from '../services/payout-engine.service.js';
import { buildPlanData } from '../services/installment.service.js';

const TAG = 'ENGINE_INSTALLMENT';
const PHONE = '+70000000077';

let failed = 0;
function check(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 0.005;
  if (!ok) failed++;
  console.log(`   ${ok ? '✅' : '❌'} ${label}: получили ${got}, ожидали ${want}`);
}
const day = (s: string) => new Date(s + 'T00:00:00Z');

async function cleanup() {
  const ops = await prisma.operation.findMany({ where: { opType: TAG }, select: { id: true } });
  const opIds = ops.map((o) => o.id);
  if (opIds.length) {
    await prisma.payoutAccrual.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.operationParticipant.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.payment.deleteMany({ where: { operationId: { in: opIds } } });
    const plans = await prisma.installmentPlan.findMany({ where: { operationId: { in: opIds } }, select: { id: true } });
    await prisma.installmentItem.deleteMany({ where: { planId: { in: plans.map((p) => p.id) } } });
    await prisma.installmentPlan.deleteMany({ where: { operationId: { in: opIds } } });
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

  const payee = await prisma.doctorPayee.create({ data: { fio: `${TAG} Хирург`, kind: 'surgeon' } });
  await prisma.payoutScheme.create({
    data: { payeeId: payee.id, name: `${TAG} схема 50%`, kind: 'share_based', shareMode: 'constant', shareValue: 0.5, validFrom: day('2026-01-01'), version: 1 },
  });
  const patient = await prisma.patient.create({ data: { fio: `${TAG} Пациент`, phone: PHONE, city: 'Алматы' } });
  const op = await prisma.operation.create({
    data: {
      patientId: patient.id,
      dateOp: day('2026-12-10'),
      cost: 2000000,
      anesthesiaCost: 0,
      zapis: 'КЛИНИКА',
      opType: TAG,
      participants: { create: [{ payeeId: payee.id, role: 'surgeon' }] },
    },
  });
  const pay = (date: string, amount: number, direction: 'payment' | 'refund' = 'payment') =>
    prisma.payment.create({ data: { operationId: op.id, patientId: patient.id, direction, date: day(date), amount, payMethod: 'Наличные' } });
  const accr = () => prisma.payoutAccrual.findMany({ where: { operationId: op.id }, orderBy: [{ eventDate: 'asc' }, { id: 'asc' }] });
  const sum = (rows: Awaited<ReturnType<typeof accr>>) => rows.reduce((s, r) => s + Number(r.amount), 0);

  console.log('=== Без рассрочки: взнос 500 000 → начислений нет (правило 100%) ===');
  await pay('2026-12-01', 500000);
  await recalcOperation(op.id, prisma);
  check('начислений', (await accr()).length, 0);

  console.log('\n=== Оформлена рассрочка: взнос 500 000, 9 мес. → со взноса врачу 0 ===');
  const { data, items } = await buildPlanData(prisma, {
    operationId: op.id,
    downPayment: 500000,
    months: 9,
    contractDate: day('2026-12-01'),
    firstPaymentDate: day('2027-01-05'),
  });
  await prisma.installmentPlan.create({ data: { ...(data as Parameters<typeof prisma.installmentPlan.create>[0]['data']), items: { create: items } } });
  check('платёж по графику', items[1].amount, 166667);
  await recalcOperation(op.id, prisma);
  check('начислений после взноса', (await accr()).length, 0);

  console.log('\n=== Платёж 1 (166 667, 05.01.2027) → 1/9 полной выплаты ===');
  const p1 = await pay('2027-01-05', 166667);
  await recalcOperation(op.id, prisma);
  let rows = await accr();
  check('число начислений', rows.length, 1);
  if (rows.length === 1) {
    check('сумма события = 1 000 000 × 166 667 / 1 500 000', Number(rows[0].amount), 111111.33);
    check('amountFull (полная выплата)', Number(rows[0].amountFull), 1000000);
    check('paidRatio', Number(rows[0].paidRatio), 0.1111);
    check('база события (доля)', Number(rows[0].base), 222222.67);
    const ev = rows[0].eventDate.toISOString().slice(0, 10);
    console.log(`   ${ev === '2027-01-05' ? '✅' : '❌'} дата события = дата платежа — ${ev}`);
    if (ev !== '2027-01-05') failed++;
    console.log(`   ${rows[0].triggerPaymentId === p1.id ? '✅' : '❌'} привязано к платежу`);
    if (rows[0].triggerPaymentId !== p1.id) failed++;
  }

  console.log('\n=== Идемпотентность (пересчёт ещё дважды) ===');
  const beforeIds = rows.map((r) => r.id).join(',');
  await recalcOperation(op.id, prisma);
  await recalcOperation(op.id, prisma);
  rows = await accr();
  check('число начислений не изменилось', rows.length, 1);
  console.log(`   ${rows.map((r) => r.id).join(',') === beforeIds ? '✅' : '❌'} id начислений не изменились`);
  if (rows.map((r) => r.id).join(',') !== beforeIds) failed++;

  console.log('\n=== Платежи 2–8 → накоплено 8/9 ===');
  for (let k = 2; k <= 8; k++) await pay(`2027-${String(k).padStart(2, '0')}-05`, 166667);
  await recalcOperation(op.id, prisma);
  rows = await accr();
  check('число начислений', rows.length, 8);
  check('начислено всего', sum(rows), 888890.67);

  console.log('\n=== Возврат 100 000 → отрицательное событие ===');
  const refund = await pay('2027-08-20', 100000, 'refund');
  await recalcOperation(op.id, prisma);
  rows = await accr();
  check('число начислений', rows.length, 9);
  check('начислено всего после возврата', sum(rows), 822224);
  await prisma.payment.delete({ where: { id: refund.id } });
  await recalcOperation(op.id, prisma);
  rows = await accr();
  check('возврат отменён: начислений', rows.length, 8);

  console.log('\n=== Последний платёж (166 664) → выплачено ровно 100% ===');
  await pay('2027-09-05', 166664);
  await recalcOperation(op.id, prisma);
  rows = await accr();
  check('число начислений', rows.length, 9);
  check('начислено всего = полной выплате', sum(rows), 1000000);
  check('сумма баз событий = база операции', rows.reduce((s, r) => s + Number(r.base), 0), 2000000);
  check('paidRatio последнего', Number(rows[rows.length - 1].paidRatio), 1);

  console.log('\n=== Начисление в утверждённой ведомости не меняется; разницу закрывает корректировка ===');
  const first = rows[0];
  await prisma.payoutAccrual.update({ where: { id: first.id }, data: { status: 'locked' } });
  await prisma.payment.delete({ where: { id: p1.id } }); // платёж 1 удалён из Кассы
  await recalcOperation(op.id, prisma);
  rows = await accr();
  const locked = rows.find((r) => r.id === first.id);
  check('заблокированное начисление не изменилось', Number(locked?.amount ?? NaN), 111111.33);
  const corr = rows.filter((r) => r.isCorrection);
  check('корректировок', corr.length, 1);
  // Оплачено сверх взноса 1 333 333 из 1 500 000 → цель 888 888.67.
  check('начислено всего с корректировкой', sum(rows), 888888.67);

  console.log('\n=== Рассрочка удалена → снова правило 100%: свободные начисления сняты ===');
  await prisma.payoutAccrual.update({ where: { id: first.id }, data: { status: 'free' } });
  await prisma.installmentPlan.updateMany({ where: { operationId: op.id }, data: { deletedAt: new Date() } });
  await recalcOperation(op.id, prisma);
  rows = await accr();
  check('начислений без рассрочки при неполной оплате', rows.length, 0);

  await cleanup();
  console.log(failed ? `\n❌ Провалено проверок: ${failed}` : '\n✅ Все проверки пройдены');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => undefined);
  await prisma.$disconnect();
  process.exit(1);
});
