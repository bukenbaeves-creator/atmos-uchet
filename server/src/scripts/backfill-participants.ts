/**
 * Разовый идемпотентный бэкфилл участников операций (Э1-2).
 *
 * Для каждой операции БЕЗ участников создаёт OperationParticipant по совпадению:
 *   Operation.surgeon          = DoctorPayee.dictionaryLabel  → роль surgeon
 *   Operation.anesthesiologist = DoctorPayee.dictionaryLabel  → роль anesthesiologist
 *
 * Операции, у которых поле заполнено, но получатель с такой меткой не заведён,
 * выводятся списком — их врачей нужно создать вручную в «Настройки выплат».
 *
 * Повторный запуск дублей не создаёт: уникальность [operationId, payeeId, role]
 * + пропуск операций, у которых участники уже есть.
 *
 * Запуск: npx tsx src/scripts/backfill-participants.ts
 */
import { prisma } from '../lib/prisma.js';

async function main() {
  // Карта «метка справочника → id получателя» (только активные, не удалённые).
  const payees = await prisma.doctorPayee.findMany({
    where: { deletedAt: null, dictionaryLabel: { not: null } },
    select: { id: true, dictionaryLabel: true },
  });
  const byLabel = new Map<string, number>();
  for (const p of payees) if (p.dictionaryLabel) byLabel.set(p.dictionaryLabel.trim(), p.id);

  // Операции без участников. deletedAt: null — как во всех выборках.
  const ops = await prisma.operation.findMany({
    where: { deletedAt: null, participants: { none: {} } },
    select: { id: true, surgeon: true, anesthesiologist: true },
  });

  const beforeCount = await prisma.operationParticipant.count();
  let confirmed = 0;
  const unmatched: { role: 'surgeon' | 'anesthesiologist'; label: string; opId: number }[] = [];

  for (const op of ops) {
    const wanted: { role: 'surgeon' | 'anesthesiologist'; label: string | null }[] = [
      { role: 'surgeon', label: op.surgeon },
      { role: 'anesthesiologist', label: op.anesthesiologist },
    ];
    for (const w of wanted) {
      const label = w.label?.trim();
      if (!label) continue;
      const payeeId = byLabel.get(label);
      if (!payeeId) {
        unmatched.push({ role: w.role, label, opId: op.id });
        continue;
      }
      // upsert по составному уникальному ключу — идемпотентно.
      await prisma.operationParticipant.upsert({
        where: { operationId_payeeId_role: { operationId: op.id, payeeId, role: w.role } },
        update: {},
        create: { operationId: op.id, payeeId, role: w.role },
      });
      confirmed++;
    }
  }

  // Реальные вставки — по разнице количества записей (upsert сам не сообщает).
  const insertedNow = (await prisma.operationParticipant.count()) - beforeCount;
  // Сводка по операциям, оставшимся без участников (по причинам).
  const stillEmpty = await prisma.operation.count({ where: { deletedAt: null, participants: { none: {} } } });
  const uniqLabels = new Map<string, number>();
  for (const u of unmatched) uniqLabels.set(`${u.role}: ${u.label}`, (uniqLabels.get(`${u.role}: ${u.label}`) ?? 0) + 1);

  console.log('=== Бэкфилл участников операций ===');
  console.log(`Обработано операций без участников: ${ops.length}`);
  console.log(`Сопоставлено участников (по меткам): ${confirmed}`);
  console.log(`Создано новых записей в этот запуск: ${insertedNow}`);
  console.log(`Операций всё ещё без участников: ${stillEmpty}`);
  if (uniqLabels.size) {
    console.log('\nНе найдены получатели с меткой справочника (завести вручную):');
    for (const [k, n] of [...uniqLabels.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  • ${k} — операций: ${n}`);
    }
  } else {
    console.log('Несопоставленных меток нет.');
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('Ошибка бэкфилла:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
