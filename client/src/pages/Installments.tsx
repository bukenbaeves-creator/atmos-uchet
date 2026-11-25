import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError, apiGet, apiPut, installmentScheduleUrl } from '../api/client';
import { useCrudMutations, type ListResponse } from '../api/hooks';
import { useAuth } from '../lib/auth';
import { formatDate, formatMoney, plural, toInputDate } from '../lib/format';
import { emptyInstallment, installmentPayload, previewSchedule, type InstallmentValue } from '../lib/installment';
import { Badge, EmptyState, Modal, PageHeader, Spinner } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { ExportButton } from '../components/ExportButton';
import { InstallmentFields } from '../components/InstallmentFields';
import { PatientField } from '../components/PatientField';
import { canEditRow } from '../components/JournalPage';

interface ItemState {
  seq: number;
  dueDate: string;
  amount: number;
  paidAmount: number;
  status: 'paid' | 'partial' | 'unpaid';
  paidDate: string | null;
  overdue: boolean;
  daysLeft: number;
}

interface Plan {
  id: number;
  operationId: number;
  patientId: number;
  contractNumber: string;
  contractDate: string;
  totalCost: number;
  downPayment: number;
  months: number;
  firstPaymentDate: string;
  monthlyPayment: number;
  costChanged: boolean;
  currentCost: number;
  patient: { id: number; fio: string; phone: string };
  operation: { id: number; dateOp: string | null; opType: string | null; surgeon: string | null; manager: string | null } | null;
  state: {
    total: number;
    paid: number;
    balance: number;
    closed: boolean;
    items: ItemState[];
    nextDue: { seq: number; dueDate: string; amount: number; daysLeft: number } | null;
    overdueCount: number;
    overdueAmount: number;
  };
  createdBy?: number | null;
  createdAt?: string;
}

interface Reminder {
  planId: number;
  patientId: number;
  patientFio: string;
  patientPhone: string;
  manager: string | null;
  opType: string | null;
  contractNumber: string;
  seq: number;
  dueDate: string;
  amount: number;
  daysLeft: number;
}

interface Reminders {
  overdue: Reminder[];
  today: Reminder[];
  soon: Reminder[];
}

interface OperationOption {
  id: number;
  dateOp: string | null;
  opType: string | null;
  totalDue: number;
  paid: number;
  balance: number;
}

const FILTERS = [
  { key: 'active', label: 'Действующие' },
  { key: 'overdue', label: 'С просрочкой' },
  { key: 'closed', label: 'Погашенные' },
  { key: 'all', label: 'Все' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const matches = (p: Plan, f: FilterKey) =>
  f === 'all' ? true : f === 'closed' ? p.state.closed : f === 'overdue' ? p.state.overdueCount > 0 : !p.state.closed;

const seqLabel = (seq: number) => (seq === 0 ? 'первоначальный взнос' : `платёж № ${seq}`);

// Блок напоминаний одного вида (просрочено / сегодня / скоро).
function ReminderBlock({
  title,
  tone,
  rows,
  onOpen,
  when,
}: {
  title: string;
  tone: 'red' | 'amber' | 'blue';
  rows: Reminder[];
  onOpen: (planId: number) => void;
  when: (r: Reminder) => string;
}) {
  if (rows.length === 0) return null;
  const tones = {
    red: 'bg-rose-50 ring-rose-200 text-rose-900',
    amber: 'bg-amber-50 ring-amber-200 text-amber-900',
    blue: 'bg-brand-50 ring-brand-200 text-brand-900',
  };
  return (
    <div className={`rounded-xl p-3 ring-1 ${tones[tone]}`}>
      <div className="mb-2 text-sm font-semibold">
        {title} · {rows.length}
      </div>
      <ul className="divide-y divide-black/5">
        {rows.map((r) => (
          <li key={`${r.planId}-${r.seq}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5 text-sm">
            <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => onOpen(r.planId)}>
              {r.patientFio}
            </button>
            <a href={`tel:${r.patientPhone.replace(/[^\d+]/g, '')}`} className="tabular-nums hover:underline">
              {r.patientPhone}
            </a>
            <span className="tabular-nums font-semibold">{formatMoney(r.amount)}</span>
            <span>
              {seqLabel(r.seq)} · до {formatDate(r.dueDate)} · {when(r)}
            </span>
            <span className="opacity-70">менеджер: {r.manager ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Форма оформления / правки рассрочки для существующей операции.
function PlanForm({ editing, onDone }: { editing: Plan | null; onDone: () => void }) {
  const { create, update } = useCrudMutations('installments');
  const [patientId, setPatientId] = useState<number | null>(editing?.patientId ?? null);
  const [operationId, setOperationId] = useState<number | null>(editing?.operationId ?? null);
  const [value, setValue] = useState<InstallmentValue>(
    editing
      ? {
          downPayment: String(editing.downPayment),
          months: editing.months,
          contractDate: toInputDate(editing.contractDate),
          firstPaymentDate: toInputDate(editing.firstPaymentDate),
          contractNumber: editing.contractNumber,
        }
      : emptyInstallment(),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: ops } = useQuery({
    queryKey: ['operations', 'for-patient', patientId],
    queryFn: () => apiGet<ListResponse<OperationOption>>(`/operations?patientId=${patientId}&pageSize=100`),
    enabled: !!patientId && !editing,
  });
  const op = ops?.items.find((o) => o.id === operationId);
  // При правке стоимость берётся с операции заново (сервер пересохраняет снимок).
  const totalCost = editing ? editing.currentCost : (op?.totalDue ?? 0);
  const preview = previewSchedule(totalCost, value);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!operationId) return setError('Выберите пациента и операцию');
    if (preview.error) return setError(preview.error);
    setBusy(true);
    setError(null);
    try {
      const data = { operationId, ...installmentPayload(value) };
      if (editing) await update.mutateAsync({ id: editing.id, data });
      else await create.mutateAsync(data);
      onDone();
    } catch (err) {
      const details = err instanceof ApiError ? err.details?.map((d) => d.message).join('; ') : '';
      setError(details || (err instanceof Error ? err.message : 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {editing ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {editing.patient.fio} · {editing.operation?.opType ?? 'операция'} · {formatDate(editing.operation?.dateOp)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Пациент *</label>
            <PatientField
              value={patientId}
              onChange={(v) => {
                setPatientId(v);
                setOperationId(null);
              }}
            />
          </div>
          <div>
            <label className="label">Операция *</label>
            <select
              className="input"
              disabled={!patientId}
              value={operationId ?? ''}
              onChange={(e) => setOperationId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{patientId ? '— выберите операцию —' : 'сначала выберите пациента'}</option>
              {ops?.items.map((o) => (
                <option key={o.id} value={o.id}>
                  {formatDate(o.dateOp)} · {o.opType ?? 'операция'} · стоимость {formatMoney(o.totalDue)} · оплачено {formatMoney(o.paid)}
                </option>
              ))}
            </select>
            {patientId && ops && ops.items.length === 0 && (
              <div className="mt-1 text-xs text-amber-600">У пациента нет операций. Сначала заведите операцию в журнале «Операции».</div>
            )}
          </div>
        </div>
      )}

      <InstallmentFields totalCost={totalCost} value={value} onChange={setValue} />

      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Сохранение…' : editing ? 'Сохранить' : 'Оформить рассрочку'}
        </button>
      </div>
    </form>
  );
}

// Реквизиты для печатной формы графика (только администратор).
function SettingsForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['installments', 'settings'],
    queryFn: () => apiGet<{ clinicName: string; signatory: string }>('/installments/settings'),
  });
  const [form, setForm] = useState<{ clinicName: string; signatory: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = form ?? data ?? { clinicName: '', signatory: '' };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await apiPut('/installments/settings', v);
      await qc.invalidateQueries({ queryKey: ['installments', 'settings'] });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить');
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-slate-500">Эти данные подставляются в подписи графика платежей при выгрузке в Excel.</p>
      <div>
        <label className="label">Клиника (юридическое лицо)</label>
        <input className="input" value={v.clinicName} onChange={(e) => setForm({ ...v, clinicName: e.target.value })} />
      </div>
      <div>
        <label className="label">Подписант от клиники</label>
        <input className="input" value={v.signatory} onChange={(e) => setForm({ ...v, signatory: e.target.value })} />
      </div>
      {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary">
          Сохранить
        </button>
      </div>
    </form>
  );
}

function itemBadge(i: ItemState): ReactNode {
  if (i.status === 'paid') return <Badge tone="green">оплачено{i.paidDate ? ` ${formatDate(i.paidDate)}` : ''}</Badge>;
  if (i.overdue) return <Badge tone="red">просрочено · {-i.daysLeft} дн.</Badge>;
  if (i.status === 'partial') return <Badge tone="amber">внесено {formatMoney(i.paidAmount)}</Badge>;
  if (i.daysLeft === 0) return <Badge tone="amber">сегодня</Badge>;
  if (i.daysLeft <= 2) return <Badge tone="blue">через {i.daysLeft} дн.</Badge>;
  return <Badge tone="slate">ожидается</Badge>;
}

function planBadge(p: Plan): ReactNode {
  if (p.state.closed) return <Badge tone="green">погашена</Badge>;
  if (p.state.overdueCount > 0) return <Badge tone="red">просрочка</Badge>;
  return <Badge tone="blue">действует</Badge>;
}

export function Installments() {
  const { user, isAdmin } = useAuth();
  const { remove } = useCrudMutations('installments');
  const [filter, setFilter] = useState<FilterKey>('active');
  const [openId, setOpenId] = useState<number | null>(null);
  const [form, setForm] = useState<{ editing: Plan | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['installments', 'list'],
    queryFn: () => apiGet<ListResponse<Plan>>('/installments?pageSize=500'),
    refetchInterval: 60_000,
  });
  const { data: reminders } = useQuery({
    queryKey: ['installments', 'reminders'],
    queryFn: () => apiGet<Reminders>('/installments/reminders'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const plans = data?.items ?? [];
  const rows = plans.filter((p) => matches(p, filter));
  const opened = plans.find((p) => p.id === openId) ?? null;
  const active = plans.filter((p) => !p.state.closed);
  const totals = {
    count: active.length,
    total: active.reduce((s, p) => s + p.state.total, 0),
    paid: active.reduce((s, p) => s + Math.min(p.state.paid, p.state.total), 0),
    balance: active.reduce((s, p) => s + p.state.balance, 0),
    overdue: active.reduce((s, p) => s + p.state.overdueAmount, 0),
  };

  const columns: Column<Plan>[] = [
    {
      header: 'Договор',
      cell: (p) => (
        <div>
          <div className="font-medium">{p.contractNumber}</div>
          <div className="text-xs text-slate-400">от {formatDate(p.contractDate)}</div>
        </div>
      ),
    },
    {
      header: 'Пациент',
      cell: (p) => (
        <div>
          <div className="font-medium">{p.patient.fio}</div>
          <div className="text-xs text-slate-400">{p.patient.phone}</div>
        </div>
      ),
    },
    {
      header: 'Операция',
      cell: (p) => (
        <div>
          <div>{p.operation?.opType ?? '—'}</div>
          <div className="text-xs text-slate-400">{formatDate(p.operation?.dateOp)}</div>
        </div>
      ),
    },
    { header: 'Менеджер', cell: (p) => p.operation?.manager ?? '—' },
    { header: 'Стоимость', align: 'right', cell: (p) => formatMoney(p.totalCost) },
    { header: 'Взнос', align: 'right', cell: (p) => formatMoney(p.downPayment) },
    { header: 'Срок', align: 'center', cell: (p) => `${p.months} мес.` },
    { header: 'Платёж в месяц', align: 'right', cell: (p) => formatMoney(p.monthlyPayment) },
    { header: 'Оплачено', align: 'right', cell: (p) => formatMoney(p.state.paid) },
    {
      header: 'Остаток',
      align: 'right',
      cell: (p) => <span className={p.state.balance > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}>{formatMoney(p.state.balance)}</span>,
    },
    {
      header: 'Ближайший платёж',
      cell: (p) =>
        p.state.nextDue ? (
          <div className={p.state.nextDue.daysLeft < 0 ? 'text-rose-600' : ''}>
            <div className="tabular-nums">{formatDate(p.state.nextDue.dueDate)}</div>
            <div className="text-xs opacity-70">{formatMoney(p.state.nextDue.amount)}</div>
          </div>
        ) : (
          '—'
        ),
    },
    { header: 'Статус', cell: planBadge },
  ];

  const onDelete = async (p: Plan) => {
    if (!confirm(`Удалить рассрочку ${p.contractNumber} (${p.patient.fio})? Платежи в Кассе останутся, график исчезнет.`)) return;
    await remove.mutateAsync(p.id);
    setOpenId(null);
  };

  const remindersTotal = (reminders?.overdue.length ?? 0) + (reminders?.today.length ?? 0) + (reminders?.soon.length ?? 0);

  return (
    <div>
      <PageHeader
        title="Рассрочка"
        subtitle="Беспроцентная рассрочка клиники: графики платежей и напоминания. Оплаты вносятся в Кассе и сами закрывают строки графика."
        actions={
          <>
            {isAdmin && (
              <button className="btn-ghost" onClick={() => setSettingsOpen(true)}>
                Реквизиты
              </button>
            )}
            <button className="btn-primary" onClick={() => setForm({ editing: null })}>
              + Оформить рассрочку
            </button>
          </>
        }
      />

      {/* Напоминания менеджерам: кому позвонить */}
      <div className="mb-4 space-y-2">
        <ReminderBlock
          title="Просрочено — платёж не внесён"
          tone="red"
          rows={reminders?.overdue ?? []}
          onOpen={setOpenId}
          when={(r) => `просрочка ${-r.daysLeft} ${plural(-r.daysLeft, 'день', 'дня', 'дней')}`}
        />
        <ReminderBlock title="Платёж сегодня" tone="amber" rows={reminders?.today ?? []} onOpen={setOpenId} when={() => 'сегодня'} />
        <ReminderBlock
          title="Платёж в ближайшие 2 дня — напомнить пациенту"
          tone="blue"
          rows={reminders?.soon ?? []}
          onOpen={setOpenId}
          when={(r) => (r.daysLeft === 1 ? 'завтра' : `через ${r.daysLeft} ${plural(r.daysLeft, 'день', 'дня', 'дней')}`)}
        />
        {reminders && remindersTotal === 0 && (
          <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
            Напоминаний нет: ближайших и просроченных платежей по рассрочке нет.
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? 'btn-primary' : 'btn-ghost'} onClick={() => setFilter(f.key)}>
            {f.label} ({plans.filter((p) => matches(p, f.key)).length})
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
              <div className="text-xs uppercase text-slate-400">Действующих рассрочек</div>
              <div className="mt-1 text-xl font-bold">{totals.count}</div>
              <div className="text-xs text-slate-400">на сумму {formatMoney(totals.total)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Оплачено</div>
              <div className="mt-1 text-xl font-bold text-emerald-600">{formatMoney(totals.paid)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Остаток к получению</div>
              <div className="mt-1 text-xl font-bold text-brand-600">{formatMoney(totals.balance)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Просрочено</div>
              <div className={`mt-1 text-xl font-bold ${totals.overdue > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{formatMoney(totals.overdue)}</div>
            </div>
          </div>
          {rows.length === 0 ? (
            <EmptyState>{plans.length === 0 ? 'Рассрочек пока нет. Нажмите «Оформить рассрочку».' : 'Нет рассрочек с таким статусом.'}</EmptyState>
          ) : (
            <Table columns={columns} rows={rows} onRowClick={(p) => setOpenId(p.id)} rowClassName={(p) => (p.state.overdueCount > 0 ? 'bg-rose-50/40' : '')} />
          )}
        </>
      )}

      {/* Карточка рассрочки: параметры и график с отметками об оплате */}
      <Modal open={!!opened} onClose={() => setOpenId(null)} title={opened ? `Рассрочка ${opened.contractNumber} от ${formatDate(opened.contractDate)}` : ''} wide>
        {opened && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Link to={`/patients/${opened.patientId}`} className="text-base font-semibold text-brand-700 hover:underline">
                  {opened.patient.fio}
                </Link>
                <div className="text-sm text-slate-500">
                  {opened.patient.phone} · {opened.operation?.opType ?? 'операция'} · {formatDate(opened.operation?.dateOp)} · менеджер:{' '}
                  {opened.operation?.manager ?? '—'}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <ExportButton
                  url={installmentScheduleUrl(opened.id)}
                  filename={`График платежей ${opened.contractNumber} ${opened.patient.fio}.xlsx`}
                  label="Скачать график (Excel)"
                  className="btn-primary"
                />
                {canEditRow(opened, user) && (
                  <button className="btn-ghost" onClick={() => setForm({ editing: opened })}>
                    Изменить
                  </button>
                )}
                {isAdmin && (
                  <button className="btn-danger" onClick={() => onDelete(opened)}>
                    Удалить
                  </button>
                )}
              </div>
            </div>

            {opened.costChanged && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
                Стоимость операции изменилась после оформления: в графике {formatMoney(opened.totalCost)}, сейчас {formatMoney(opened.currentCost)}.
                Откройте «Изменить» и сохраните — график пересчитается.
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {(
                [
                  ['Стоимость услуг', formatMoney(opened.totalCost)],
                  ['Первоначальный взнос', formatMoney(opened.downPayment)],
                  ['Сумма рассрочки', formatMoney(opened.totalCost - opened.downPayment)],
                  ['Срок', `${opened.months} мес.`],
                  ['Платёж в месяц', formatMoney(opened.monthlyPayment)],
                  ['Остаток', formatMoney(opened.state.balance)],
                ] as const
              ).map(([label, val]) => (
                <div key={label}>
                  <div className="label">{label}</div>
                  <div className="text-sm font-semibold tabular-nums">{val}</div>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-center">№</th>
                    <th className="px-3 py-2 text-left">Дата платежа (не позднее)</th>
                    <th className="px-3 py-2 text-right">Сумма платежа</th>
                    <th className="px-3 py-2 text-right">Остаток после платежа</th>
                    <th className="px-3 py-2 text-left">Отметка об оплате</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {opened.state.items.map((i, idx, arr) => {
                    const rest = opened.state.total - arr.slice(0, idx + 1).reduce((s, x) => s + x.amount, 0);
                    return (
                      <tr key={i.seq} className={i.overdue ? 'bg-rose-50/50' : ''}>
                        <td className="px-3 py-1.5 text-center text-slate-500">{i.seq}</td>
                        <td className="px-3 py-1.5">
                          {formatDate(i.dueDate)}
                          {i.seq === 0 && <span className="ml-2 text-xs italic text-slate-400">первоначальный взнос</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatMoney(i.amount)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{formatMoney(rest)}</td>
                        <td className="px-3 py-1.5">{itemBadge(i)}</td>
                      </tr>
                    );
                  })}
                  <tr className="bg-slate-50 font-semibold">
                    <td />
                    <td className="px-3 py-2">ИТОГО</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(opened.state.total)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">0</td>
                    <td className="px-3 py-2 text-xs font-normal text-slate-500">оплачено {formatMoney(opened.state.paid)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-400">
              Отметки ставятся автоматически по платежам этой операции в Кассе: оплаченное закрывает строки графика по порядку.
            </p>
          </div>
        )}
      </Modal>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.editing ? `Изменить рассрочку ${form.editing.contractNumber}` : 'Оформить рассрочку'} wide>
        {form && <PlanForm editing={form.editing} onDone={() => setForm(null)} />}
      </Modal>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Реквизиты для графика платежей">
        <SettingsForm onDone={() => setSettingsOpen(false)} />
      </Modal>
    </div>
  );
}
