import dayjs from 'dayjs';

// Суммы показываем числом с разделением разрядов, без символа валюты.
export const formatMoney = (v: number | null | undefined): string =>
  v == null ? '—' : Math.round(v).toLocaleString('ru-RU');

export const formatNumber = (v: number | null | undefined): string =>
  v == null ? '—' : v.toLocaleString('ru-RU');

export const formatDate = (v: string | Date | null | undefined): string =>
  v ? dayjs(v).format('DD.MM.YYYY') : '—';

export const formatDateTime = (v: string | Date | null | undefined): string =>
  v ? dayjs(v).format('DD.MM.YYYY HH:mm:ss') : '—';

// Для <input type="date">
export const toInputDate = (v: string | Date | null | undefined): string =>
  v ? dayjs(v).format('YYYY-MM-DD') : '';

// Срок годности истёк (дата в прошлом). Пусто/бессрочный → false.
export const isExpired = (v: string | Date | null | undefined): boolean =>
  v ? dayjs(v).isBefore(dayjs(), 'day') : false;
