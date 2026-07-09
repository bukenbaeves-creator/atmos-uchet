import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { JournalPage } from '../components/JournalPage';
import { useDictionaries } from '../lib/dictionaries';
import { apiPost, ApiError } from '../api/client';
import { formatDate, formatMoney } from '../lib/format';
import { Modal, Badge } from '../components/ui';
import { PatientBlock, type PatientValue } from '../components/PatientBlock';
import { MoneyInput } from '../components/MoneyInput';
import { OperationSelect } from '../components/OperationSelect';
import type { Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface Payment {
  id: number;
  patient?: { id: number; fio: string };
  date: string | null;
  direction?: 'payment' | 'refund';
  serviceType: string | null;
  opType: string | null;
  amount: number;
  payMethod: string | null;
  terminal: string | null;
  doctor: string | null;
  operationId: number | null;
  operation?: { opType: string | null; dateOp: string | null } | null;
  createdBy?: number | null;
  createdAt?: string;
}

// «Касса» — единая точка учёта денег. Отсюда данные автоматически попадают в
// отчёт «Предоплаты и остатки» (привязка платежа к операции).
// Если услуга про операцию (Предоплата/Операция) и операция не выбрана — она создаётся
// на лету, поэтому просим дату/тип/стоимость/менеджера.
const newOp = (v: Record<string, unknown>) =>
  (v.serviceType === 'Предоплата' || v.serviceType === 'Операция') && !v.operationId;
// Платёж за консультацию создаёт запись во вкладке «Консультации» — просим её данные
const konsService = (v: Record<string, unknown>) => v.serviceType === 'Консультация';

const fields: Field[] = [
  { name: 'patient', label: 'Пациент', type: 'patientBlock', required: true, span: 2 },
  { name: 'operationId', label: 'За что платёж (операция)', type: 'operation', span: 2 },
  { name: 'date', label: 'Дата платежа', type: 'date', required: true },
  { name: 'amount', label: 'Сумма', type: 'money', required: true },
  { name: 'serviceType', label: 'Вид услуги', type: 'select', dict: 'service_type', required: true },
  {
    name: 'opType',
    label: 'Вид операции',
    type: 'select',
    dict: 'op_type',
    required: true,
    showWhen: (v) =>
      v.serviceType === 'Операция' || v.serviceType === 'Консультация' || v.serviceType === 'Предоплата',
  },
  { name: 'operationDate', label: 'Дата операции', type: 'date', required: true, showWhen: newOp },
  {
    name: 'manager',
    label: 'Менеджер (кто записал)',
    type: 'select',
    dict: 'manager',
    required: true,
    showWhen: (v) => newOp(v) || konsService(v),
  },
  { name: 'operationCost', label: 'Стоимость операции', type: 'money', showWhen: newOp },
  // --- консультация (создаётся запись во вкладке «Консультации») ---
  { name: 'dateKons', label: 'Дата консультации', type: 'date', required: true, showWhen: konsService },
  { name: 'vid', label: 'Вид консультации', type: 'select', dict: 'vid', required: true, showWhen: konsService },
  {
    name: 'stage',
    label: 'Итог консультации — заполняется после консультации',
    type: 'select',
    dict: 'consultation_stage',
    allowCustom: true,
    showWhen: konsService,
  },
  { name: 'resultDetails', label: 'Детали итога консультации', type: 'textarea', span: 2, showWhen: konsService },
  { name: 'payMethod', label: 'Способ оплаты', type: 'select', dict: 'pay_method', required: true },
  {
    name: 'terminal',
    label: 'Терминал',
    type: 'select',
    dict: 'terminal',
    required: true,
    showWhen: (v) => v.payMethod === 'Через терминал',
  },
  { name: 'doctor', label: 'Врач', type: 'select', dict: 'doctor', required: true },
  { name: 'zapis', label: 'Запись', type: 'select', dict: 'zapis', required: true },
  { name: 'payNote', label: 'Уточнение по оплате', type: 'textarea', span: 2 },
];

export function Cashbox() {
  const { data: dict } = useDictionaries();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [refundOpen, setRefundOpen] = useState(false);

  const columns: Column<Payment>[] = [
    { header: 'Пациент', cell: (p) => <span className="font-medium">{p.patient?.fio ?? '—'}</span> },
    { header: 'Дата', cell: (p) => formatDate(p.date) },
    {
      header: 'Тип',
      cell: (p) => (p.direction === 'refund' ? <Badge tone="red">возврат</Badge> : <Badge tone="green">платёж</Badge>),
    },
    { header: 'Услуга', cell: (p) => (p.opType ? `${p.serviceType ?? '—'} · ${p.opType}` : p.serviceType ?? '—') },
    {
      header: 'Сумма',
      align: 'right',
      cell: (p) => (
        <span className={`font-semibold ${p.direction === 'refund' ? 'text-rose-600' : ''}`}>
          {p.direction === 'refund' ? '−' : ''}
          {formatMoney(p.amount)}
        </span>
      ),
    },
    { header: 'Способ', cell: (p) => p.payMethod ?? '—' },
    { header: 'Терминал', cell: (p) => p.terminal ?? '—' },
    {
      header: 'За операцию',
      cell: (p) => (p.operation ? `${p.operation.opType ?? 'операция'} · ${formatDate(p.operation.dateOp)}` : '—'),
    },
  ];

  return (
    <>
      <JournalPage<Payment>
        entity="payments"
        title="Касса"
        subtitle="Журнал платежей и возвратов. Платёж «Консультация» создаёт запись во вкладке «Консультации». Клик по строке — карточка пациента."
        columns={columns}
        fields={fields}
        exportJournal="payments"
        newButtonLabel="Платёж"
        headerActions={
          <button className="btn-ghost" onClick={() => setRefundOpen(true)}>
            Возврат
          </button>
        }
        onRowClick={(p) => p.patient && navigate(`/patients/${p.patient.id}`)}
        renderFilters={(params, setParam) => (
          <select
            className="input max-w-xs"
            value={(params.payMethod as string) ?? ''}
            onChange={(e) => setParam('payMethod', e.target.value)}
          >
            <option value="">Все способы</option>
            {dict?.pay_method?.map((s) => (
              <option key={s.id} value={s.label}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      />

      <Modal open={refundOpen} onClose={() => setRefundOpen(false)} title="Возврат денег пациенту">
        <RefundForm onDone={() => setRefundOpen(false)} onSaved={() => qc.invalidateQueries()} />
      </Modal>
    </>
  );
}

// Возврат: пациент, сумма, дата, способ, опц. операция, причина. Уменьшает выручку.
function RefundForm({ onDone, onSaved }: { onDone: () => void; onSaved: () => void }) {
  const { data: dict } = useDictionaries();
  const [patient, setPatient] = useState<PatientValue>({});
  const [amount, setAmount] = useState<number | string | null>('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState('');
  const [terminal, setTerminal] = useState('');
  const [operationId, setOperationId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiPost('/payments/refund', {
        patient: {
          fio: (patient.fio ?? '').trim(),
          phone: (patient.phone ?? '').trim(),
          city: patient.city || '',
          birthDate: patient.birthDate || null,
        },
        operationId: operationId ?? null,
        amount: amount === '' || amount == null ? null : Number(amount),
        date,
        payMethod,
        terminal: payMethod === 'Через терминал' ? terminal : null,
        payNote: reason,
      });
      onSaved();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось оформить возврат');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PatientBlock value={patient} onChange={setPatient} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Сумма возврата *</label>
          <MoneyInput value={amount} onChange={setAmount} required />
        </div>
        <div>
          <label className="label">Дата возврата *</label>
          <input type="date" className="input" required min="2020-01-01" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Способ возврата *</label>
          <select className="input" required value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
            <option value="">— выберите —</option>
            {dict?.pay_method?.map((s) => (
              <option key={s.id} value={s.label}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        {payMethod === 'Через терминал' && (
          <div>
            <label className="label">Терминал *</label>
            <select className="input" required value={terminal} onChange={(e) => setTerminal(e.target.value)}>
              <option value="">— выберите —</option>
              {dict?.terminal?.map((s) => (
                <option key={s.id} value={s.label}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="sm:col-span-2">
          <label className="label">Операция (если возврат по операции)</label>
          <OperationSelect patientId={patient.patientId ?? null} value={operationId} onChange={(v) => setOperationId((v as number | null) ?? null)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Причина возврата *</label>
          <textarea className="input min-h-[60px]" required value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      </div>

      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-danger" disabled={busy}>
          {busy ? 'Оформление…' : 'Оформить возврат'}
        </button>
      </div>
    </form>
  );
}
