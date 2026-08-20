import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { PageHeader, Spinner, EmptyState } from '../../components/ui';
import { DataTable, type DataTableColumn } from '../../components/DataTable';

// Реестр по врачу (Э4-1/Э4-2): операции с развёрнутыми компонентами. Колонки строятся
// динамически по ответу API (набор компонентов определяется схемой врача).

interface RegCol { code: string; label: string; stage: string }
interface RegRow {
  accrualId: number;
  operationId: number;
  dateOp: string | null;
  opType: string | null;
  patient: string | null;
  base: number;
  sharePct: number;
  isCorrection: boolean;
  components: Record<string, number>;
  amount: number;
}
interface Registry {
  payeeId: number;
  payeeFio: string | null;
  columns: RegCol[];
  rows: RegRow[];
  totals: { amount: number; perComponent: Record<string, number> };
}

export function Registry() {
  const { id, payeeId } = useParams();
  const nav = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['payout-registry', id, payeeId],
    queryFn: () => apiGet<Registry>(`/payouts/sheets/${id}/registry?payeeId=${payeeId}`),
  });

  if (isError) return <EmptyState>Не удалось загрузить реестр.</EmptyState>;
  if (isLoading || !data) return <Spinner />;

  const cols: DataTableColumn<RegRow>[] = [
    { id: 'date', header: 'Дата', accessor: (r) => r.dateOp, format: 'date', sticky: true, width: 100 },
    { id: 'patient', header: 'Пациент', accessor: (r) => r.patient ?? (r.isCorrection ? 'корректировка' : ''), sticky: true, width: 200 },
    { id: 'opType', header: 'Вид операции', accessor: (r) => r.opType },
    { id: 'base', header: 'База', accessor: (r) => r.base, align: 'right', format: 'money' },
    ...data.columns.map(
      (c): DataTableColumn<RegRow> => ({
        id: `c_${c.code}`,
        header: c.label,
        group: 'Вычеты и начисления',
        accessor: (r) => r.components[c.code] ?? 0,
        align: 'right',
        format: 'money',
      }),
    ),
    { id: 'share', header: 'Доля', accessor: (r) => `${Math.round(r.sharePct * 100)}%`, align: 'right' },
    { id: 'amount', header: 'Начислено', accessor: (r) => r.amount, align: 'right', format: 'money' },
  ];

  const totals: Record<string, number | string | null> = {
    amount: data.totals.amount,
    ...Object.fromEntries(data.columns.map((c) => [`c_${c.code}`, data.totals.perComponent[c.code]])),
  };

  return (
    <div>
      <PageHeader
        title={`Реестр · ${data.payeeFio ?? ''}`}
        subtitle="Операции врача с развёрнутыми компонентами расчёта. Набор колонок — по схеме врача."
        actions={<button className="btn-ghost" onClick={() => nav(`/payouts/sheets/${id}`)}>К ведомости</button>}
      />
      <DataTable columns={cols} rows={data.rows} totals={totals} rowAccent={(r) => (r.isCorrection ? '#f59e0b' : undefined)} />
    </div>
  );
}
