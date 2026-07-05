import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { PageHeader, Spinner, Badge, EmptyState } from '../components/ui';

interface Issue {
  type: string;
  entity: string;
  entityId: number;
  label: string;
  detail: string;
}

const ENTITY_ROUTE: Record<string, string> = {
  patient: '/patients',
  consultation: '/consultations',
  operation: '/operations',
  payment: '/cashbox',
};

const TONE: Record<string, 'red' | 'amber' | 'blue'> = {
  anomaly_amount: 'red',
  zero_cost: 'amber',
  empty_stage: 'amber',
  no_phone: 'red',
  duplicate_phone: 'blue',
};

export function ErrorCheck() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['errors'],
    queryFn: () => apiGet<{ issues: Issue[]; count: number }>('/reports/errors'),
  });

  return (
    <div>
      <PageHeader
        title="Проверка ошибок"
        subtitle="Автоматический поиск несостыковок в данных."
      />
      {isLoading || !data ? (
        <Spinner />
      ) : data.count === 0 ? (
        <EmptyState>Ошибок не найдено — данные в порядке ✔</EmptyState>
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-slate-500">Найдено проблем: {data.count}</div>
          {data.issues.map((issue, i) => (
            <div key={i} className="card flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Badge tone={TONE[issue.type] ?? 'slate'}>{issue.entity}</Badge>
                <div>
                  <div className="text-sm font-medium">{issue.detail}</div>
                  <div className="text-xs text-slate-400">
                    {issue.label} · запись #{issue.entityId}
                  </div>
                </div>
              </div>
              {ENTITY_ROUTE[issue.entity] && (
                <button className="btn-ghost" onClick={() => navigate(ENTITY_ROUTE[issue.entity])}>
                  Исправить →
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
