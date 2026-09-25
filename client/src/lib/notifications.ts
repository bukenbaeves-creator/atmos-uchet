import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';

// Сводка «требует внимания» для бейджей в меню и баннеров.
// Обновляется раз в минуту и при возврате на вкладку — чтобы согласующий увидел
// новый приход, даже если не перезагружал страницу.
export interface NotificationSummary {
  receiptsPending: number;
  nomenclatureDraft: number;
}

export function useNotifications() {
  return useQuery<NotificationSummary>({
    queryKey: ['notifications'],
    queryFn: () => apiGet<NotificationSummary>('/notifications/summary'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}
