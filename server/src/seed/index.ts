import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/auth.js';
import { normalizePhone } from '../lib/phone.js';
import {
  DICTIONARY_SEED,
  STAGES,
  PAY_STAGES,
  PAY_METHODS,
  TERMINALS,
  ZAPIS,
  VID,
  DOCTORS,
  OP_TYPES,
  SERVICE_TYPES,
  CITIES,
  MANAGERS,
  KPI_DEFAULTS,
  REG_CODE_DEFAULTS,
} from '../constants.js';

// ------- утилиты случайных значений (сид, Math.random допустим) -------
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(arr: T[]): T => arr[rnd(arr.length)];
const chance = (p: number) => Math.random() < p;
const money = (min: number, max: number) => Math.round((min + Math.random() * (max - min)) / 1000) * 1000;
function daysAgo(maxDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - rnd(maxDays));
  d.setHours(9 + rnd(9), rnd(60), 0, 0);
  return d;
}

const LAST_M = ['Ахметов', 'Нурланов', 'Сериков', 'Жаксыбеков', 'Оспанов', 'Досжанов', 'Курмангалиев', 'Байжанов', 'Ералиев', 'Мукашев'];
const LAST_F = ['Ахметова', 'Нурланова', 'Серикова', 'Жаксыбекова', 'Оспанова', 'Досжанова', 'Курмангалиева', 'Байжанова', 'Ералиева', 'Мукашева'];
const FIRST_M = ['Айдар', 'Нурлан', 'Ерлан', 'Данияр', 'Асхат', 'Тимур', 'Бауыржан', 'Санжар', 'Ринат', 'Алихан'];
const FIRST_F = ['Айгуль', 'Динара', 'Гульнара', 'Асель', 'Жанна', 'Меруерт', 'Сауле', 'Камила', 'Айым', 'Мадина'];
const PATR_M = ['Айдарович', 'Нурланович', 'Ерланович', 'Даниярович', 'Асхатович'];
const PATR_F = ['Айдаровна', 'Нурлановна', 'Ерлановна', 'Данияровна', 'Асхатовна'];

function randomPatientName(): string {
  if (chance(0.6)) {
    return `${pick(LAST_F)} ${pick(FIRST_F)} ${pick(PATR_F)}`;
  }
  return `${pick(LAST_M)} ${pick(FIRST_M)} ${pick(PATR_M)}`;
}

function randomPhone(): string {
  const codes = ['700', '701', '702', '705', '707', '708', '747', '771', '775', '778'];
  return normalizePhone('+7' + pick(codes) + String(1000000 + rnd(9000000)));
}

async function main() {
  console.log('▶ Сид: справочники и пользователи...');

  // 1) Справочники (идемпотентно)
  for (const [category, values] of Object.entries(DICTIONARY_SEED)) {
    for (let i = 0; i < values.length; i++) {
      await prisma.dictionaryItem.upsert({
        where: { category_label: { category, label: values[i] } },
        update: { active: true, sortOrder: i },
        create: { category, label: values[i], sortOrder: i },
      });
    }
  }

  // 1a) Синхронизация изменённых справочников: старые значения способов оплаты и
  // терминалов деактивируем, а существующие демо-записи переносим на новые.
  for (const category of ['pay_method', 'terminal']) {
    await prisma.dictionaryItem.updateMany({
      where: { category, label: { notIn: DICTIONARY_SEED[category] } },
      data: { active: false },
    });
  }

  const PAY_METHOD_MAP: Record<string, string> = {
    'Каспи QR': 'Через терминал',
    'Халык карта': 'Через терминал',
    'Форте терминал': 'Через терминал',
    Карта: 'Через терминал',
    'Каспи рассрочка': 'Рассрочка',
    'Форте рассрочка': 'Рассрочка',
    'Хоум рассрочка': 'Рассрочка',
    'Каспи счёт на оплату': 'На счёт ТОО',
    'Халык счёт': 'На счёт ТОО',
    'Безнал/счёт ТОО': 'На счёт ТОО',
    ИДФ: 'На счёт ТОО',
  };
  const TERMINAL_MAP: Record<string, string> = { т1: 'Каспи Т1', т2: 'Форте', т3: 'Халык' };

  for (const [oldV, newV] of Object.entries(PAY_METHOD_MAP)) {
    await prisma.payment.updateMany({ where: { payMethod: oldV }, data: { payMethod: newV } });
    await prisma.consultation.updateMany({ where: { payMethod: oldV }, data: { payMethod: newV } });
  }
  for (const [oldV, newV] of Object.entries(TERMINAL_MAP)) {
    await prisma.payment.updateMany({ where: { terminal: oldV }, data: { terminal: newV } });
  }

  // 1b) Настройки по умолчанию (ставки KPI, коды регистрации) — если ещё не заданы,
  //     правки админа не перетираем.
  for (const [key, value] of Object.entries({ ...KPI_DEFAULTS, ...REG_CODE_DEFAULTS })) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }

  // 1c) Бэкфилл менеджеров для существующих демо-записей (где не заполнено)
  const consNoMgr = await prisma.consultation.findMany({ where: { manager: null }, select: { id: true } });
  for (const c of consNoMgr) {
    await prisma.consultation.update({ where: { id: c.id }, data: { manager: pick(MANAGERS) } });
  }
  const opsNoMgr = await prisma.operation.findMany({ where: { manager: null }, select: { id: true } });
  for (const o of opsNoMgr) {
    await prisma.operation.update({ where: { id: o.id }, data: { manager: pick(MANAGERS) } });
  }

  // 2) Пользователи
  const admin = await prisma.user.upsert({
    where: { login: 'admin' },
    update: {},
    create: {
      login: 'admin',
      fio: 'Администратор клиники',
      role: 'admin',
      passwordHash: await hashPassword('admin123'),
    },
  });
  await prisma.user.upsert({
    where: { login: 'operator' },
    update: {},
    create: {
      login: 'operator',
      fio: 'Оператор (ресепшн)',
      role: 'operator',
      passwordHash: await hashPassword('operator123'),
    },
  });

  // 3) Демо-данные — только если пациентов ещё нет
  const existing = await prisma.patient.count();
  if (existing > 0) {
    console.log(`▶ Сид: демо-данные уже загружены (${existing} пациентов), пропуск.`);
    return;
  }

  console.log('▶ Сид: генерация пациентов, консультаций, операций, платежей...');
  const meta = { createdBy: admin.id, updatedBy: admin.id };

  const PATIENTS = 180;
  for (let i = 0; i < PATIENTS; i++) {
    const patient = await prisma.patient.create({
      data: {
        fio: randomPatientName(),
        phone: randomPhone(),
        birthDate: new Date(1965 + rnd(40), rnd(12), 1 + rnd(28)),
        city: pick(CITIES),
        ...meta,
      },
    });

    // ~85% пациентов имеют консультацию
    if (!chance(0.85)) continue;
    const stage = pick(STAGES);
    const consultation = await prisma.consultation.create({
      data: {
        patientId: patient.id,
        dateZapis: daysAgo(360),
        dateKons: daysAgo(340),
        time: `${9 + rnd(9)}:${chance(0.5) ? '00' : '30'}`,
        vid: pick(VID),
        interestOperation: pick(OP_TYPES),
        doctor: pick(DOCTORS),
        manager: pick(MANAGERS),
        stage,
        resultDetails: chance(0.4) ? 'Пациент рассматривает варианты' : null,
        payDate: chance(0.5) ? daysAgo(340) : null,
        payMethod: chance(0.5) ? pick(PAY_METHODS) : null,
        amount: chance(0.5) ? money(15000, 50000) : null,
        ...meta,
      },
    });

    // Оплата за консультацию (касса)
    if (chance(0.5)) {
      await prisma.payment.create({
        data: {
          patientId: patient.id,
          date: consultation.payDate ?? daysAgo(340),
          serviceType: 'Консультация',
          amount: money(15000, 50000),
          payMethod: pick(PAY_METHODS),
          terminal: pick(TERMINALS),
          doctor: consultation.doctor,
          zapis: pick(ZAPIS),
          ...meta,
        },
      });
    }

    // Операция создаётся для оплативших/планирующих стадий
    const willOperate = PAY_STAGES.includes(stage) || stage === 'Услуга оказана' || stage === 'Планирует операцию';
    if (!willOperate) continue;

    const cost = money(300000, 6000000);
    const anesthesiaCost = money(80000, 300000);
    const dateOp = daysAgo(300);
    const operation = await prisma.operation.create({
      data: {
        patientId: patient.id,
        consultationId: consultation.id,
        zapis: pick(ZAPIS),
        manager: pick(MANAGERS),
        dateOp,
        opType: consultation.interestOperation ?? pick(OP_TYPES),
        surgeon: pick(DOCTORS),
        anesthesiologist: 'Анестезиолог ' + pick(['А.', 'Б.', 'В.']),
        cost,
        anesthesiaCost,
        contractSigned: PAY_STAGES.includes(stage) || stage === 'Услуга оказана',
        note: chance(0.3) ? 'Плановая операция' : null,
        ...meta,
      },
    });

    // Платежи по операции: аванс / полная / частичная
    const total = cost + anesthesiaCost;
    let ratio = 0;
    if (stage === 'Операция — заключён договор и 100% оплата' || stage === 'Услуга оказана') ratio = 1;
    else if (stage === 'Назначена операция — оплачен аванс') ratio = 0.3 + Math.random() * 0.4;
    else ratio = chance(0.4) ? 0.2 + Math.random() * 0.3 : 0;

    let toPay = Math.round((total * ratio) / 1000) * 1000;
    const parts = toPay > 0 ? 1 + rnd(2) : 0;
    for (let k = 0; k < parts; k++) {
      const part = k === parts - 1 ? toPay : Math.round(toPay / (parts - k) / 1000) * 1000;
      toPay -= part;
      if (part <= 0) continue;
      await prisma.payment.create({
        data: {
          patientId: patient.id,
          operationId: operation.id,
          date: daysAgo(280),
          serviceType: 'Операция',
          amount: part,
          payMethod: pick(PAY_METHODS),
          terminal: pick(TERMINALS),
          doctor: operation.surgeon,
          zapis: pick(ZAPIS),
          ...meta,
        },
      });
    }
  }

  const [pc, cc, oc, payc] = await Promise.all([
    prisma.patient.count(),
    prisma.consultation.count(),
    prisma.operation.count(),
    prisma.payment.count(),
  ]);
  console.log(`✔ Сид завершён: пациентов ${pc}, консультаций ${cc}, операций ${oc}, платежей ${payc}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('Ошибка сида:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
