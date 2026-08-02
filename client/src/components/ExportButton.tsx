import { useState } from 'react';
import { downloadFile } from '../api/client';

// Кнопка выгрузки в Excel: скачивает один файл, на время блокируется и показывает
// «Экспорт…» — чтобы при медленном ответе не кликали повторно (иначе браузер
// скачивает много копий). При ошибке предлагает повторить.
export function ExportButton({
  url,
  filename,
  label = 'Экспорт в Excel',
  className = 'btn-ghost',
}: {
  url: string;
  filename: string;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await downloadFile(url, filename);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={run}
      title={error ? 'Не удалось выгрузить — попробуйте ещё раз' : undefined}
    >
      {busy ? 'Экспорт…' : error ? 'Повторить экспорт' : label}
    </button>
  );
}
