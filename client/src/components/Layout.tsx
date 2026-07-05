import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

// Разделы меню. Касса — вверху (второй пункт), Дашборд — в конце отчётов.
const SECTIONS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/patients', label: 'Пациенты', icon: '🧑' },
      { to: '/cashbox', label: 'Касса', icon: '🧾' },
    ],
  },
  {
    title: 'Журналы',
    items: [
      { to: '/consultations', label: 'Консультации', icon: '🗒️' },
      { to: '/operations', label: 'Операции', icon: '🩺' },
    ],
  },
  {
    title: 'Отчёты',
    items: [
      { to: '/prepayments', label: 'Предоплаты и остатки', icon: '💰' },
      { to: '/kpi', label: 'KPI менеджеров', icon: '🎯' },
      { to: '/reconcile', label: 'Сверка с банком', icon: '🏦' },
      { to: '/errors', label: 'Проверка ошибок', icon: '⚠️' },
      { to: '/', label: 'Дашборд', icon: '📊', end: true },
    ],
  },
];

const ADMIN_SECTION: { title: string; items: NavItem[] } = {
  title: 'Администрирование',
  items: [
    { to: '/audit', label: 'Аудит', icon: '🕵️' },
    { to: '/admin', label: 'Пользователи и справочники', icon: '⚙️' },
  ],
};

export function Layout() {
  const { user, logout, isAdmin } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
      isActive ? 'bg-brand-500 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
    }`;

  const sections = isAdmin ? [...SECTIONS, ADMIN_SECTION] : SECTIONS;

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="px-5 py-4">
          <div className="text-lg font-bold text-brand-600">ATMOS</div>
          <div className="text-xs text-slate-400">учёт продаж и операций</div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-4">
          {sections.map((sec, i) => (
            <div key={i} className="mb-1">
              {sec.title && (
                <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {sec.title}
                </div>
              )}
              {sec.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>
                  <span className="text-base">{n.icon}</span> {n.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <div className="px-2 text-sm font-medium text-slate-700">{user?.fio}</div>
          <div className="px-2 text-xs text-slate-400">{isAdmin ? 'Администратор' : 'Оператор'}</div>
          <button className="btn-ghost mt-2 w-full" onClick={() => logout()}>
            Выйти
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
