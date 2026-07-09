import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, expenseExportUrl } from '../api/client';
import { formatDate, isExpired } from '../lib/format';
import { PageHeader, Spinner, EmptyState, Badge } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { useAuth } from '../lib/auth';

interface StockRow {
  id: number;
  name: string;
  type: string;
  unitWriteoff: string | null;
  minStock: number;
  stock: number;
  belowMin: boolean;
  deficit: number;
  nearestExpiry: string | null;
  hasExpired: boolean;
  expiringSoon: boolean;
  totalCost?: number; // только администратору
}

type Filter = 'all' | 'purchase' | 'expiry';

export function Stock() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [filter, setFilter] = useState<Filter>('all');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['stock'],
    queryFn: () => apiGet<{ items: StockRow[] }>('/stock'),
  });

  const rows = (data?.items ?? []).filter((r) =>
    filter === 'purchase' ? r.belowMin : filter === 'expiry' ? r.hasExpired || r.expiringSoon : true,
  );

  const columns: Column<StockRow>[] = [
    { header: 'Позиция', cell: (r) => <span className="font-medium">{r.name}</span> },
    { header: 'Тип', cell: (r) => (r.type === 'drug' ? 'Препарат' : 'Расходник') },
    {
      header: 'Остаток',
      align: 'right',
      cell: (r) => (
        <span className={r.belowMin ? 'font-semibold text-rose-600' : ''}>
          {r.stock}
          {r.unitWriteoff ? ' ' + r.unitWriteoff : ''}
        </span>
      ),
    },
    { header: 'Минимум', align: 'right', cell: (r) => r.minStock || '—' },
    ...(filter === 'purchase'
      ? [{ header: 'Нужно докупить', align: 'right' as const, cell: (r: StockRow) => <span className="font-semibold text-amber-700">{r.deficit}</span> }]
      : []),
    {
      header: 'Ближайший срок',
      cell: (r) =>
        !r.nearestExpiry ? (
          <span className="text-slate-400">бессрочный</span>
        ) : isExpired(r.nearestExpiry) ? (
          <span className="font-semibold text-rose-600">{formatDate(r.nearestExpiry)}</span>
        ) : r.expiringSoon ? (
          <span className="font-semibold text-amber-700">{formatDate(r.nearestExpiry)}</span>
        ) : (
          formatDate(r.nearestExpiry)
        ),
    },
    {
      header: 'Статус',
      cell: (r) =>
        r.hasExpired ? (
          <Badge tone="red">просрочено</Badge>
        ) : r.expiringSoon ? (
          <Badge tone="amber">скоро истекает</Badge>
        ) : r.belowMin ? (
          <Badge tone="amber">ниже минимума</Badge>
        ) : (
          <Badge tone="green">достаточно</Badge>
        ),
    },
    ...(isAdmin
      ? [{ header: 'Стоимость остатка', align: 'right' as const, cell: (r: StockRow) => (r.totalCost != null ? r.totalCost.toLocaleString('ru-RU') : '—') }]
      : []),
  ];

  // Файл выгрузки под текущий фильтр
  const exportReport = filter === 'purchase' ? 'purchase-list' : filter === 'expiry' ? 'expiry' : 'stock';

  return (
    <div>
      <PageHeader
        title="Склад · остатки"
        subtitle="Остаток по каждой позиции. Стоимость остатка видит только администратор."
        actions={
          <a className="btn-ghost" href={expenseExportUrl(exportReport)}>
            Экспорт в Excel
          </a>
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <button className={filter === 'all' ? 'btn-primary' : 'btn-ghost'} onClick={() => setFilter('all')}>
          Все
        </button>
        <button className={filter === 'purchase' ? 'btn-primary' : 'btn-ghost'} onClick={() => setFilter('purchase')}>
          К закупу{data ? ` (${data.items.filter((r) => r.belowMin).length})` : ''}
        </button>
        <button className={filter === 'expiry' ? 'btn-primary' : 'btn-ghost'} onClick={() => setFilter('expiry')}>
          Сроки{data ? ` (${data.items.filter((r) => r.hasExpired || r.expiringSoon).length})` : ''}
        </button>
      </div>

      {isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState>
          {filter === 'purchase'
            ? 'Позиций к закупу нет — остатки выше минимума.'
            : filter === 'expiry'
              ? 'Проблем со сроками годности нет.'
              : 'Склад пуст. Оприходуйте материалы во вкладке «Приход».'}
        </EmptyState>
      ) : (
        <Table columns={columns} rows={rows} />
      )}
    </div>
  );
}
