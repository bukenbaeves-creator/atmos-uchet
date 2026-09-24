import { useState } from 'react';
import { downloadFile, exportUrl } from '../api/client';
import { Modal } from './ui';

// Выгрузка журнала в Excel с выбором периода. Кнопка открывает окно: быстрые периоды
// (месяц/прошлый месяц/квартал/год), произвольные даты или «за всё время».
// Период передаётся серверу (?from&to) — он фильтрует по основной дате журнала.

const p2 = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

type Preset = { key: string; label: string; range: () => { from: string; to: string } };
const PRESETS: Preset[] = [
  {
    key: 'month',
    label: 'Текущий месяц',
    range: () => {
      const n = new Date();
      return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: iso(n) };
    },
  },
  {
    key: 'prevMonth',
    label: 'Прошлый месяц',
    range: () => {
      const n = new Date();
      return {
        from: iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)),
        to: iso(new Date(n.getFullYear(), n.getMonth(), 0)),
      };
    },
  },
  {
    key: 'quarter',
    label: 'Квартал',
    range: () => {
      const n = new Date();
      return { from: iso(new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1)), to: iso(n) };
    },
  },
  {
    key: 'year',
    label: 'Год',
    range: () => {
      const n = new Date();
      return { from: iso(new Date(n.getFullYear(), 0, 1)), to: iso(n) };
    },
  },
];

export function ExportPeriodButton({
  journal,
  label = 'Экспорт в Excel',
  className = 'btn-ghost',
  buildUrl,
  periodHint = 'Период считается по основной дате журнала (для кассы — дата платежа).',
}: {
  journal: string; // используется в имени файла и в адресе выгрузки по умолчанию
  label?: string;
  className?: string;
  buildUrl?: (period: { from?: string; to?: string }) => string; // для отчётов вне /api/export
  periodHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (p: Preset) => {
    const r = p.range();
    setFrom(r.from);
    setTo(r.to);
  };

  const run = async (all = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const period = all ? {} : { from: from || undefined, to: to || undefined };
    const suffix =
      period.from && period.to ? `_${period.from}--${period.to}` : period.from ? `_c-${period.from}` : period.to ? `_po-${period.to}` : '';
    try {
      await downloadFile(buildUrl ? buildUrl(period) : exportUrl(journal, period), `${journal}${suffix}.xlsx`);
      setOpen(false);
    } catch {
      setError('Не удалось выгрузить — попробуйте ещё раз');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Выгрузка в Excel">
        <div className="space-y-4">
          <div>
            <div className="label">Период выгрузки</div>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.key} type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => applyPreset(p)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">С даты</label>
              <input type="date" className="input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <label className="label">По дату</label>
              <input type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-slate-400">
            Обе даты включительно. Пустые поля — выгрузка за всё время. {periodHint}
          </p>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex justify-between gap-2">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => run(true)}>
              За всё время
            </button>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                Отмена
              </button>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => run()}>
                {busy ? 'Выгрузка…' : 'Выгрузить'}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
