/**
 * Тест материалов: факт vs норматив, в расчёт идёт БОЛЬШИЙ; реестр показывает два
 * столбца и метод (по факту / по нормативу).
 *
 * Запуск: npm run test:materials   (нужен DATABASE_URL для второй части)
 */
import { prisma } from '../lib/prisma.js';
import { calcPayout, SYSTEM_COMPONENT_META, type CalcComponentInput, type CalcScheme } from '../services/payout-calc.service.js';
import { recalcOperation } from '../services/payout-engine.service.js';
import { createSheet, approveSheet, getSheetRegistry } from '../services/payout-sheet.service.js';

const TAG = 'MAT_TEST';
const PHONE = '+70000000044';
let failed = 0;
const sheetIds: number[] = [];
const check = (label: string, cond: boolean, extra = '') => {
  if (!cond) failed++;
  console.log(`   ${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
};

function materialsScheme(): CalcScheme {
  const meta = SYSTEM_COMPONENT_META['materials'];
  const comp: CalcComponentInput = { code: 'materials', label: meta.label, valueSource: meta.valueSource, direction: meta.direction, operationField: meta.operationField, stage: 'before_share', enabled: true };
  return { kind: 'share_based', shareMode: 'constant', shareValue: 0.5, components: [comp] };
}
function calcMaterials(fact: number, norm: number) {
  return calcPayout({
    operation: { cost: 1000000, anesthesiaCost: 0, implantsCost: 0, assistantCost: 0, zapis: 'X', opType: 'Y', dateOp: '2026-01-01' },
    payments: [{ amount: 1000000, terminal: 'Наличные', date: '2026-01-01', direction: 'payment' }],
    scheme: materialsScheme(),
    acquiringRates: [],
    materialsFact: fact,
    materialNorm: norm,
  });
}

async function cleanup() {
  for (const sid of sheetIds) {
    await prisma.payoutSheetLine.deleteMany({ where: { sheetId: sid } });
    await prisma.payoutAccrual.updateMany({ where: { sheetId: sid }, data: { sheetId: null } });
    await prisma.payoutSheet.deleteMany({ where: { id: sid } });
  }
  const pat = await prisma.patient.findUnique({ where: { phone: PHONE } });
  if (pat) {
    const pids = (await prisma.operation.findMany({ where: { patientId: pat.id }, select: { id: true } })).map((o) => o.id);
    if (pids.length) {
      await prisma.payoutAccrual.deleteMany({ where: { operationId: { in: pids } } });
      await prisma.operationParticipant.deleteMany({ where: { operationId: { in: pids } } });
    }
    await prisma.payment.deleteMany({ where: { patientId: pat.id } });
    await prisma.expenseWriteoff.deleteMany({ where: { patientId: pat.id } });
    await prisma.operation.deleteMany({ where: { patientId: pat.id } });
    await prisma.consultation.deleteMany({ where: { patientId: pat.id } });
    await prisma.patient.delete({ where: { id: pat.id } });
  }
  await prisma.materialNorm.deleteMany({ where: { opType: TAG } });
  const payee = await prisma.doctorPayee.findFirst({ where: { fio: `${TAG} Врач` } });
  if (payee) {
    await prisma.schemeComponent.deleteMany({ where: { scheme: { payeeId: payee.id } } });
    await prisma.payoutScheme.deleteMany({ where: { payeeId: payee.id } });
    await prisma.doctorPayee.delete({ where: { id: payee.id } });
  }
}

async function main() {
  console.log('=== Расчёт: берётся больший (факт vs норматив) ===');
  const a = calcMaterials(30000, 50000).components.find((c) => c.code === 'materials')!;
  check('факт 30 000 < норматив 50 000 → в расчёт 50 000', a.amount === 50000);
  check('метод = норматив', a.detail?.method === 'норматив', JSON.stringify(a.detail));
  const b = calcMaterials(80000, 50000).components.find((c) => c.code === 'materials')!;
  check('факт 80 000 > норматив 50 000 → в расчёт 80 000', b.amount === 80000);
  check('метод = факт', b.detail?.method === 'факт');

  console.log('\n=== Реестр: два столбца (факт/норматив) + метод ===');
  await cleanup();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'admin' } });
  const req = { user: { id: admin.id, fio: admin.fio }, ip: 'test-runner' } as never;
  const comps = Object.fromEntries((await prisma.calcComponent.findMany({})).map((c) => [c.code, c.id]));
  const payee = await prisma.doctorPayee.create({ data: { fio: `${TAG} Врач`, kind: 'surgeon' } });
  await prisma.payoutScheme.create({
    data: {
      payeeId: payee.id, name: `${TAG} 50%`, kind: 'share_based', shareMode: 'constant', shareValue: 0.5, validFrom: new Date('2020-01-01T00:00:00Z'), version: 1,
      items: { create: [{ componentId: comps['materials'], enabled: true, stage: 'before_share' }] },
    },
  });
  // Норматив по виду операции = 50 000; списаний нет (факт 0) → в расчёт норматив.
  await prisma.materialNorm.create({ data: { opType: TAG, amount: 50000, validFrom: new Date('2020-01-01T00:00:00Z') } });
  const patient = await prisma.patient.create({ data: { fio: `${TAG} Пациент`, phone: PHONE, city: 'Алматы' } });
  const op = await prisma.operation.create({
    data: { patientId: patient.id, dateOp: new Date('2026-07-10T00:00:00Z'), cost: 1000000, anesthesiaCost: 0, zapis: 'КЛИНИКА', opType: TAG, participants: { create: [{ payeeId: payee.id, role: 'surgeon' }] } },
  });
  await prisma.payment.create({ data: { operationId: op.id, patientId: patient.id, direction: 'payment', date: new Date('2026-07-12T00:00:00Z'), amount: 1000000, terminal: 'Наличные' } });
  await recalcOperation(op.id, prisma);

  const sheet = await createSheet({ kind: 'monthly', from: '2026-07-01', to: '2026-07-31', payeeIds: [payee.id] }, null, req);
  sheetIds.push(sheet.id);
  const appr = await approveSheet(sheet.id, req);
  const reg = await getSheetRegistry(sheet.id, payee.id);
  const codes = reg.columns.map((c) => c.code);
  const r0 = reg.rows[0] as unknown as { components: Record<string, number>; materialsMethod: string };
  check('колонки materials_fact и materials_norm есть', codes.includes('materials_fact') && codes.includes('materials_norm'));
  check('нет одиночной колонки materials', !codes.includes('materials'));
  check('в строке факт 0 / норматив 50 000', r0.components.materials_fact === 0 && r0.components.materials_norm === 50000);
  check('метод строки = норматив', r0.materialsMethod === 'норматив');
  // начислено = (1 000 000 − 50 000) × 0.5 = 475 000
  check('начислено = 475 000', Number(appr.lines[0].accruedTotal) === 475000);

  console.log('\n=== Списания медсестры БЕЗ ссылки на операцию → «Материалы (факт)» ===');
  const nom = await prisma.nomenclature.findFirst({ where: { deletedAt: null }, select: { id: true } });
  const cat = await prisma.expenseCategory.findFirst({ select: { id: true } });
  if (!nom || !cat) {
    console.log('   (пропуск: нет номенклатуры/категории в базе)');
  } else {
    const mkOp = async (dateOp: string) => {
      const o = await prisma.operation.create({
        data: { patientId: patient.id, dateOp: new Date(dateOp + 'T00:00:00Z'), cost: 1000000, anesthesiaCost: 0, zapis: 'КЛИНИКА', opType: TAG, participants: { create: [{ payeeId: payee.id, role: 'surgeon' }] } },
      });
      await prisma.payment.create({ data: { operationId: o.id, patientId: patient.id, direction: 'payment', date: new Date(dateOp + 'T00:00:00Z'), amount: 1000000, terminal: 'Наличные' } });
      return o.id;
    };
    const mkWo = (date: string, cost: number) =>
      prisma.expenseWriteoff.create({
        data: { patientId: patient.id, operationId: null, opType: TAG, nomenclatureId: nom.id, categoryId: cat.id, qty: 1, costTotal: cost, date: new Date(date + 'T00:00:00Z') },
      });
    const opB = await mkOp('2026-10-10');
    await mkWo('2026-10-11', 70000); // по пациенту, без операции — рядом с opB
    const opC = await mkOp('2026-11-10');
    await mkWo('2026-11-11', 30000); // ближе к opC
    await recalcOperation(opB, prisma);
    await recalcOperation(opC, prisma);
    const matOf = async (opId: number) => {
      const a = await prisma.payoutAccrual.findFirst({ where: { operationId: opId, payeeId: payee.id, isCorrection: false } });
      const c = ((a?.components as Array<{ code: string; amount: number; detail?: { fact: number; norm: number; method: string } }>) ?? []).find((x) => x.code === 'materials');
      return { amount: a ? Number(a.amount) : NaN, fact: c?.detail?.fact, method: c?.detail?.method };
    };
    const b = await matOf(opB);
    const cRes = await matOf(opC);
    check('opB: факт 70 000 из списания по пациенту (без операции)', b.fact === 70000, JSON.stringify(b));
    check('opB: метод «факт» (70 000 > норматив 50 000)', b.method === 'факт');
    check('opB: начислено (1 000 000 − 70 000) × 0.5 = 465 000', b.amount === 465000);
    check('opC: факт 30 000 (второе списание ушло к ближайшей операции, не задвоилось)', cRes.fact === 30000, JSON.stringify(cRes));
    check('opC: метод «норматив» (30 000 < 50 000) → начислено 475 000', cRes.method === 'норматив' && cRes.amount === 475000);
  }

  await cleanup();
}

main()
  .then(async () => {
    await prisma.$disconnect();
    if (failed) { console.error(`\nПРОВАЛЕНО проверок: ${failed}`); process.exit(1); }
    console.log('\nТест материалов (факт/норматив, max, метод) пройден.');
    process.exit(0);
  })
  .catch(async (e) => { console.error('Ошибка теста материалов:', e); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
