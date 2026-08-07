import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { apiGet, apiPost, apiPut, downloadFile, backupDownloadUrl, ApiError } from '../api/client';
import { formatDateTime } from '../lib/format';
import { PageHeader, Spinner, Badge } from '../components/ui';

interface Status {
  emailConfigured: boolean;
  recipient: string;
  lastRun: string | null;
}

// Инлайн-сообщение (в проекте нет тостов) — зелёное на успех, красное на ошибку.
function Notice({ kind, text }: { kind: 'ok' | 'err'; text: string }) {
  const cls = kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700';
  return <div className={`rounded-lg px-3 py-2 text-sm ${cls}`}>{text}</div>;
}

export function Backup() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['backup-status'],
    queryFn: () => apiGet<Status>('/backup/status'),
  });

  const [recipient, setRecipient] = useState<string | null>(null); // null → берём из data
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  if (isLoading) return <Spinner />;
  if (isError || !data)
    return <div className="py-12 text-center text-sm text-slate-400">Не удалось загрузить настройки.</div>;

  const recipientValue = recipient ?? data.recipient;

  const saveRecipient = async () => {
    setEmailMsg(null);
    setSavingEmail(true);
    try {
      await apiPut('/backup/settings', { recipient: recipientValue.trim() });
      setRecipient(null); // показываем нормализованное сервером значение (из refetch), а не черновик
      await refetch();
      setEmailMsg({ kind: 'ok', text: 'Адрес получателя сохранён.' });
    } catch (err) {
      setEmailMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Не удалось сохранить адрес.' });
    } finally {
      setSavingEmail(false);
    }
  };

  const sendNow = async () => {
    setSendMsg(null);
    setSending(true);
    try {
      const res = await apiPost<{ recipient: string; records: number }>('/backup/email', {});
      await refetch();
      setSendMsg({ kind: 'ok', text: `Копия отправлена на ${res.recipient} (${res.records} записей).` });
    } catch (err) {
      setSendMsg({ kind: 'err', text: err instanceof ApiError ? err.message : 'Не удалось отправить копию.' });
    } finally {
      setSending(false);
    }
  };

  const download = async () => {
    setDownloadErr(null);
    setDownloading(true);
    try {
      await downloadFile(backupDownloadUrl(), `atmos-backup-${dayjs().format('YYYY-MM-DD-HHmm')}.json`);
    } catch (err) {
      setDownloadErr(err instanceof ApiError ? err.message : 'Не удалось скачать копию.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Резервные копии"
        subtitle="Копия всей базы данных: пациенты, операции, платежи, справочники. Храните копии на случай сбоя."
      />

      <div className="space-y-4">
        {/* 1. Отправка на почту */}
        <div className="card">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
            Отправка на почту
            {data.emailConfigured ? <Badge tone="green">почта настроена</Badge> : <Badge tone="amber">почта не настроена</Badge>}
          </div>

          {!data.emailConfigured && (
            <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Отправка по почте пока недоступна: администратор должен задать доступ к почте (SMTP) в переменных
              окружения на сервере (Render). После этого письма начнут отправляться. Скачать копию вручную можно и
              сейчас — блок ниже.
            </div>
          )}

          <label className="label">Кому присылать копии (можно несколько адресов через запятую)</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input max-w-md"
              type="text"
              placeholder="например, klinika@gmail.com"
              value={recipientValue}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <button className="btn-ghost" onClick={saveRecipient} disabled={savingEmail}>
              {savingEmail ? 'Сохранение…' : 'Сохранить адрес'}
            </button>
            <button className="btn-primary" onClick={sendNow} disabled={sending || !data.emailConfigured}>
              {sending ? 'Отправка…' : 'Отправить копию сейчас'}
            </button>
          </div>

          <div className="mt-3 space-y-2">
            {emailMsg && <Notice kind={emailMsg.kind} text={emailMsg.text} />}
            {sendMsg && <Notice kind={sendMsg.kind} text={sendMsg.text} />}
          </div>
        </div>

        {/* 2. Скачать вручную */}
        <div className="card">
          <div className="mb-1 text-sm font-semibold text-slate-700">Скачать копию на компьютер</div>
          <div className="mb-3 text-sm text-slate-500">
            Файл в формате JSON со всеми данными. Сохраните его в надёжном месте (флешка, облако).
          </div>
          <button className="btn-primary" onClick={download} disabled={downloading}>
            {downloading ? 'Готовим файл…' : 'Скачать резервную копию'}
          </button>
          {downloadErr && (
            <div className="mt-3">
              <Notice kind="err" text={downloadErr} />
            </div>
          )}
        </div>

        {/* 3. Автоматически */}
        <div className="card">
          <div className="mb-1 text-sm font-semibold text-slate-700">Автоматическое копирование</div>
          <div className="text-sm text-slate-500">
            Копия отправляется на почту автоматически каждый день (по расписанию GitHub Actions). Это работает,
            даже когда сервер «спит».
          </div>
          <div className="mt-2 text-sm">
            Последняя успешная отправка:{' '}
            {data.lastRun ? (
              <span className="font-medium text-slate-700">{formatDateTime(data.lastRun)}</span>
            ) : (
              <span className="text-slate-400">ещё не было</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
