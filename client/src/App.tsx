import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
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
import { Dictionaries } from './pages/Dictionaries';
import type { ReactNode } from 'react';

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

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/patients" element={<Patients />} />
        <Route path="/patients/:id" element={<PatientCard />} />
        <Route path="/consultations" element={<Consultations />} />
        <Route path="/operations" element={<Operations />} />
        <Route path="/prepayments" element={<Prepayments />} />
        <Route path="/cashbox" element={<Cashbox />} />
        <Route path="/reconcile" element={<Reconcile />} />
        <Route path="/kpi" element={<Kpi />} />
        <Route path="/dictionaries" element={<Dictionaries />} />
        <Route path="/errors" element={<ErrorCheck />} />
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
