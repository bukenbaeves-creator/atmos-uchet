const BASE = (import.meta.env.VITE_API_URL as string) || 'http://localhost:4000';

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

export const exportUrl = (journal: string) => `${BASE}/api/export/${journal}.xlsx`;

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
