import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../api/client';

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [loginValue, setLoginValue] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(loginValue, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка входа');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg ring-1 ring-slate-200">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-brand-600">ATMOS</div>
          <div className="text-sm text-slate-400">Учёт продаж, консультаций и операций</div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Логин</label>
            <input className="input" value={loginValue} onChange={(e) => setLoginValue(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Пароль</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        {error && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <button type="submit" className="btn-primary mt-5 w-full" disabled={busy}>
          {busy ? 'Вход…' : 'Войти'}
        </button>
        <div className="mt-4 text-center text-sm text-slate-500">
          Нет аккаунта?{' '}
          <Link to="/register" className="font-medium text-brand-600 hover:underline">
            Зарегистрироваться
          </Link>
        </div>
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          Демо-доступы: <b>admin / admin123</b> · <b>operator / operator123</b>
        </div>
      </form>
    </div>
  );
}
