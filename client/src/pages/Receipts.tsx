import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiUpload, apiDelete, ApiError, receiptTemplateUrl } from '../api/client';
import type { ListResponse } from '../api/hooks';
import { formatDate, isExpired } from '../lib/format';
import { PageHeader, Spinner, EmptyState, Modal, Pagination, Hint, Badge } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { MoneyInput } from '../components/MoneyInput';
import { useAuth } from '../lib/auth';

interface Batch {
  id: number;
  qtyIn: number;
  purchasePrice?: number; // только администратору
  series: string | null;
  expiryDate: string | null;
  nomenclature?: { nameDisplay: string };
}
interface RLine {
  id: number;
  name: string;
  qty: number;
  purchasePrice?: number; // только администратору
  series: string | null;
  expiryDate: string | null;
  type: 'drug' | 'consumable' | null;
  minStock?: number | null;
  unit: string | null;
}
interface Receipt {
  id: number;
  date: string;
  status: 'pending' | 'approved';
  supplier: string | null;
  note: string | null;
  createdBy?: number | null;
  batches: Batch[];
  lines: RLine[];
}
// Позиция для автоподсказки наименования (существующая номенклатура)
interface NomOption {
  id: number;
  nameDisplay: string;
  type: 'drug' | 'consumable';
  unitMeasure: string | null;
  minStock: number;
}

interface Line {
  name: string;
  qty: string;
  purchasePrice: number | string | null;
  series: string;
  expiryDate: string;
  noExpiry: boolean;
  type: '' | 'drug' | 'consumable';
  minStock: string;
  unit: string;
}

const emptyLine = (): Line => ({ name: '', qty: '', purchasePrice: '', series: '', expiryDate: '', noExpiry: false, type: '', minStock: '', unit: '' });

function StatusBadge({ status }: { status: 'pending' | 'approved' }) {
  return status === 'approved' ? <Badge tone="green">Одобрен</Badge> : <Badge tone="amber">На согласовании</Badge>;
}
// Наименования состава прихода: из партий (одобрен) или из строк (на согласовании).
function receiptItems(r: Receipt): string {
  const src = r.status === 'approved' ? r.batches.map((b) => `${b.nomenclature?.nameDisplay ?? '—'} ×${b.qtyIn}`) : r.lines.map((l) => `${l.name} ×${l.qty}`);
  return src.join(', ');
}
function receiptCount(r: Receipt): number {
  return r.status === 'approved' ? r.batches.length : r.lines.length;
}

// Отображение срока годности: красный если истёк, «бессрочный» если пусто.
function ExpiryCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-slate-400">бессрочный</span>;
  return isExpired(value) ? (
    <span className="font-semibold text-rose-600">{formatDate(value)} · просрочен</span>
  ) : (
    <span>{formatDate(value)}</span>
  );
}

export function Receipts() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detail, setDetail] = useState<Receipt | null>(null);

  const refresh = () => {
    for (const k of ['receipts', 'stock', 'nomenclature']) qc.invalidateQueries({ queryKey: [k] });
  };

  const { data, isLoading, isError } = useQuery({
    queryKey: ['receipts', { page }],
    queryFn: () => apiGet<ListResponse<Receipt>>(`/receipts?page=${page}`),
  });

  const columns: Column<Receipt>[] = [
    { header: 'Дата', cell: (r) => formatDate(r.date) },
    { header: 'Статус', cell: (r) => <StatusBadge status={r.status} /> },
    { header: 'Поставщик', cell: (r) => r.supplier ?? '—' },
    { header: 'Позиций', align: 'right', cell: (r) => receiptCount(r) },
    { header: 'Состав', cell: (r) => <span className="text-slate-600">{receiptItems(r)}</span> },
  ];

  return (
    <div>
      <PageHeader
        title="Приход на склад"
        subtitle="Оприходование материалов. Приход медсестры проходит согласование администратора. Клик по строке — состав прихода."
        actions={
          <>
            <button className="btn-ghost" onClick={() => setImporting(true)}>
              Загрузить из Excel
            </button>
            <button className="btn-primary" onClick={() => setOpen(true)}>
              + Приход
            </button>
          </>
        }
      />

      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : !data || data.items.length === 0 ? (
        <EmptyState>Приходов пока нет</EmptyState>
      ) : (
        <>
          <Table columns={columns} rows={data.items} onRowClick={(r) => setDetail(r)} />
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} wide title="Новый приход">
        <ReceiptForm onDone={() => setOpen(false)} onSaved={refresh} />
      </Modal>

      <Modal open={importing} onClose={() => setImporting(false)} title="Импорт прихода из Excel">
        <ImportForm onDone={() => setImporting(false)} onSaved={refresh} />
      </Modal>

      <Modal open={detail != null} onClose={() => setDetail(null)} wide title={`Приход · ${detail ? formatDate(detail.date) : ''}`}>
        {detail && (
          <ReceiptDetail
            receipt={detail}
            onDeleted={() => {
              refresh();
              setDetail(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

interface ImportIssue {
  row: number;
  reason: string;
  cells?: string[];
}
interface ImportResult {
  imported: number;
  valid: number;
  blocked: boolean;
  blockReason?: 'errors' | 'expired' | null;
  pending?: boolean; // импорт медсестры — ушёл на согласование
  errors: ImportIssue[];
  warnings: ImportIssue[];
  header: string[];
}

// Формирует CSV из ошибочных строк (исходные ячейки + причина) и скачивает файл,
// чтобы сотрудник исправил его и загрузил заново.
function downloadErrorRows(res: ImportResult) {
  const cols = res.header?.length ? res.header : ['Наименование', 'Количество', 'Цена закупа', 'Серия', 'Срок годности', 'Единица'];
  const esc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [[...cols, 'Причина ошибки'].map(esc).join(';')];
  for (const e of res.errors) {
    const cells = cols.map((_, i) => e.cells?.[i] ?? '');
    lines.push([...cells, e.reason].map(esc).join(';'));
  }
  const csv = '﻿' + lines.join('\r\n'); // BOM — чтобы Excel правильно показал кириллицу
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ошибочные-строки.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function IssueList({ items, tone }: { items: ImportIssue[]; tone: 'rose' | 'amber' }) {
  return (
    <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 text-sm">
      {items.map((e, i) => (
        <div key={i} className="flex gap-3 border-b border-slate-100 px-3 py-1.5 last:border-0">
          {e.row > 0 && <span className="w-14 shrink-0 text-slate-400">стр. {e.row}</span>}
          <span className={tone === 'rose' ? 'text-rose-700' : 'text-amber-700'}>{e.reason}</span>
        </div>
      ))}
    </div>
  );
}

// Импорт прихода из Excel: выбор файла, дата/поставщик, отчёт о результате.
// Правило «стоп при ошибках»: если есть ошибки — по умолчанию не грузим ничего,
// сотрудник осознанно решает — исправить файл или загрузить только корректные.
function ImportForm({ onDone, onSaved }: { onDone: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [supplier, setSupplier] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pendingPartial, setPendingPartial] = useState(false);
  const [pendingExpired, setPendingExpired] = useState(false);
  const [expiredAck, setExpiredAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (override: boolean, allowPartial: boolean, confirmExpired: boolean) => {
    if (!file) {
      setError('Выберите файл');
      return;
    }
    setError(null);
    setBusy(true);
    setPendingPartial(allowPartial);
    setPendingExpired(confirmExpired);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('date', date);
      if (supplier) fd.append('supplier', supplier);
      if (override) fd.append('override', 'true');
      if (allowPartial) fd.append('allowPartial', 'true');
      if (confirmExpired) fd.append('confirmExpired', 'true');
      const res = await apiUpload<ImportResult>('/receipts/import', fd);
      setResult(res);
      setConflict(false);
      if (res.imported > 0) onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : 'Не удалось импортировать');
      }
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setResult(null);
    setFile(null);
    setError(null);
    setConflict(false);
    setExpiredAck(false);
  };

  if (result) {
    const { imported, valid, blocked, blockReason, errors, warnings, pending } = result;

    // Заблокировано из-за просрочки — грузим только после явного подтверждения.
    if (blocked && blockReason === 'expired') {
      return (
        <div className="space-y-3">
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <b>Обнаружены просроченные позиции ({warnings.length}).</b> Они ещё <b>не загружены</b> на склад. Проверьте
            список и подтвердите, если действительно нужно их оприходовать.
          </div>
          <IssueList items={warnings} tone="amber" />
          {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={expiredAck} onChange={(e) => setExpiredAck(e.target.checked)} className="mt-0.5" />
            Понимаю, что {warnings.length} позиц. просрочены, и всё равно хочу их загрузить.
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={restart}>
              Отмена
            </button>
            <button
              type="button"
              className={conflict ? 'btn-danger' : 'btn-primary'}
              disabled={busy || !expiredAck}
              onClick={() => upload(conflict, pendingPartial, true)}
            >
              {busy ? 'Загрузка…' : `Загрузить (${valid})`}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {blocked ? (
          <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
            <b>Ничего не загружено.</b> В файле {errors.length} строк(и) с ошибками. Чтобы не потерять позиции, исправьте
            файл и загрузите заново{valid > 0 ? ', либо осознанно загрузите только корректные строки' : ''}.
          </div>
        ) : (
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {pending ? 'Отправлено на согласование' : 'Импортировано'} строк: <b>{imported}</b>
            {errors.length > 0 && <> · пропущено с ошибками: <b>{errors.length}</b></>}
            {pending && <div className="mt-1 text-xs text-emerald-700">Приход появится в остатках после одобрения администратором.</div>}
          </div>
        )}

        {warnings.length > 0 && (
          <div>
            <div className="mb-1 text-sm font-medium text-amber-700">Предупреждения (загружены, но проверьте):</div>
            <IssueList items={warnings} tone="amber" />
          </div>
        )}

        {errors.length > 0 && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-rose-700">Строки с ошибками:</span>
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => downloadErrorRows(result)}>
                Скачать ошибочные строки
              </button>
            </div>
            <IssueList items={errors} tone="rose" />
          </div>
        )}

        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        <div className="flex flex-wrap justify-end gap-2">
          {blocked ? (
            <>
              <button type="button" className="btn-ghost" onClick={restart}>
                Исправить и загрузить заново
              </button>
              {valid > 0 &&
                (conflict ? (
                  <button type="button" className="btn-danger" disabled={busy} onClick={() => upload(true, true, pendingExpired)}>
                    {busy ? 'Загрузка…' : 'Всё равно загрузить'}
                  </button>
                ) : (
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => upload(false, true, false)}>
                    {busy ? 'Загрузка…' : `Загрузить только корректные (${valid})`}
                  </button>
                ))}
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={onDone}>
              Готово
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Загрузите файл по <a className="text-brand-600 hover:underline" href={receiptTemplateUrl()}>шаблону</a>. Новые
        наименования уйдут на подтверждение в «Номенклатуру». Если в файле есть ошибки — по умолчанию ничего не
        загрузится, чтобы позиции не потерялись.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Дата прихода *</label>
          <input type="date" className="input" required min="2020-01-01" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Поставщик</label>
          <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">Файл (.xlsx или .csv) *</label>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm hover:file:bg-slate-200"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>

      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        {conflict ? (
          <button type="button" className="btn-danger" disabled={busy} onClick={() => upload(true, pendingPartial, pendingExpired)}>
            {busy ? 'Загрузка…' : 'Загрузить повторно'}
          </button>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !file} onClick={() => upload(false, false, false)}>
            {busy ? 'Загрузка…' : 'Импортировать'}
          </button>
        )}
      </div>
    </div>
  );
}

function ReceiptDetail({ receipt, onDeleted }: { receipt: Receipt; onDeleted: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isPending = receipt.status === 'pending';
  const canReject = isAdmin || receipt.createdBy === user?.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setError(null);
    setBusy(true);
    try {
      await fn();
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  };

  const approve = () => run(() => apiPatch(`/receipts/${receipt.id}/approve`, {}), 'Одобрить приход? Позиции будут оприходованы и появятся в остатках склада.');
  const cancelApproved = () =>
    run(() => apiDelete(`/receipts/${receipt.id}`), 'Отменить приход и удалить все его позиции? Действие нельзя вернуть — данные останутся только в журнале аудита.');
  const reject = () => run(() => apiDelete(`/receipts/${receipt.id}`), 'Отклонить приход на согласовании?');

  const typeLabel = (t: 'drug' | 'consumable' | null) => (t === 'drug' ? 'Препарат' : t === 'consumable' ? 'Расходник' : '—');

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1">
        <StatusBadge status={receipt.status} />
        <div>
          <span className="text-slate-400">Дата:</span> {formatDate(receipt.date)}
        </div>
        <div>
          <span className="text-slate-400">Поставщик:</span> {receipt.supplier ?? '—'}
        </div>
        {receipt.note && (
          <div>
            <span className="text-slate-400">Примечание:</span> {receipt.note}
          </div>
        )}
      </div>

      {isPending ? (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
              <th className="py-2">Наименование</th>
              <th className="py-2">Тип</th>
              <th className="py-2 text-right">Кол-во</th>
              <th className="py-2 text-right">Мин. остаток</th>
              <th className="py-2">Серия</th>
              <th className="py-2">Срок годности</th>
              {isAdmin && <th className="py-2 text-right">Цена закупа</th>}
            </tr>
          </thead>
          <tbody>
            {receipt.lines.map((l) => (
              <tr key={l.id} className="border-b border-slate-100">
                <td className="py-2 font-medium">{l.name}</td>
                <td className="py-2">{typeLabel(l.type)}</td>
                <td className="py-2 text-right">{l.qty}</td>
                <td className="py-2 text-right">{l.minStock != null ? l.minStock : '—'}</td>
                <td className="py-2">{l.series ?? '—'}</td>
                <td className="py-2">
                  <ExpiryCell value={l.expiryDate} />
                </td>
                {isAdmin && <td className="py-2 text-right">{l.purchasePrice != null ? l.purchasePrice.toLocaleString('ru-RU') : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
              <th className="py-2">Наименование</th>
              <th className="py-2 text-right">Кол-во</th>
              <th className="py-2">Серия</th>
              <th className="py-2">Срок годности</th>
              {isAdmin && <th className="py-2 text-right">Цена закупа</th>}
            </tr>
          </thead>
          <tbody>
            {receipt.batches.map((b) => (
              <tr key={b.id} className="border-b border-slate-100">
                <td className="py-2 font-medium">{b.nomenclature?.nameDisplay ?? '—'}</td>
                <td className="py-2 text-right">{b.qtyIn}</td>
                <td className="py-2">{b.series ?? '—'}</td>
                <td className="py-2">
                  <ExpiryCell value={b.expiryDate} />
                </td>
                {isAdmin && <td className="py-2 text-right">{b.purchasePrice != null ? b.purchasePrice.toLocaleString('ru-RU') : '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      {isPending ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-400">
            {isAdmin ? 'Одобрите — позиции попадут в остатки. Отклонение удалит приход.' : 'Приход ожидает одобрения администратора.'}
          </span>
          <div className="flex gap-2">
            {canReject && (
              <button type="button" className="btn-ghost text-rose-600" disabled={busy} onClick={reject}>
                Отклонить
              </button>
            )}
            {isAdmin && (
              <button type="button" className="btn-primary" disabled={busy} onClick={approve}>
                {busy ? '…' : 'Одобрить'}
              </button>
            )}
          </div>
        </div>
      ) : (
        isAdmin && (
          <div className="flex items-center justify-between border-t border-slate-100 pt-3">
            <span className="text-xs text-slate-400">Отмена доступна, пока из позиций прихода ничего не списано.</span>
            <button type="button" className="btn-danger" disabled={busy} onClick={cancelApproved}>
              {busy ? 'Отмена…' : 'Отменить приход'}
            </button>
          </div>
        )
      )}
    </div>
  );
}

function ReceiptForm({ onDone, onSaved }: { onDone: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Автоподсказки: существующая номенклатура (для «Наименование») и поставщики.
  const { data: nomData } = useQuery({
    queryKey: ['nomenclature', 'for-receipt'],
    queryFn: () => apiGet<{ items: NomOption[] }>('/nomenclature'),
  });
  const noms = nomData?.items ?? [];
  const { data: supData } = useQuery({
    queryKey: ['receipt-suppliers'],
    queryFn: () => apiGet<{ items: string[] }>('/receipts/suppliers'),
  });
  const suppliers = supData?.items ?? [];

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (i: number) => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  // Ввод наименования: если точно совпало с существующей позицией — подставляем её
  // тип, минимальный остаток и единицу (для быстрого заполнения).
  const setName = (i: number, value: string) => {
    const match = noms.find((n) => n.nameDisplay.trim().toLowerCase() === value.trim().toLowerCase());
    if (match) setLine(i, { name: value, type: match.type, minStock: match.minStock != null ? String(match.minStock) : '', unit: match.unitMeasure ?? '' });
    else setLine(i, { name: value });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPost('/receipts', {
        date,
        supplier: supplier || null,
        note: note || null,
        lines: lines.map((l) => ({
          name: l.name.trim(),
          qty: Number(l.qty),
          purchasePrice: l.purchasePrice === '' || l.purchasePrice == null ? 0 : Number(l.purchasePrice),
          series: l.series || null,
          expiryDate: l.noExpiry ? null : l.expiryDate || null,
          type: l.type || null,
          minStock: l.minStock === '' ? null : Number(l.minStock),
          unit: l.unit || null,
        })),
      });
      onSaved();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {!isAdmin && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          Приход уйдёт на согласование администратора и попадёт в остатки после одобрения.
        </div>
      )}
      <datalist id="nom-names">
        {noms.map((n) => (
          <option key={n.id} value={n.nameDisplay} />
        ))}
      </datalist>
      <datalist id="receipt-suppliers">
        {suppliers.map((s, i) => (
          <option key={i} value={s} />
        ))}
      </datalist>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label">Дата прихода *</label>
          <input type="date" className="input" required min="2020-01-01" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">
            Поставщик<Hint text="Начните вводить — подскажет ранее внесённых поставщиков." />
          </label>
          <input className="input" list="receipt-suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="ТОО, аптека…" />
        </div>
        <div>
          <label className="label">Примечание</label>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium text-slate-600">Позиции прихода</div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-lg border border-slate-200 p-2">
            <div className="col-span-12 sm:col-span-5">
              <label className="label">
                Наименование *<Hint text="Начните вводить — подскажет уже внесённые позиции; при совпадении подставит тип и минимальный остаток." />
              </label>
              <input className="input" list="nom-names" required value={l.name} onChange={(e) => setName(i, e.target.value)} />
            </div>
            <div className="col-span-6 sm:col-span-3">
              <label className="label">Тип</label>
              <select className="input" value={l.type} onChange={(e) => setLine(i, { type: e.target.value as '' | 'drug' | 'consumable' })}>
                <option value="">— тип —</option>
                <option value="consumable">Расходник</option>
                <option value="drug">Препарат</option>
              </select>
            </div>
            <div className="col-span-6 sm:col-span-2">
              <label className="label">Кол-во *</label>
              <input type="number" min={0} step="any" className="input" required value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
            </div>
            <div className="col-span-6 sm:col-span-2">
              <label className="label">
                Цена закупа *<Hint text="Цена за одну единицу прихода, не за всю партию." />
              </label>
              <MoneyInput value={l.purchasePrice} onChange={(v) => setLine(i, { purchasePrice: v as string })} required />
            </div>

            <div className="col-span-6 sm:col-span-2">
              <label className="label">
                Мин. остаток<Hint text="Порог дозакупа: ниже него позиция подсветится и попадёт в список к закупу." />
              </label>
              <input type="number" min={0} step="any" className="input" value={l.minStock} onChange={(e) => setLine(i, { minStock: e.target.value })} placeholder="—" />
            </div>
            <div className="col-span-6 sm:col-span-3">
              <label className="label">
                Серия<Hint text="Номер серии/партии от производителя (с упаковки) — для отзыва партий и контроля." />
              </label>
              <input className="input" value={l.series} onChange={(e) => setLine(i, { series: e.target.value })} />
            </div>
            <div className="col-span-6 sm:col-span-3">
              <label className="label">
                Срок годности<Hint text="До какой даты препарат годен. Для позиций без срока отметьте «Бессрочный»." />
              </label>
              <input
                type="date"
                className="input"
                disabled={l.noExpiry}
                value={l.noExpiry ? '' : l.expiryDate}
                onChange={(e) => setLine(i, { expiryDate: e.target.value })}
              />
            </div>
            <div className="col-span-4 sm:col-span-2">
              <label className="label">Бессрочный</label>
              <div className="flex h-[38px] items-center">
                <input type="checkbox" checked={l.noExpiry} onChange={(e) => setLine(i, { noExpiry: e.target.checked })} />
              </div>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="label">&nbsp;</label>
              <button type="button" className="btn-ghost px-2 py-2 text-xs text-rose-600" onClick={() => removeLine(i)} title="Удалить строку">
                ✕
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="btn-ghost text-sm" onClick={addLine}>
          + Добавить позицию
        </button>
      </div>

      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Сохранение…' : isAdmin ? 'Оприходовать' : 'Отправить на согласование'}
        </button>
      </div>
    </form>
  );
}
