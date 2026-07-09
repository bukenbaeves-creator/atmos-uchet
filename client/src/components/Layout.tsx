import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, ROLE_LABEL, type Role } from '../lib/auth';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  roles?: Role[]; // если задано — пункт виден только этим ролям
}

interface Section {
  title?: string;
  items: NavItem[];
  roles?: Role[]; // если задано — раздел виден только этим ролям
}

// Денежные/продажные разделы: скрыты от медсестры (и на сервере они ей запрещены).
const SALES: Role[] = ['operator', 'admin'];

// Разделы меню. Касса — вверху (второй пункт). Дашборд — только админу.
// «Склад и расходы» — ниже «Настроек».
const SECTIONS: Section[] = [
  {
    items: [
      { to: '/patients', label: 'Пациенты', icon: '🧑' },
      { to: '/cashbox', label: 'Касса', icon: '🧾', roles: SALES },
    ],
  },
  {
    title: 'Журналы',
    roles: SALES,
    items: [
      { to: '/consultations', label: 'Консультации', icon: '🗒️' },
      { to: '/operations', label: 'Операции', icon: '🩺' },
    ],
  },
  {
    title: 'Отчёты',
    roles: SALES,
    items: [
      { to: '/prepayments', label: 'Предоплаты и остатки', icon: '💰' },
      { to: '/kpi', label: 'KPI менеджеров', icon: '🎯' },
      { to: '/reconcile', label: 'Сверка с банком', icon: '🏦' },
      { to: '/errors', label: 'Проверка ошибок', icon: '⚠️' },
      { to: '/', label: 'Дашборд', icon: '📊', end: true, roles: ['admin'] },
    ],
  },
  {
    title: 'Настройки',
    items: [{ to: '/dictionaries', label: 'Справочники', icon: '📚' }],
  },
  {
    title: 'Склад и расходы',
    items: [
      { to: '/writeoffs', label: 'Расход материалов', icon: '💊' },
      { to: '/stock', label: 'Склад · остатки', icon: '📦' },
      { to: '/nomenclature', label: 'Номенклатура', icon: '🏷️' },
      { to: '/receipts', label: 'Приход', icon: '📥', roles: ['admin'] },
      { to: '/expense-analytics', label: 'Аналитика расхода', icon: '📈' },
    ],
  },
];

const ADMIN_SECTION: Section = {
  title: 'Администрирование',
  roles: ['admin'],
  items: [
    { to: '/audit', label: 'Аудит', icon: '🕵️' },
    { to: '/admin', label: 'Пользователи', icon: '⚙️' },
  ],
};

export function Layout() {
  const { user, logout } = useAuth();
  const role = (user?.role ?? 'operator') as Role;
  const roleLabel = ROLE_LABEL[role] ?? 'Пользователь';

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
      isActive ? 'bg-brand-500 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
    }`;

  // Фильтр разделов/пунктов по роли текущего пользователя
  const visible = (roles?: Role[]) => !roles || roles.includes(role);
  const sections = [...SECTIONS, ADMIN_SECTION]
    .filter((s) => visible(s.roles))
    .map((s) => ({ ...s, items: s.items.filter((n) => visible(n.roles)) }))
    .filter((s) => s.items.length > 0);

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
          <div className="px-2 text-xs text-slate-400">{roleLabel}</div>
          <button className="btn-ghost mt-2 w-full" onClick={() => logout()}>
            Выйти
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        {/* Верхняя панель: кто сейчас работает в приложении */}
        <div className="sticky top-0 z-20 flex items-center justify-end gap-2 border-b border-slate-200 bg-white/90 px-6 py-2 text-sm backdrop-blur">
          <span className="text-slate-400">Вы вошли как:</span>
          <span className="font-semibold text-slate-700">{user?.fio}</span>
          <span className="badge bg-brand-50 text-brand-700">{roleLabel}</span>
        </div>
        <div className="mx-auto max-w-7xl p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
