import { prisma } from '../lib/prisma.js';
import { KPI_DEFAULTS } from '../constants.js';

// ===== Настройки мини-дашборда качества (хранятся в Setting, key-value) =====

const SETTING_KEYS = [
  'kpi_timeliness_hours',
  'kpi_min_result_len',
  'kpi_template_days',
  'kpi_conversion_days',
  'kpi_target_quality_green',
  'kpi_target_quality_yellow',
  'kpi_target_timeliness_green',
  'kpi_target_timeliness_yellow',
  'kpi_target_conversion_green',
  'kpi_target_conversion_yellow',
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

export interface KpiSettings {
  timelinessHours: number;
  minResultLen: number;
  templateDays: number;
  conversionDays: number;
  targets: {
    quality: { green: number; yellow: number };
    timeliness: { green: number; yellow: number };
    conversion: { green: number; yellow: number };
  };
}

async function readSettings(): Promise<Record<SettingKey, number>> {
  const rows = await prisma.setting.findMany({ where: { key: { in: SETTING_KEYS as unknown as string[] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<SettingKey, number>;
  for (const k of SETTING_KEYS) out[k] = Number(map[k] ?? KPI_DEFAULTS[k]);
  return out;
}

export async function getKpiSettings(): Promise<KpiSettings> {
  const s = await readSettings();
  return {
    timelinessHours: s.kpi_timeliness_hours,
    minResultLen: s.kpi_min_result_len,
    templateDays: s.kpi_template_days,
    conversionDays: s.kpi_conversion_days,
    targets: {
      quality: { green: s.kpi_target_quality_green, yellow: s.kpi_target_quality_yellow },
      timeliness: { green: s.kpi_target_timeliness_green, yellow: s.kpi_target_timeliness_yellow },
      conversion: { green: s.kpi_target_conversion_green, yellow: s.kpi_target_conversion_yellow },
    },
  };
}

export async function setKpiSettings(patch: Partial<Record<SettingKey, number>>): Promise<KpiSettings> {
  for (const key of SETTING_KEYS) {
    const v = patch[key];
    if (v === undefined) continue;
    await prisma.setting.upsert({ where: { key }, update: { value: String(v) }, create: { key, value: String(v) } });
  }
  return getKpiSettings();
}

// Плоский вид ключей для валидации в роуте.
export const KPI_SETTING_KEYS = SETTING_KEYS;

// ===== Расчёт качества по консультациям =====

const DAY_MS = 24 * 60 * 60 * 1000;

// Нормализация текста итога для сравнения на шаблонность: только буквы/цифры, нижний регистр.
function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export interface QualityRow {
  manager: string;
  consultations: number; // состоявшиеся за период (знаменатель конверсии)
  assessable: number; // из них с историей аудита (знаменатель своевременности/качества)
  noHistory: number; // без истории аудита — «нет данных»
  timelyPct: number | null;
  qualityPct: number | null;
  conversionPct: number;
}

// from/to — строки 'YYYY-MM-DD' (включительно). manager — необязательный фильтр.
export async function qualityReport(fromStr: string, toStr: string, manager?: string) {
  const s = await getKpiSettings();
  const now = new Date();
  const from = new Date(fromStr + 'T00:00:00.000Z');
  const toExclusive = new Date(toStr + 'T00:00:00.000Z');
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1); // конечный день включительно
  // Подгружаем ещё и M дней ДО периода — для сравнения итогов на шаблонность.
  const loadFrom = new Date(from.getTime() - s.templateDays * DAY_MS);

  const consAll = await prisma.consultation.findMany({
    where: {
      deletedAt: null,
      manager: manager ? manager : { not: null },
      patient: { is: { deletedAt: null } },
      dateKons: { gte: loadFrom, lt: toExclusive, lte: now }, // только состоявшиеся (дата в прошлом)
    },
    select: { id: true, manager: true, dateKons: true, stage: true, resultDetails: true, patientId: true, createdAt: true },
  });

  // Консультации, попадающие в отчётный период (без «хвоста» для шаблонности).
  const inPeriod = consAll.filter((c) => c.dateKons && c.dateKons >= from);
  const ids = inPeriod.map((c) => c.id);
  if (!ids.length) {
    return { from: fromStr, to: toStr, settings: s, rows: [] as QualityRow[], totals: emptyTotals(), pendingConversion: 0 };
  }

  // --- Своевременность: время первого внесения итога из журнала аудита ---
  const audits = await prisma.auditLog.findMany({
    where: { entity: 'consultation', entityId: { in: ids }, action: { in: ['create', 'update'] } },
    orderBy: { timestamp: 'asc' },
    select: { entityId: true, before: true, after: true, timestamp: true },
  });
  const firstResultAt = new Map<number, Date | null>();
  const hasHistory = new Set<number>();
  for (const a of audits) {
    if (a.entityId == null) continue;
    hasHistory.add(a.entityId);
    if (firstResultAt.has(a.entityId)) continue; // уже нашли момент появления итога
    const beforeStage = (a.before as { stage?: string } | null)?.stage;
    const afterStage = (a.after as { stage?: string } | null)?.stage;
    if (afterStage && !beforeStage) firstResultAt.set(a.entityId, a.timestamp); // переход пусто → итог
  }

  // --- Конверсия: операции пациентов, привязка к последней консультации перед операцией ---
  const patientIds = [...new Set(inPeriod.map((c) => c.patientId))];
  const ops = await prisma.operation.findMany({
    where: { deletedAt: null, patient: { is: { deletedAt: null } }, patientId: { in: patientIds }, dateOp: { not: null } },
    select: { id: true, patientId: true, dateOp: true, consultationId: true },
  });
  const converted = new Set<number>();
  const inPeriodById = new Map(inPeriod.map((c) => [c.id, c]));
  const byPatient = new Map<number, typeof inPeriod>();
  for (const c of inPeriod) {
    const arr = byPatient.get(c.patientId) ?? [];
    arr.push(c);
    byPatient.set(c.patientId, arr);
  }
  for (const op of ops) {
    if (!op.dateOp) continue;
    // Прямая связь — если операция указывает на консультацию из периода.
    if (op.consultationId != null && inPeriodById.has(op.consultationId)) {
      converted.add(op.consultationId);
      continue;
    }
    // Иначе — последняя консультация пациента ДО операции в окне K дней.
    const cands = (byPatient.get(op.patientId) ?? []).filter(
      (c) => c.dateKons && c.dateKons <= op.dateOp! && op.dateOp!.getTime() - c.dateKons.getTime() <= s.conversionDays * DAY_MS,
    );
    if (cands.length) {
      const last = cands.reduce((a, b) => (a.dateKons! >= b.dateKons! ? a : b));
      converted.add(last.id);
    }
  }

  // --- Шаблонность: совпадение нормализованного итога с итогами того же менеджера ---
  const normById = new Map<number, string>();
  for (const c of consAll) normById.set(c.id, normalize(c.resultDetails));
  const isTemplate = (c: (typeof inPeriod)[number]): boolean => {
    const n = normById.get(c.id) ?? '';
    if (!n) return false; // пустой итог — не «шаблон» (провалится по длине)
    const windowStart = c.dateKons!.getTime() - s.templateDays * DAY_MS;
    return consAll.some(
      (d) =>
        d.id !== c.id &&
        d.manager === c.manager &&
        d.patientId !== c.patientId &&
        d.dateKons != null &&
        d.dateKons.getTime() >= windowStart &&
        d.dateKons.getTime() <= c.dateKons!.getTime() &&
        normById.get(d.id) === n,
    );
  };

  // --- Агрегация по менеджерам ---
  const map = new Map<string, { manager: string; total: number; assessable: number; timely: number; quality: number; conv: number; noHistory: number }>();
  const ensure = (m: string) => {
    if (!map.has(m)) map.set(m, { manager: m, total: 0, assessable: 0, timely: 0, quality: 0, conv: 0, noHistory: 0 });
    return map.get(m)!;
  };
  let pendingConversion = 0;
  for (const c of inPeriod) {
    if (!c.manager || !c.dateKons) continue;
    const row = ensure(c.manager);
    row.total++;
    if (converted.has(c.id)) row.conv++;
    else if (c.dateKons.getTime() + s.conversionDays * DAY_MS > now.getTime()) pendingConversion++; // окно ещё не закрыто

    if (!hasHistory.has(c.id)) {
      row.noHistory++;
      continue; // нет истории аудита → не оцениваем своевременность/качество
    }
    row.assessable++;
    const first = firstResultAt.get(c.id) ?? null;
    const deadline = new Date(c.dateKons.getTime() + s.timelinessHours * 60 * 60 * 1000);
    const timely = first != null && first <= deadline;
    if (timely) row.timely++;
    const lenOk = (c.resultDetails?.trim().length ?? 0) >= s.minResultLen;
    if (timely && lenOk && !isTemplate(c)) row.quality++;
  }

  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
  const rows: QualityRow[] = [...map.values()]
    .map((r) => ({
      manager: r.manager,
      consultations: r.total,
      assessable: r.assessable,
      noHistory: r.noHistory,
      timelyPct: pct(r.timely, r.assessable),
      qualityPct: pct(r.quality, r.assessable),
      conversionPct: pct(r.conv, r.total) ?? 0,
    }))
    .sort((a, b) => (b.qualityPct ?? -1) - (a.qualityPct ?? -1));

  const t = [...map.values()].reduce(
    (acc, r) => {
      acc.total += r.total;
      acc.assessable += r.assessable;
      acc.timely += r.timely;
      acc.quality += r.quality;
      acc.conv += r.conv;
      acc.noHistory += r.noHistory;
      return acc;
    },
    { total: 0, assessable: 0, timely: 0, quality: 0, conv: 0, noHistory: 0 },
  );
  const totals = {
    consultations: t.total,
    assessable: t.assessable,
    noHistory: t.noHistory,
    timelyPct: pct(t.timely, t.assessable),
    qualityPct: pct(t.quality, t.assessable),
    conversionPct: pct(t.conv, t.total) ?? 0,
  };

  return { from: fromStr, to: toStr, settings: s, rows, totals, pendingConversion };
}

function emptyTotals() {
  return { consultations: 0, assessable: 0, noHistory: 0, timelyPct: null, qualityPct: null, conversionPct: 0 };
}
