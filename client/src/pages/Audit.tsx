import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch } from '../api/client';
import { formatDateTime } from '../lib/format';
import { PageHeader, Spinner, Badge, Modal, Pagination } from '../components/ui';

interface Log {
  id: number;
  userFio: string | null;
  action: string;
  entity: string;
  entityId: number | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  timestamp: string;
}

const ENTITY_PLURAL: Record<string, string> = {
  patient: 'patients',
  consultation: 'consultations',
  operation: 'operations',
  payment: 'payments',
};

const ACTION_TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'slate'> = {
  create: 'green',
  update: 'blue',
  delete: 'red',
  restore: 'green',
  login: 'slate',
};

export function Audit() {
  const qc = useQueryClient();
  const [params, setParams] = useState<Record<string, string | number>>({ page: 1 });
  const [detail, setDetail] = useState<Log | null>(null);

  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== '' && v != null && qs.set(k, String(v)));
  const { data, isLoading } = useQuery({
    queryKey: ['audit', params],
    queryFn: () => apiGet<{ items: Log[]; total: number; page: number; pageSize: number }>(`/audit?${qs}`),
  });

  const restore = useMutation({
    mutationFn: ({ entity, id }: { entity: string; id: number }) =>
      apiPatch(`/${ENTITY_PLURAL[entity]}/${id}/restore`),
    onSuccess: () => {
      qc.invalidateQueries(); // обновляем аудит и список восстановленной сущности
      alert('Запись восстановлена');
    },
    onError: () => alert('Не удалось восстановить (возможно, уже восстановлена)'),
  });

  const setParam = (k: string, v: string) => setParams((s) => ({ ...s, [k]: v, page: 1 }));

  return (
    <div>
      <PageHeader title="Аудит действий" subtitle="Кто, что и когда изменял. Снимки «до/после»." />

      <div className="mb-3 flex flex-wrap gap-2">
        <select className="input max-w-xs" value={(params.entity as string) ?? ''} onChange={(e) => setParam('entity', e.target.value)}>
          <option value="">Все сущности</option>
          <option value="patient">Пациенты</option>
          <option value="consultation">Консультации</option>
          <option value="operation">Операции</option>
          <option value="payment">Платежи</option>
          <option value="dictionary">Справочники</option>
          <option value="user">Пользователи</option>
        </select>
        <select className="input max-w-xs" value={(params.action as string) ?? ''} onChange={(e) => setParam('action', e.target.value)}>
          <option value="">Все действия</option>
          <option value="create">Создание</option>
          <option value="update">Изменение</option>
          <option value="delete">Удаление</option>
          <option value="restore">Восстановление</option>
          <option value="login">Вход</option>
        </select>
      </div>

      {isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
            <table className="min-w-full divide-y divide-slate-200 bg-white text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2.5">Время</th>
                  <th className="px-3 py-2.5">Пользователь</th>
                  <th className="px-3 py-2.5">Действие</th>
                  <th className="px-3 py-2.5">Сущность</th>
                  <th className="px-3 py-2.5">IP</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/60">
                    <td className="px-3 py-2.5 whitespace-nowrap">{formatDateTime(log.timestamp)}</td>
                    <td className="px-3 py-2.5">{log.userFio ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={ACTION_TONE[log.action] ?? 'slate'}>{log.action}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      {log.entity} {log.entityId ? `#${log.entityId}` : ''}
                    </td>
                    <td className="px-3 py-2.5 text-slate-400">{log.ip ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setDetail(log)}>
                          Было/стало
                        </button>
                        {log.action === 'delete' && ENTITY_PLURAL[log.entity] && log.entityId && (
                          <button
                            className="btn-primary px-2 py-1 text-xs"
                            onClick={() => restore.mutate({ entity: log.entity, id: log.entityId! })}
                          >
                            Восстановить
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => setParams((s) => ({ ...s, page: p }))} />
        </>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} wide title="Снимок изменения">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Было</div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-xs">
              {detail?.before ? JSON.stringify(detail.before, null, 2) : '—'}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Стало</div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-xs">
              {detail?.after ? JSON.stringify(detail.after, null, 2) : '—'}
            </pre>
          </div>
        </div>
      </Modal>
    </div>
  );
}
