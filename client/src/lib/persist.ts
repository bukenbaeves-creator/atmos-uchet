// Состояние экрана на время сессии браузера (фильтры таблиц, активные вкладки, последняя
// открытая страница раздела). sessionStorage: живёт, пока открыта вкладка браузера, и не
// «залипает» навсегда. Все обращения в try/catch — приватный режим/запрет хранилища.

export function loadSession<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveSession(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — просто не запоминаем */
  }
}

export function clearSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
