import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, apiPut } from '../api/client';
import { PageHeader, Spinner } from '../components/ui';

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'city', label: 'Города' },
  { key: 'doctor', label: 'Врачи' },
  { key: 'op_type', label: 'Типы операций' },
  { key: 'pay_method', label: 'Способы оплаты' },
  { key: 'terminal', label: 'Терминалы' },
  { key: 'service_type', label: 'Виды услуг' },
  { key: 'consultation_stage', label: 'Стадии итога' },
  { key: 'vid', label: 'Вид консультации' },
  { key: 'zapis', label: 'Запись' },
  { key: 'manager', label: 'Менеджеры' },
];

interface DictItem {
  id: number;
  category: string;
  label: string;
  sortOrder: number;
  active: boolean;
}

// Управление справочниками — доступно операторам и админам.
export function Dictionaries() {
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
    <div>
      <PageHeader title="Справочники" subtitle="Значения для выпадающих списков во всех формах." />
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
    </div>
  );
}
