import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';

export type Dictionaries = Record<string, { id: number; label: string }[]>;

// Все справочники разом; кешируются надолго (меняются редко).
export function useDictionaries() {
  return useQuery({
    queryKey: ['dictionaries'],
    queryFn: () => apiGet<Dictionaries>('/dictionaries'),
    staleTime: 5 * 60 * 1000,
  });
}
