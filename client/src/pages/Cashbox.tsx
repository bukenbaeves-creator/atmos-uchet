import { JournalPage } from '../components/JournalPage';
import { useDictionaries } from '../lib/dictionaries';
import { formatDate, formatMoney } from '../lib/format';
import type { Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface Payment {
  id: number;
  patient?: { fio: string };
  date: string | null;
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
  {
    name: 'operationCost',
    label: 'Стоимость операции (если операция новая)',
    type: 'money',
    showWhen: (v) => v.serviceType === 'Предоплата',
  },
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
  const columns: Column<Payment>[] = [
    { header: 'Пациент', cell: (p) => <span className="font-medium">{p.patient?.fio ?? '—'}</span> },
    { header: 'Дата', cell: (p) => formatDate(p.date) },
    { header: 'Услуга', cell: (p) => (p.opType ? `${p.serviceType ?? '—'} · ${p.opType}` : p.serviceType ?? '—') },
    { header: 'Сумма', align: 'right', cell: (p) => <span className="font-semibold">{formatMoney(p.amount)}</span> },
    { header: 'Способ', cell: (p) => p.payMethod ?? '—' },
    { header: 'Терминал', cell: (p) => p.terminal ?? '—' },
    {
      header: 'За операцию',
      cell: (p) => (p.operation ? `${p.operation.opType ?? 'операция'} · ${formatDate(p.operation.dateOp)}` : '—'),
    },
  ];

  return (
    <JournalPage<Payment>
      entity="payments"
      title="Касса"
      subtitle="Журнал платежей. Каждый способ оплаты — отдельная строка."
      columns={columns}
      fields={fields}
      exportJournal="payments"
      newButtonLabel="Платёж"
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
  );
}
