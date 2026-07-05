import { JournalPage } from '../components/JournalPage';
import { formatDate, formatMoney } from '../lib/format';
import { Badge } from '../components/ui';
import type { Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface Operation {
  id: number;
  patient?: { fio: string };
  dateOp: string | null;
  opType: string | null;
  surgeon: string | null;
  manager: string | null;
  cost: number;
  totalDue: number;
  paid: number;
  balance: number;
  fullyPaid: boolean;
  contractSigned: boolean;
  createdBy?: number | null;
  createdAt?: string;
}

const fields: Field[] = [
  { name: 'patient', label: 'Пациент', type: 'patientBlock', required: true, span: 2 },
  { name: 'manager', label: 'Менеджер (кто записал)', type: 'select', dict: 'manager', required: true },
  { name: 'dateOp', label: 'Дата операции', type: 'date', required: true },
  { name: 'opType', label: 'Тип операции', type: 'select', dict: 'op_type', required: true },
  { name: 'surgeon', label: 'Хирург', type: 'select', dict: 'surgeon', required: true },
  { name: 'anesthesiologist', label: 'Анестезиолог', type: 'text' },
  { name: 'cost', label: 'Стоимость операции', type: 'money', required: true },
  { name: 'anesthesiaCost', label: 'Стоимость наркоза', type: 'money' },
  { name: 'zapis', label: 'Запись', type: 'select', dict: 'zapis', required: true },
  { name: 'contractSigned', label: 'Договор подписан', type: 'checkbox' },
  { name: 'note', label: 'Примечание', type: 'textarea', span: 2 },
];

export function Operations() {
  const columns: Column<Operation>[] = [
    { header: 'Пациент', cell: (o) => <span className="font-medium">{o.patient?.fio ?? '—'}</span> },
    { header: 'Дата', cell: (o) => formatDate(o.dateOp) },
    { header: 'Тип', cell: (o) => o.opType ?? '—' },
    { header: 'Менеджер', cell: (o) => o.manager ?? '—' },
    { header: 'Хирург', cell: (o) => o.surgeon ?? '—' },
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

  return (
    <JournalPage<Operation>
      entity="operations"
      title="Операции"
      subtitle="Стоимость, оплата и остаток рассчитываются автоматически."
      columns={columns}
      fields={fields}
      exportJournal="operations"
      newButtonLabel="Операцию"
    />
  );
}
