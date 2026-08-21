import { useState } from 'react';
import dayjs from 'dayjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { JournalPage } from '../components/JournalPage';
import { apiGet, apiPatch, ApiError } from '../api/client';
import { formatDate, formatMoney, formatDateTime } from '../lib/format';
import { Badge, Modal } from '../components/ui';
import { useDictionaries } from '../lib/dictionaries';
import { useAuth } from '../lib/auth';
import type { Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface RescheduleRow {
  id: number;
  oldDate: string | null;
  newDate: string;
  reason: string;
  createdByFio: string | null;
  createdAt: string;
}

interface Participant {
  id: number;
  payeeId: number;
  role: 'surgeon' | 'anesthesiologist' | 'assistant' | 'resident';
  // sharePct сервер в журнал операций НЕ отдаёт (конфиденциально — только модуль выплат)
  anesthesiaType: string | null;
  shiftDay: boolean;
  shiftNight: boolean;
  payee?: { id: number; fio: string; dictionaryLabel: string | null; kind: string };
}

interface Operation {
  id: number;
  patient?: { fio: string };
  dateOp: string | null;
  opType: string | null;
  surgeon: string | null;
  anesthesiologist?: string | null;
  manager: string | null;
  cost: number;
  totalDue: number;
  paid: number;
  balance: number;
  fullyPaid: boolean;
  contractSigned: boolean;
  participants?: Participant[];
  createdBy?: number | null;
  createdAt?: string;
}

interface Payee {
  id: number;
  fio: string;
  dictionaryLabel: string | null;
  kind: string;
  active: boolean;
}

const fields: Field[] = [
  { name: 'patient', label: 'Пациент', type: 'patientBlock', required: true, span: 2, requireBirthDate: true },
  { name: 'manager', label: 'Менеджер (кто записал)', type: 'select', dict: 'manager', required: true },
  // Дата — только чтение при правке; переносится отдельной кнопкой с причиной (для следа).
  { name: 'dateOp', label: 'Дата операции', type: 'date', required: true, lockOnEdit: true },
  { name: 'opType', label: 'Тип операции', type: 'select', dict: 'op_type', required: true },
  // Поле в БД называется surgeon, но терминология единая — «Врач» (общий справочник doctor)
  { name: 'surgeon', label: 'Врач', type: 'select', dict: 'doctor', required: true },
  { name: 'anesthesiologist', label: 'Анестезиолог', type: 'text' },
  { name: 'cost', label: 'Стоимость операции', type: 'money', required: true },
  { name: 'anesthesiaCost', label: 'Стоимость наркоза', type: 'money' },
  { name: 'implantsCost', label: 'Импланты, ₸', type: 'money' },
  { name: 'assistantCost', label: 'Оплата ассистенту/медсестре, ₸', type: 'money' },
  { name: 'zapis', label: 'Запись', type: 'select', dict: 'zapis', required: true },
  { name: 'contractSigned', label: 'Договор подписан', type: 'checkbox' },
  { name: 'confirmDuplicate', label: 'Разрешить дубль (такая операция уже есть)', type: 'checkbox' },
  { name: 'note', label: 'Примечание', type: 'textarea', span: 2 },
];

export function Operations() {
  const { data: dict } = useDictionaries();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [rescheduleFor, setRescheduleFor] = useState<Operation | null>(null);
  const opt = (arr?: { id: number; label: string }[]) => (arr ?? []).map((o) => ({ value: o.label, label: o.label }));

  // Получатели выплат — для привязки участников. Доступны только администратору
  // (эндпоинт /payouts/* закрыт для остальных ролей), поэтому запрос включаем по роли.
  const { data: payeesData } = useQuery({
    queryKey: ['payout-payees'],
    queryFn: () => apiGet<{ items: Payee[] }>('/payouts/payees'),
    enabled: isAdmin,
  });
  const payees = payeesData?.items ?? [];
  const activePayees = payees.filter((p) => p.active);
  const payeeByLabel = new Map<string, Payee>();
  for (const p of payees) if (p.dictionaryLabel) payeeByLabel.set(p.dictionaryLabel.trim(), p);

  // Начальные служебные значения формы из участников редактируемой операции.
  const formExtraInitial = (editing: Operation | null): Record<string, unknown> => {
    const parts = editing?.participants ?? [];
    const asst = parts.find((p) => p.role === 'assistant');
    const anes = parts.find((p) => p.role === 'anesthesiologist');
    return {
      _assistantPayeeId: asst ? String(asst.payeeId) : '',
      _anesthesiaType: anes?.anesthesiaType ?? '',
      _shiftDay: anes?.shiftDay ?? false,
      _shiftNight: anes?.shiftNight ?? false,
    };
  };

  // Блок «Участники». Хирург и анестезиолог берутся из полей «Врач»/«Анестезиолог»
  // (единый контрол — не дублируем ввод). Здесь — статус привязки к получателю,
  // ассистент, тип наркоза и дежурство.
  const renderFormExtra = (values: Record<string, unknown>, set: (n: string, v: unknown) => void) => {
    if (!isAdmin) return null; // привязка участников — только у администратора
    const surgeonLabel = (values.surgeon as string) || '';
    const anesLabel = (values.anesthesiologist as string) || '';
    const surgeonPayee = surgeonLabel ? payeeByLabel.get(surgeonLabel.trim()) : undefined;
    const anesPayee = anesLabel ? payeeByLabel.get(anesLabel.trim()) : undefined;
    const status = (label: string, payee?: Payee) => {
      if (!label) return null;
      return payee ? (
        <span className="text-xs text-emerald-600">✓ получатель: {payee.fio}</span>
      ) : (
        <span className="text-xs text-amber-600">⚠ нет получателя с меткой «{label}» — выплата не начислится (заведите врача в «Настройки выплат»)</span>
      );
    };
    return (
      <div className="rounded-lg border border-slate-200 p-3">
        <div className="mb-2 text-sm font-semibold text-slate-700">Участники операции</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="label">Хирург (из поля «Врач»)</div>
            <div className="text-sm text-slate-600">{surgeonLabel || '—'}</div>
            {status(surgeonLabel, surgeonPayee)}
          </div>
          <div>
            <div className="label">Анестезиолог (из поля «Анестезиолог»)</div>
            <div className="text-sm text-slate-600">{anesLabel || '—'}</div>
            {status(anesLabel, anesPayee)}
          </div>
          <div>
            <label className="label">Ассистент / медсестра</label>
            <select className="input" value={(values._assistantPayeeId as string) ?? ''} onChange={(e) => set('_assistantPayeeId', e.target.value)}>
              <option value="">— нет —</option>
              {activePayees.map((p) => (
                <option key={p.id} value={p.id}>{p.fio}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Тип наркоза</label>
            <input className="input" value={(values._anesthesiaType as string) ?? ''} onChange={(e) => set('_anesthesiaType', e.target.value)} placeholder="общий / седация / …" />
          </div>
          <div className="sm:col-span-2 flex gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={Boolean(values._shiftDay)} onChange={(e) => set('_shiftDay', e.target.checked)} /> Дежурство день
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={Boolean(values._shiftNight)} onChange={(e) => set('_shiftNight', e.target.checked)} /> Дежурство ночь
            </label>
          </div>
        </div>
      </div>
    );
  };

  // Сборка participants из строковых полей и служебных ключей. Отправляем только когда
  // список получателей загружен — иначе рискуем стереть уже привязанных участников.
  const transformPayload = (payload: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> => {
    if (!isAdmin || !payeesData) return payload;
    const parts: Record<string, unknown>[] = [];
    const surgeon = (values.surgeon as string) || '';
    const sp = surgeon ? payeeByLabel.get(surgeon.trim()) : undefined;
    if (sp) parts.push({ payeeId: sp.id, role: 'surgeon' });
    const anes = (values.anesthesiologist as string) || '';
    const ap = anes ? payeeByLabel.get(anes.trim()) : undefined;
    if (ap)
      parts.push({
        payeeId: ap.id,
        role: 'anesthesiologist',
        anesthesiaType: (values._anesthesiaType as string) || null,
        shiftDay: Boolean(values._shiftDay),
        shiftNight: Boolean(values._shiftNight),
      });
    const asstId = values._assistantPayeeId as string;
    if (asstId) parts.push({ payeeId: Number(asstId), role: 'assistant' });
    return { ...payload, participants: parts };
  };

  const columns: Column<Operation>[] = [
    { header: 'Пациент', cell: (o) => <span className="font-medium">{o.patient?.fio ?? '—'}</span> },
    { header: 'Дата', cell: (o) => formatDate(o.dateOp), filter: { kind: 'dateRange', paramFrom: 'dateOpFrom', paramTo: 'dateOpTo' } },
    { header: 'Тип', cell: (o) => o.opType ?? '—', filter: { kind: 'select', param: 'opType', options: opt(dict?.op_type) } },
    { header: 'Менеджер', cell: (o) => o.manager ?? '—', filter: { kind: 'select', param: 'manager', options: opt(dict?.manager) } },
    { header: 'Врач', cell: (o) => o.surgeon ?? '—', filter: { kind: 'select', param: 'surgeon', options: opt(dict?.doctor) } },
    { header: 'К оплате', align: 'right', cell: (o) => formatMoney(o.totalDue) },
    { header: 'Оплачено', align: 'right', cell: (o) => formatMoney(o.paid) },
    {
      header: 'Остаток',
      align: 'right',
      cell: (o) => <span className={o.balance > 0 ? 'font-semibold text-rose-600' : 'text-slate-500'}>{formatMoney(o.balance)}</span>,
    },
    {
      header: 'Статус',
      cell: (o) => (o.fullyPaid ? <Badge tone="green">оплачено 100%</Badge> : <Badge tone="amber">есть остаток</Badge>),
    },
  ];

  // Оператор правит свою операцию до «дата операции + 1 день»; после — только админ.
  const operationEditable = (o: Operation, user: { id: number; role: string } | null) => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (o.createdBy !== user.id) return false;
    if (!o.dateOp) return true;
    return !dayjs().isAfter(dayjs(o.dateOp).add(1, 'day'), 'day');
  };

  return (
    <>
      <JournalPage<Operation>
        entity="operations"
        title="Операции"
        subtitle="Стоимость, оплата и остаток рассчитываются автоматически. Оператор правит запись до «дата операции + 1 день». Дата — только через «Перенести дату»."
        columns={columns}
        fields={fields}
        exportJournal="operations"
        newButtonLabel="Операцию"
        formExtraInitial={formExtraInitial}
        renderFormExtra={renderFormExtra}
        transformPayload={transformPayload}
        rowEditable={operationEditable}
        rowActions={(o) =>
          operationEditable(o, user ?? null) ? (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setRescheduleFor(o)}>
              Перенести дату
            </button>
          ) : null
        }
      />

      <Modal
        open={rescheduleFor != null}
        onClose={() => setRescheduleFor(null)}
        title={`Перенос даты операции · ${rescheduleFor?.patient?.fio ?? ''}`}
      >
        {rescheduleFor && <RescheduleForm op={rescheduleFor} onDone={() => setRescheduleFor(null)} />}
      </Modal>
    </>
  );
}

// Перенос даты операции с обязательной причиной + история переносов.
function RescheduleForm({ op, onDone }: { op: Operation; onDone: () => void }) {
  const qc = useQueryClient();
  const [newDate, setNewDate] = useState(op.dateOp ? op.dateOp.slice(0, 10) : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: hist } = useQuery({
    queryKey: ['op-reschedules', op.id],
    queryFn: () => apiGet<{ items: RescheduleRow[] }>(`/operations/${op.id}/reschedules`),
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!newDate) return setError('Укажите новую дату');
    if (!reason.trim()) return setError('Укажите причину переноса');
    setBusy(true);
    try {
      await apiPatch(`/operations/${op.id}/reschedule`, { newDate, reason: reason.trim() });
      for (const k of ['operations', 'prepayments', 'dashboard', 'kpi-report', 'patient-card']) {
        await qc.invalidateQueries({ queryKey: [k] });
      }
      await qc.invalidateQueries({ queryKey: ['op-reschedules', op.id] });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось перенести дату');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="text-sm text-slate-500">
        Текущая дата операции: <b className="text-slate-700">{formatDate(op.dateOp)}</b>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Новая дата *</label>
          <input
            type="date"
            className="input"
            required
            min="2020-01-01"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label">Причина переноса *</label>
        <textarea
          className="input min-h-[70px]"
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="например, перенос по просьбе пациента / занятость хирурга"
        />
      </div>

      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      {hist && hist.items.length > 0 && (
        <div>
          <div className="mb-1 text-sm font-semibold text-slate-700">История переносов</div>
          <ul className="divide-y divide-slate-100 text-sm">
            {hist.items.map((h) => (
              <li key={h.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {formatDate(h.oldDate)} → <b>{formatDate(h.newDate)}</b>
                  </span>
                  <span className="text-xs text-slate-400">
                    {h.createdByFio ?? '—'} · {formatDateTime(h.createdAt)}
                  </span>
                </div>
                <div className="text-slate-500">{h.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Перенос…' : 'Перенести дату'}
        </button>
      </div>
    </form>
  );
}
