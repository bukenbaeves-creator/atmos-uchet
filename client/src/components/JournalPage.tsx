import { useState, type ReactNode } from 'react';
import dayjs from 'dayjs';
import { useList, useCrudMutations } from '../api/hooks';
import { useAuth } from '../lib/auth';
import { exportUrl } from '../api/client';
import { EntityForm, type Field } from './EntityForm';
import { Table, type Column } from './Table';
import { Modal, PageHeader, Pagination, Spinner, EmptyState } from './ui';

export interface JournalRecord {
  id: number;
  createdBy?: number | null;
  createdAt?: string;
}

interface Props<T extends JournalRecord> {
  entity: string;
  title: string;
  subtitle?: string;
  columns: Column<T>[];
  fields: Field[];
  exportJournal?: string;
  extraParams?: Record<string, unknown>;
  renderFilters?: (params: Record<string, unknown>, setParam: (k: string, v: unknown) => void) => ReactNode;
  onRowClick?: (row: T) => void;
  newButtonLabel?: string;
  // Дополнительные кнопки в колонке действий (например, «Итог» у консультаций)
  rowActions?: (row: T) => ReactNode;
}

export function canEditRow(row: JournalRecord, user: { id: number; role: string } | null): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (row.createdBy !== user.id) return false;
  return row.createdAt ? dayjs(row.createdAt).isSame(dayjs(), 'day') : false;
}

export function JournalPage<T extends JournalRecord>({
  entity,
  title,
  subtitle,
  columns,
  fields,
  exportJournal,
  extraParams,
  renderFilters,
  onRowClick,
  newButtonLabel = 'Добавить',
  rowActions,
}: Props<T>) {
  const { user, isAdmin } = useAuth();
  const [params, setParams] = useState<Record<string, unknown>>({ page: 1, search: '' });
  const setParam = (k: string, v: unknown) => setParams((s) => ({ ...s, [k]: v, ...(k !== 'page' ? { page: 1 } : {}) }));

  const query = { ...params, ...(extraParams ?? {}) };
  const { data, isLoading, isError } = useList<T>(entity, query);
  const { create, update, remove, restore } = useCrudMutations(entity);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (row: T) => {
    setEditing(row);
    setModalOpen(true);
  };

  const actionsColumn: Column<T> = {
    header: '',
    align: 'right',
    cell: (row) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {rowActions?.(row)}
        {canEditRow(row, user) && (
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => openEdit(row)}>
            Изменить
          </button>
        )}
        {isAdmin && (
          <button
            className="btn-danger px-2 py-1 text-xs"
            onClick={() => {
              if (confirm('Удалить запись? Её можно восстановить в аудите.')) remove.mutate(row.id);
            }}
          >
            Удалить
          </button>
        )}
      </div>
    ),
  };

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {exportJournal && (
              <a className="btn-ghost" href={exportUrl(exportJournal)}>
                Экспорт в Excel
              </a>
            )}
            <button className="btn-primary" onClick={openCreate}>
              + {newButtonLabel}
            </button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder="Поиск…"
          value={(params.search as string) ?? ''}
          onChange={(e) => setParam('search', e.target.value)}
        />
        {renderFilters?.(params, setParam)}
      </div>

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>
      ) : !data || data.items.length === 0 ? (
        <EmptyState>Записей не найдено</EmptyState>
      ) : (
        <>
          <Table columns={[...columns, actionsColumn]} rows={data.items} onRowClick={onRowClick} />
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={(p) => setParam('page', p)}
          />
        </>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        wide
        title={editing ? `Редактирование · ${title}` : `Новая запись · ${title}`}
      >
        <EntityForm
          fields={fields}
          initial={editing ?? undefined}
          onSubmit={(payload) =>
            editing ? update.mutateAsync({ id: editing.id, data: payload }) : create.mutateAsync(payload)
          }
          onDone={() => setModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
