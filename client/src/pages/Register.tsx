import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../api/client';

export function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [login, setLogin] = useState('');
  const [fio, setFio] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register({ login, fio, password, code });
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка регистрации');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg ring-1 ring-slate-200">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-brand-600">ATMOS</div>
          <div className="text-sm text-slate-400">Регистрация в системе</div>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">ФИО</label>
            <input className="input" value={fio} onChange={(e) => setFio(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Логин</label>
            <input className="input" value={login} onChange={(e) => setLogin(e.target.value)} />
          </div>
          <div>
            <label className="label">Пароль (минимум 6 символов)</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="label">Код регистрации</label>
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Выдаётся администратором"
            />
          </div>
        </div>
        {error && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <button type="submit" className="btn-primary mt-5 w-full" disabled={busy}>
          {busy ? 'Регистрация…' : 'Зарегистрироваться'}
        </button>
        <div className="mt-4 text-center text-sm text-slate-500">
          Уже есть аккаунт?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:underline">
            Войти
          </Link>
        </div>
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          Роль (оператор или администратор) определяется кодом регистрации — код выдаёт администратор клиники.
        </div>
      </form>
    </div>
  );
}
