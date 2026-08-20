// В проде фронтенд и API на одном домене -> VITE_API_URL='' (относительные /api).
// В dev клиент на :5173, API на :4000 -> абсолютный адрес. Пусто ('') оставляем как есть.
const _apiUrl = import.meta.env.VITE_API_URL as string | undefined;
const BASE = _apiUrl !== undefined ? _apiUrl : 'http://localhost:4000';

export interface ApiErrorDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  status: number;
  details?: ApiErrorDetail[];
  constructor(status: number, message: string, details?: ApiErrorDetail[]) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Ошибка ${res.status}`, body.details);
  }
  if (res.status === 204) return null as T;
  return res.json();
}

export const apiGet = <T>(path: string) => request<T>(path);
export const apiPost = <T>(path: string, data: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const apiPut = <T>(path: string, data: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(data) });
export const apiPatch = <T>(path: string, data?: unknown) =>
  request<T>(path, { method: 'PATCH', body: data ? JSON.stringify(data) : undefined });
export const apiDelete = <T>(path: string) => request<T>(path, { method: 'DELETE' });

// Контролируемая выгрузка файла: один запрос (с кукой), один файл. В отличие от
// простой ссылки <a href> даёт обратную связь и не плодит повторные загрузки.
export async function downloadFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    // Пытаемся показать осмысленную причину с сервера (напр. нет прав), иначе — общий текст
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Не удалось выгрузить файл (${res.status})`);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export const exportUrl = (journal: string) => `${BASE}/api/export/${journal}.xlsx`;
export const payoutSheetExportUrl = (id: number) => `${BASE}/api/payouts/sheets/${id}/export`;
export const payoutActUrl = (id: number, lineId: number) => `${BASE}/api/payouts/sheets/${id}/lines/${lineId}/act`;
// Выгрузки модуля расходов (stock | purchase-list | expiry | writeoffs)
export const expenseExportUrl = (report: string) => `${BASE}/api/expense-export/${report}.xlsx`;
// Шаблон для импорта прихода
export const receiptTemplateUrl = () => `${BASE}/api/receipts/template.xlsx`;
// Скачивание резервной копии БД (JSON)
export const backupDownloadUrl = () => `${BASE}/api/backup/download`;

// Загрузка файла (multipart) — Content-Type ставит браузер сам
export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Ошибка ${res.status}`, body.details);
  }
  return res.json();
}
