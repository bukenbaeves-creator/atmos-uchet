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

export function useItem<T>(entity: string, id: number | null) {
  return useQuery({
    queryKey: [entity, 'item', id],
    queryFn: () => apiGet<T>(`/${entity}/${id}`),
    enabled: id != null,
  });
}

// Универсальные мутации CRUD
export function useCrudMutations(entity: string) {
  const qc = useQueryClient();
  // Инвалидируем все запросы: запись может влиять на другие вкладки — платная
  // консультация создаёт платёж в «Кассе», платёж меняет остаток операции, и т.д.
  const invalidate = () => qc.invalidateQueries();

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
