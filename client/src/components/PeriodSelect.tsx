import { useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';

// Компонент выбора периода для модуля выплат (Э3-4, ТЗ 11А.1). Завершённые периоды
// (прошлая/позапрошлая неделя, прошлый/позапрошлый месяц, прошлый квартал), незакрытые
// периоды с пометкой и предупреждением, «Произвольный период…». По умолчанию — прошлый
// месяц. Выбор сохраняется между экранами модуля (localStorage).

export interface Period {
  key: string;
  kind: 'weekly' | 'monthly' | 'custom';
  from: string; // YYYY-MM-DD включительно
  to: string; // YYYY-MM-DD включительно
  label: string;
  closed: boolean; // false — период ещё не завершён (предупреждение)
}

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const iso = (d: Dayjs) => d.format('YYYY-MM-DD');
const dm = (d: Dayjs) => d.format('DD.MM');
// Понедельник недели, содержащей дату (неделя Пн–Вс).
const mondayOf = (d: Dayjs) => d.subtract((d.day() + 6) % 7, 'day').startOf('day');

// Список периодов относительно «сегодня».
export function buildPeriods(today: Dayjs = dayjs()): Period[] {
  const thisMon = mondayOf(today);
  const lastMon = thisMon.subtract(7, 'day');
  const prevMon = thisMon.subtract(14, 'day');
  const week = (mon: Dayjs, key: string, name: string, closed = true): Period => ({
    key,
    kind: 'weekly',
    from: iso(mon),
    to: iso(mon.add(6, 'day')),
    label: `${name} · ${dm(mon)}–${dm(mon.add(6, 'day'))}`,
    closed,
  });

  const lastMonthStart = today.subtract(1, 'month').startOf('month');
  const prevMonthStart = today.subtract(2, 'month').startOf('month');
  const month = (start: Dayjs, key: string, name: string, closed = true): Period => ({
    key,
    kind: 'monthly',
    from: iso(start),
    to: iso(start.endOf('month')),
    label: `${name} · ${MONTHS[start.month()]} ${start.year()}`,
    closed,
  });

  // Прошлый квартал (вычисляем без плагина quarterOfYear).
  const qStart = today.month(today.month() - (today.month() % 3)).startOf('month');
  const lastQEnd = qStart.subtract(1, 'day');
  const lastQStart = lastQEnd.month(lastQEnd.month() - (lastQEnd.month() % 3)).startOf('month');
  const quarter: Period = {
    key: 'last-quarter',
    kind: 'custom',
    from: iso(lastQStart),
    to: iso(lastQEnd),
    label: `Прошлый квартал · ${dm(lastQStart)}.${lastQStart.year()}–${dm(lastQEnd)}.${lastQEnd.year()}`,
    closed: true,
  };

  return [
    month(lastMonthStart, 'last-month', 'Прошлый месяц'),
    month(prevMonthStart, 'prev-month', 'Позапрошлый месяц'),
    week(lastMon, 'last-week', 'Прошлая неделя'),
    week(prevMon, 'prev-week', 'Позапрошлая неделя'),
    quarter,
    // Незакрытые — с пометкой:
    month(today.startOf('month'), 'this-month', 'Текущий месяц (не закрыт)', false),
    week(thisMon, 'this-week', 'Текущая неделя (не закрыта)', false),
  ];
}

const STORE_KEY = 'payout-period';

// Хук с сохранением выбора между экранами модуля. По умолчанию — прошлый месяц.
export function usePayoutPeriod(): [Period, (p: Period) => void] {
  const periods = buildPeriods();
  const def = periods.find((p) => p.key === 'last-month')!;
  const [period, setPeriodState] = useState<Period>(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw) as Period;
    } catch {
      /* ignore */
    }
    return def;
  });
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  };
  return [period, setPeriod];
}

export function PeriodSelect({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const periods = buildPeriods();
  const [customFrom, setCustomFrom] = useState(value.kind === 'custom' && value.key === 'custom' ? value.from : '');
  const [customTo, setCustomTo] = useState(value.kind === 'custom' && value.key === 'custom' ? value.to : '');
  const isCustom = value.key === 'custom';

  return (
    <div>
      <select
        className="input"
        value={value.key}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            onChange({ key: 'custom', kind: 'custom', from: customFrom, to: customTo, label: 'Произвольный период', closed: true });
          } else {
            const p = periods.find((x) => x.key === e.target.value);
            if (p) onChange(p);
          }
        }}
      >
        {periods.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom">Произвольный период…</option>
      </select>

      {isCustom && (
        <div className="mt-2 flex gap-2">
          <input
            type="date"
            className="input"
            value={customFrom}
            onChange={(e) => {
              setCustomFrom(e.target.value);
              onChange({ key: 'custom', kind: 'custom', from: e.target.value, to: customTo, label: 'Произвольный период', closed: true });
            }}
          />
          <input
            type="date"
            className="input"
            value={customTo}
            onChange={(e) => {
              setCustomTo(e.target.value);
              onChange({ key: 'custom', kind: 'custom', from: customFrom, to: e.target.value, label: 'Произвольный период', closed: true });
            }}
          />
        </div>
      )}

      {!value.closed && (
        <p className="mt-1 text-xs text-amber-600">⚠ Период ещё не завершён — суммы могут измениться.</p>
      )}
    </div>
  );
}
