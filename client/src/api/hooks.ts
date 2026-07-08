import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './client';

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Список журнала с фильтрами
export function useList<T>(entity: string, params: Record<string, unknown> = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();
  return useQuery({
    queryKey: [entity, params],
    queryFn: () => apiGet<ListResponse<T>>(`/${entity}${query ? `?${query}` : ''}`),
  });
}

// Какие наборы данных затрагивает изменение сущности. Запись влияет и на другие
// вкладки (платёж меняет остаток операции и предоплаты, консультация — воронку/KPI),
// поэтому инвалидируем связанные ключи точечно, а не «все запросы разом».
// Ключи соответствуют реальным queryKey страниц (dashboard/prepayments/kpi-report/
// patient-card/errors — отдельные ключи, а не «reports»). invalidateQueries по
// префиксу накрывает и производные (['patients','picker',…] и т.п.).
const RELATED_KEYS: Record<string, string[]> = {
  payments: ['payments', 'operations', 'prepayments', 'dashboard', 'kpi-report', 'patient-card', 'errors', 'dictionaries'],
  consultations: ['consultations', 'payments', 'prepayments', 'dashboard', 'kpi-report', 'patient-card', 'errors', 'dictionaries'],
  operations: ['operations', 'payments', 'prepayments', 'dashboard', 'kpi-report', 'patient-card', 'errors'],
  patients: ['patients', 'consultations', 'operations', 'payments', 'prepayments', 'dashboard', 'patient-card', 'errors'],
};

// Универсальные мутации CRUD
export function useCrudMutations(entity: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    const keys = RELATED_KEYS[entity] ?? [entity];
    for (const k of keys) qc.invalidateQueries({ queryKey: [k] });
  };

  const create = useMutation({
    mutationFn: (data: unknown) => apiPost(`/${entity}`, data),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: number; data: unknown }) => apiPut(`/${entity}/${id}`, data),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiDelete(`/${entity}/${id}`),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: (id: number) => apiPatch(`/${entity}/${id}/restore`),
    onSuccess: invalidate,
  });

  return { create, update, remove, restore };
}
