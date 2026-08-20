import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Patients } from './pages/Patients';
import { PatientCard } from './pages/PatientCard';
import { Consultations } from './pages/Consultations';
import { Operations } from './pages/Operations';
import { Prepayments } from './pages/Prepayments';
import { Cashbox } from './pages/Cashbox';
import { Reconcile } from './pages/Reconcile';
import { Kpi } from './pages/Kpi';
import { ErrorCheck } from './pages/ErrorCheck';
import { Audit } from './pages/Audit';
import { Admin } from './pages/Admin';
import { Backup } from './pages/Backup';
import { Dictionaries } from './pages/Dictionaries';
import { Writeoffs } from './pages/Writeoffs';
import { Stock } from './pages/Stock';
import { Nomenclature } from './pages/Nomenclature';
import { Receipts } from './pages/Receipts';
import { Revisions, RevisionDetail } from './pages/Revisions';
import { ExpenseAnalytics } from './pages/ExpenseAnalytics';
import { PayoutSettings } from './pages/PayoutSettings';
import { AccrualTrace } from './pages/payouts/AccrualTrace';
import { Sheets } from './pages/payouts/Sheets';
import { Sheet } from './pages/payouts/Sheet';
import type { ReactNode } from 'react';
import type { Role } from './lib/auth';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-10 text-slate-400">Загрузка…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

// Доступ по ролям: не та роль → на домашнюю. Медсестра не видит денежные разделы.
function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (user && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const SALES: Role[] = ['operator', 'admin'];

// Домашняя страница зависит от роли: дашборд (сводка по деньгам) — только админу;
// медсестра → «Расход материалов»; оператор → «Пациенты».
function Home() {
  const { user } = useAuth();
  if (user?.role === 'nurse') return <Navigate to="/writeoffs" replace />;
  if (user?.role === 'operator') return <Navigate to="/patients" replace />;
  return <Dashboard />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Саморегистрация закрыта: /register уводит на вход */}
      <Route path="/register" element={<Navigate to="/login" replace />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Home />} />
        {/* Пациенты и финансовая карточка — скрыты от медсестры (поиск пациента для
            списания идёт отдельно через PatientBlock, не через эти страницы) */}
        <Route path="/patients" element={<RequireRole roles={SALES}><Patients /></RequireRole>} />
        <Route path="/patients/:id" element={<RequireRole roles={SALES}><PatientCard /></RequireRole>} />
        {/* Модуль расходов — доступен медсестре и администратору */}
        <Route path="/writeoffs" element={<Writeoffs />} />
        <Route path="/stock" element={<Stock />} />
        <Route path="/nomenclature" element={<Nomenclature />} />
        <Route path="/revisions" element={<RequireRole roles={['admin', 'nurse']}><Revisions /></RequireRole>} />
        <Route path="/revisions/:id" element={<RequireRole roles={['admin', 'nurse']}><RevisionDetail /></RequireRole>} />
        <Route path="/expense-analytics" element={<RequireAdmin><ExpenseAnalytics /></RequireAdmin>} />
        <Route path="/receipts" element={<RequireRole roles={['admin', 'nurse']}><Receipts /></RequireRole>} />
        {/* Денежные/продажные разделы — скрыты от медсестры */}
        <Route path="/consultations" element={<RequireRole roles={SALES}><Consultations /></RequireRole>} />
        <Route path="/operations" element={<RequireRole roles={SALES}><Operations /></RequireRole>} />
        <Route path="/prepayments" element={<RequireRole roles={SALES}><Prepayments /></RequireRole>} />
        <Route path="/cashbox" element={<RequireRole roles={SALES}><Cashbox /></RequireRole>} />
        <Route path="/reconcile" element={<RequireRole roles={SALES}><Reconcile /></RequireRole>} />
        <Route path="/kpi" element={<RequireRole roles={SALES}><Kpi /></RequireRole>} />
        <Route path="/dictionaries" element={<RequireRole roles={SALES}><Dictionaries /></RequireRole>} />
        <Route path="/errors" element={<RequireRole roles={SALES}><ErrorCheck /></RequireRole>} />
        <Route
          path="/payouts/settings"
          element={
            <RequireAdmin>
              <PayoutSettings />
            </RequireAdmin>
          }
        />
        <Route
          path="/payouts/trace"
          element={
            <RequireAdmin>
              <AccrualTrace />
            </RequireAdmin>
          }
        />
        <Route
          path="/payouts/sheets"
          element={
            <RequireAdmin>
              <Sheets />
            </RequireAdmin>
          }
        />
        <Route
          path="/payouts/sheets/:id"
          element={
            <RequireAdmin>
              <Sheet />
            </RequireAdmin>
          }
        />
        <Route
          path="/audit"
          element={
            <RequireAdmin>
              <Audit />
            </RequireAdmin>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAdmin>
              <Admin />
            </RequireAdmin>
          }
        />
        <Route
          path="/backup"
          element={
            <RequireAdmin>
              <Backup />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
