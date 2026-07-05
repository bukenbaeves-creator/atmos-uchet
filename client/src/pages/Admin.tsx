import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, ApiError } from '../api/client';
import { PageHeader, Spinner, Badge, Modal } from '../components/ui';
import { formatDate } from '../lib/format';

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'city', label: 'Города' },
  { key: 'doctor', label: 'Врачи' },
  { key: 'surgeon', label: 'Хирурги' },
  { key: 'op_type', label: 'Типы операций' },
  { key: 'pay_method', label: 'Способы оплаты' },
  { key: 'terminal', label: 'Терминалы' },
  { key: 'service_type', label: 'Виды услуг' },
  { key: 'consultation_stage', label: 'Стадии итога' },
  { key: 'vid', label: 'Вид консультации' },
  { key: 'zapis', label: 'Запись' },
  { key: 'manager', label: 'Менеджеры' },
];

export function Admin() {
  const [tab, setTab] = useState<'users' | 'dict'>('users');
  return (
    <div>
      <PageHeader title="Пользователи и справочники" subtitle="Администрирование системы." />
      <div className="mb-4 flex gap-2">
        <button className={tab === 'users' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('users')}>
          Пользователи
        </button>
        <button className={tab === 'dict' ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab('dict')}>
          Справочники
        </button>
      </div>
      {tab === 'users' ? <UsersTab /> : <DictTab />}
    </div>
  );
}

// ---------- Пользователи ----------
interface User {
  id: number;
  login: string;
  fio: string;
  role: 'admin' | 'operator';
  active: boolean;
  createdAt: string;
}

// Коды регистрации (роль определяется кодом). Виден только админу.
function RegCodes() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['reg-codes'],
    queryFn: () => apiGet<{ operator: string; admin: string }>('/auth/reg-codes'),
  });
  const [edit, setEdit] = useState<{ operator: string; admin: string } | null>(null);
  const save = useMutation({
    mutationFn: (b: { operator: string; admin: string }) => apiPut('/auth/reg-codes', b),
    onSuccess: () => {
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['reg-codes'] });
    },
  });

  return (
    <div className="card mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-semibold text-slate-700">Коды регистрации</span>
          <span className="ml-3 text-slate-500">
            оператор: <b>{data?.operator || '—'}</b> · администратор: <b>{data?.admin || '—'}</b>
          </span>
        </div>
        {!edit && (
          <button className="btn-ghost" onClick={() => setEdit({ operator: data?.operator ?? '', admin: data?.admin ?? '' })}>
            Изменить коды
          </button>
        )}
      </div>
      {edit && (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
          <div>
            <label className="label">Код для операторов</label>
            <input className="input w-48" value={edit.operator} onChange={(e) => setEdit({ ...edit, operator: e.target.value })} />
          </div>
          <div>
            <label className="label">Код для администраторов</label>
            <input className="input w-48" value={edit.admin} onChange={(e) => setEdit({ ...edit, admin: e.target.value })} />
          </div>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(edit)}>
            Сохранить
          </button>
          <button className="btn-ghost" onClick={() => setEdit(null)}>
            Отмена
          </button>
        </div>
      )}
      <div className="mt-2 text-xs text-slate-400">
        Кто знает код — тот регистрируется с соответствующей ролью. Держите коды в секрете и периодически меняйте.
      </div>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => apiGet<{ items: User[] }>('/users') });
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });

  const toggle = useMutation({ mutationFn: (id: number) => apiPatch(`/users/${id}/toggle`), onSuccess: invalidate });

  if (isLoading || !data) return <Spinner />;

  return (
    <div>
      <RegCodes />
      <div className="mb-3 flex justify-end">
        <button
          className="btn-primary"
          onClick={() => {
            setEditing(null);
            setModal(true);
          }}
        >
          + Пользователь
        </button>
      </div>
      <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2.5">Логин</th>
              <th className="px-3 py-2.5">ФИО</th>
              <th className="px-3 py-2.5">Роль</th>
              <th className="px-3 py-2.5">Статус</th>
              <th className="px-3 py-2.5">Создан</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((u) => (
              <tr key={u.id} className="hover:bg-slate-50/60">
                <td className="px-3 py-2.5 font-medium">{u.login}</td>
                <td className="px-3 py-2.5">{u.fio}</td>
                <td className="px-3 py-2.5">
                  <Badge tone={u.role === 'admin' ? 'blue' : 'slate'}>{u.role}</Badge>
                </td>
                <td className="px-3 py-2.5">
                  {u.active ? <Badge tone="green">активен</Badge> : <Badge tone="red">заблокирован</Badge>}
                </td>
                <td className="px-3 py-2.5">{formatDate(u.createdAt)}</td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      className="btn-ghost px-2 py-1 text-xs"
                      onClick={() => {
                        setEditing(u);
                        setModal(true);
                      }}
                    >
                      Изменить
                    </button>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => toggle.mutate(u.id)}>
                      {u.active ? 'Заблокировать' : 'Разблокировать'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Редактирование пользователя' : 'Новый пользователь'}>
        <UserForm editing={editing} onDone={() => setModal(false)} onSaved={invalidate} />
      </Modal>
    </div>
  );
}

function UserForm({ editing, onDone, onSaved }: { editing: User | null; onDone: () => void; onSaved: () => void }) {
  const [login, setLogin] = useState(editing?.login ?? '');
  const [fio, setFio] = useState(editing?.fio ?? '');
  const [role, setRole] = useState<'admin' | 'operator'>(editing?.role ?? 'operator');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (editing) {
        await apiPut(`/users/${editing.id}`, { fio, role, ...(password ? { password } : {}) });
      } else {
        await apiPost('/users', { login, fio, role, password });
      }
      onSaved();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {!editing && (
        <div>
          <label className="label">Логин</label>
          <input className="input" value={login} onChange={(e) => setLogin(e.target.value)} />
        </div>
      )}
      <div>
        <label className="label">ФИО</label>
        <input className="input" value={fio} onChange={(e) => setFio(e.target.value)} />
      </div>
      <div>
        <label className="label">Роль</label>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'operator')}>
          <option value="operator">Оператор</option>
          <option value="admin">Администратор</option>
        </select>
      </div>
      <div>
        <label className="label">{editing ? 'Новый пароль (если менять)' : 'Пароль'}</label>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          Сохранить
        </button>
      </div>
    </form>
  );
}

// ---------- Справочники ----------
interface DictItem {
  id: number;
  category: string;
  label: string;
  sortOrder: number;
  active: boolean;
}

function DictTab() {
  const qc = useQueryClient();
  const [category, setCategory] = useState('city');
  const [newLabel, setNewLabel] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['dict', category],
    queryFn: () => apiGet<DictItem[]>(`/dictionaries/${category}`),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dict', category] });
    qc.invalidateQueries({ queryKey: ['dictionaries'] });
  };

  const add = useMutation({
    mutationFn: () => apiPost('/dictionaries', { category, label: newLabel }),
    onSuccess: () => {
      setNewLabel('');
      invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: (it: DictItem) => apiPut(`/dictionaries/${it.id}`, { active: !it.active }),
    onSuccess: invalidate,
  });
  const rename = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) => apiPut(`/dictionaries/${id}`, { label }),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (id: number) => apiDelete(`/dictionaries/${id}`), onSuccess: invalidate });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <div className="space-y-1">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            className={`w-full rounded-lg px-3 py-2 text-left text-sm ${category === c.key ? 'bg-brand-500 text-white' : 'hover:bg-slate-100'}`}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="lg:col-span-3">
        <div className="mb-3 flex gap-2">
          <input
            className="input"
            placeholder="Новое значение…"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button className="btn-primary" disabled={!newLabel.trim()} onClick={() => add.mutate()}>
            Добавить
          </button>
        </div>
        {isLoading || !data ? (
          <Spinner />
        ) : (
          <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
            <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
              <tbody className="divide-y divide-slate-100">
                {data.map((it) => (
                  <tr key={it.id} className={it.active ? '' : 'opacity-50'}>
                    <td className="px-3 py-2">
                      <input
                        className="w-full bg-transparent outline-none"
                        defaultValue={it.label}
                        onBlur={(e) => e.target.value !== it.label && rename.mutate({ id: it.id, label: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => toggle.mutate(it)}>
                          {it.active ? 'Скрыть' : 'Включить'}
                        </button>
                        {it.active && (
                          <button className="btn-danger px-2 py-1 text-xs" onClick={() => del.mutate(it.id)}>
                            Деактивировать
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
