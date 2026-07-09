import type { ReactNode } from 'react';

// Всплывающая подсказка к полю: значок «ⓘ», текст появляется при наведении/фокусе.
export function Hint({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <span
        tabIndex={0}
        role="img"
        aria-label={text}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600 hover:bg-brand-100 hover:text-brand-700"
      >
        i
      </span>
      <span className="pointer-events-none absolute left-1/2 top-6 z-30 w-60 -translate-x-1/2 rounded-lg bg-white px-3 py-2 text-xs font-normal leading-snug text-slate-700 opacity-0 shadow-lg ring-1 ring-slate-200 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
        {text}
      </span>
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div className={`mt-10 w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} rounded-2xl bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Закрыть">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Badge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'blue' | 'slate'; children: ReactNode }) {
  const tones: Record<string, string> = {
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-rose-50 text-rose-700',
    blue: 'bg-brand-50 text-brand-700',
    slate: 'bg-slate-100 text-slate-600',
  };
  return <span className={`badge ${tones[tone]}`}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />
      {label ?? 'Загрузка…'}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-12 text-center text-sm text-slate-400">{children}</div>;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
      <span>
        Всего: {total.toLocaleString('ru-RU')} · стр. {page} из {pages}
      </span>
      <div className="flex gap-1">
        <button className="btn-ghost px-2 py-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ←
        </button>
        <button className="btn-ghost px-2 py-1" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          →
        </button>
      </div>
    </div>
  );
}
