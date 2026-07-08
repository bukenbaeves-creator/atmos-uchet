import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, exportUrl } from '../api/client';
import { formatDate, formatMoney } from '../lib/format';
import { PageHeader, Spinner, Badge, EmptyState } from '../components/ui';
import { Table, type Column } from '../components/Table';

interface Row {
  id: number;
  patient?: { fio: string };
  dateOp: string | null;
  opType: string | null;
  surgeon: string | null;
  totalDue: number;
  prepaid: number;
  paid: number;
  balance: number;
  fullyPaid: boolean;
  contractSigned: boolean;
}

interface Data {
  rows: Row[];
  totals: { totalDue: number; prepaid: number; paid: number; balance: number };
}

const FILTERS = [
  { key: '', label: 'Все' },
  { key: 'balance', label: 'Есть остаток' },
  { key: 'noContract', label: 'Договор не подписан' },
  { key: 'fullyPaid', label: 'Оплачено 100%' },
];

export function Prepayments() {
  const [filter, setFilter] = useState('');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['prepayments', filter],
    queryFn: () => apiGet<Data>(`/reports/prepayments${filter ? `?filter=${filter}` : ''}`),
  });

  const columns: Column<Row>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patient?.fio ?? '—'}</span> },
    { header: 'Дата', cell: (r) => formatDate(r.dateOp) },
    { header: 'Операция', cell: (r) => r.opType ?? '—' },
    { header: 'Врач', cell: (r) => r.surgeon ?? '—' },
    { header: 'К оплате', align: 'right', cell: (r) => formatMoney(r.totalDue) },
    { header: 'Аванс', align: 'right', cell: (r) => <span className="text-brand-600">{formatMoney(r.prepaid)}</span> },
    { header: 'Оплачено', align: 'right', cell: (r) => formatMoney(r.paid) },
    {
      header: 'Остаток',
      align: 'right',
      cell: (r) => <span className={r.balance > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}>{formatMoney(r.balance)}</span>,
    },
    { header: 'Договор', align: 'center', cell: (r) => (r.contractSigned ? '✓' : '—') },
    {
      header: 'Статус',
      cell: (r) => (r.fullyPaid ? <Badge tone="green">100%</Badge> : <Badge tone="amber">остаток</Badge>),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Предоплаты и остатки"
        subtitle="Все показатели вычисляются автоматически из операций и платежей."
        actions={
          <a className="btn-ghost" href={exportUrl('operations')}>
            Экспорт в Excel
          </a>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Итого к оплате</div>
              <div className="mt-1 text-xl font-bold">{formatMoney(data.totals.totalDue)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Итого аванс</div>
              <div className="mt-1 text-xl font-bold text-brand-600">{formatMoney(data.totals.prepaid)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Итого оплачено</div>
              <div className="mt-1 text-xl font-bold text-emerald-600">{formatMoney(data.totals.paid)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Итого остаток</div>
              <div className="mt-1 text-xl font-bold text-rose-600">{formatMoney(data.totals.balance)}</div>
            </div>
          </div>
          <Table columns={columns} rows={data.rows} />
        </>
      )}
    </div>
  );
}
