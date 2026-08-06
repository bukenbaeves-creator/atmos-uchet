import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPut, apiPatch } from '../api/client';
import { formatMoney, formatNumber, formatDate } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useDictionaries } from '../lib/dictionaries';
import { PageHeader, Spinner, Badge } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { MoneyInput } from '../components/MoneyInput';

// Локальная дата в YYYY-MM-DD (без сдвига через toISOString/UTC — иначе при UTC+5
// «1-е число месяца» уезжало на предыдущий день и пресеты работали неверно).
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type PresetKind = 'week' | 'month' | 'quarter' | 'year';
const PRESET_LABELS: Record<PresetKind, string> = { week: 'Неделя', month: 'Месяц', quarter: 'Квартал', year: 'Год' };

// Диапазон пресета: начало периода → сегодня. Чистая функция — по ней же
// определяем, какой пресет сейчас активен (сравнением с текущими from/to).
function presetRange(kind: PresetKind): { from: string; to: string } {
  const n = new Date();
  const to = iso(n);
  if (kind === 'week') return { from: iso(new Date(Date.now() - 6 * 86400000)), to };
  if (kind === 'month') return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to };
  if (kind === 'quarter') return { from: iso(new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1)), to };
  return { from: iso(new Date(n.getFullYear(), 0, 1)), to };
}

// Определяет пресет по диапазону (для стартовой подсветки). Порядок — от «крупного»
// к «мелкому»: в начале месяца «Неделя» и «Месяц» дают одинаковый диапазон, и по
// умолчанию логичнее подсветить «Месяц».
function detectPreset(from: string, to: string): PresetKind | null {
  const order: PresetKind[] = ['year', 'quarter', 'month', 'week'];
  return order.find((k) => presetRange(k).from === from && presetRange(k).to === to) ?? null;
}

// Общий переключатель периода для всей страницы KPI.
function PeriodControl({
  from,
  to,
  setFrom,
  setTo,
}: {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  // Активный пресет храним явно (нажатую кнопку), а не выводим из дат — иначе, когда
  // диапазоны совпадают (напр. в начале месяца «Неделя»==«Месяц»), клик по другой
  // кнопке визуально «ничего не делал».
  const [active, setActive] = useState<PresetKind | null>(() => detectPreset(from, to));
  const apply = (kind: PresetKind) => {
    const r = presetRange(kind);
    setFrom(r.from);
    setTo(r.to);
    setActive(kind);
  };

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex rounded-lg bg-slate-100 p-1">
        {(['week', 'month', 'quarter', 'year'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => apply(k)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              active === k ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-600 hover:text-slate-800'
            }`}
          >
            {PRESET_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <span>Период:</span>
        <div className="w-40">
          <input
            type="date"
            className="input w-full"
            value={from}
            max={to}
            onChange={(e) => {
              setFrom(e.target.value);
              setActive(null);
            }}
          />
        </div>
        <span className="text-slate-400">—</span>
        <div className="w-40">
          <input
            type="date"
            className="input w-full"
            value={to}
            min={from}
            max={iso(new Date())}
            onChange={(e) => {
              setTo(e.target.value);
              setActive(null);
            }}
          />
        </div>
      </div>
    </div>
  );
}

// Заголовок секции с тонким цветным акцентом
function SectionHeader({ title }: { title: string }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <span className="h-4 w-1 rounded bg-brand-500" />
      <h2 className="text-base font-semibold text-slate-700">{title}</h2>
    </div>
  );
}

// ================= Общая страница: качество сверху, вознаграждение снизу =================
export function Kpi() {
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));

  return (
    <div>
      <PageHeader title="KPI менеджеров" subtitle="Качество работы по итогам консультаций и вознаграждение по записям." />

      <PeriodControl from={from} to={to} setFrom={setFrom} setTo={setTo} />

      <SectionHeader title="Качество работы" />
      <QualityTab from={from} to={to} />

      <div className="my-8 border-t border-slate-200" />

      <SectionHeader title="Вознаграждение" />
      <RewardTab from={from} to={to} />
    </div>
  );
}

// ================= Вкладка «Вознаграждение» (денежный KPI) =================
interface Row {
  id: number;
  manager: string;
  consultationsOnline: number;
  consultationsOffline: number;
  operations: number;
  amount: number;
}
// Строки расшифровки (детализация того, что попало в расчёт)
interface ConsRow {
  id: number;
  manager: string | null;
  patientFio: string | null;
  dateKons: string | null;
  vid: string | null;
  interestOperation: string | null;
  doctor: string | null;
  stage: string | null;
  konsStatus: string | null;
  dateZapis: string | null;
  amount: number | null;
}
interface OpRow {
  id: number;
  manager: string | null;
  patientFio: string | null;
  dateOp: string | null;
  opType: string | null;
  surgeon: string | null;
  cost: number | null;
}
interface ExclRow {
  id: number;
  manager: string | null;
  patientFio: string | null;
  dateKons: string | null;
  interestOperation: string | null;
  doctor: string | null;
  dateZapis: string | null;
}
interface NotAttendedRow {
  id: number;
  manager: string | null;
  patientFio: string | null;
  dateKons: string | null;
  doctor: string | null;
  konsStatus: string | null;
}
interface PendingRow {
  id: number;
  manager: string | null;
  patientFio: string | null;
  dateKons: string | null;
  vid: string | null;
  doctor: string | null;
  comment: string | null;
  approved: boolean;
}
interface OpUnpaidRow extends OpRow {
  paid: number | null;
  balance: number | null;
}
interface Report {
  label: string;
  rates: { consultationOnline: number; consultationOffline: number; operation: number };
  rows: Omit<Row, 'id'>[];
  totals: { consultationsOnline: number; consultationsOffline: number; operations: number; amount: number };
  consultations: ConsRow[];
  operations: OpRow[];
  excludedConsultations: ExclRow[];
  excludedNoStageCount: number;
  notAttended: NotAttendedRow[];
  pendingApproval: PendingRow[];
  operationsUnpaid: OpUnpaidRow[];
}

// Ячейка «Комментарий» для согласования — редактируется менеджером (оператор+админ)
function CommentCell({ row }: { row: PendingRow }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(row.comment ?? '');
  const save = useMutation({
    mutationFn: (comment: string) => apiPatch(`/kpi/consultations/${row.id}/comment`, { comment }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kpi-report'] }),
  });
  const dirty = value.trim() !== (row.comment ?? '').trim();
  return (
    <div className="flex items-center gap-1">
      <input
        className="input h-8 w-56 text-xs"
        placeholder="комментарий менеджера…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {dirty && (
        <button className="btn-ghost px-2 py-1 text-xs" disabled={save.isPending} onClick={() => save.mutate(value.trim())}>
          {save.isPending ? '…' : 'Сохранить'}
        </button>
      )}
    </div>
  );
}

// Ячейка «Согласование» — кнопка «Согласовать» (только админ)
function ApproveCell({ row, isAdmin }: { row: PendingRow; isAdmin: boolean }) {
  const qc = useQueryClient();
  const approve = useMutation({
    mutationFn: () => apiPatch(`/kpi/consultations/${row.id}/approve`, { approved: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kpi-report'] }),
  });
  if (row.approved) return <Badge tone="green">согласовано</Badge>;
  if (!isAdmin) return <span className="text-xs text-slate-400">на согласовании</span>;
  return (
    <button className="btn-primary px-3 py-1 text-xs" disabled={approve.isPending} onClick={() => approve.mutate()}>
      {approve.isPending ? '…' : 'Согласовать'}
    </button>
  );
}

function RewardTab({ from, to }: { from: string; to: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['kpi-report', from, to],
    queryFn: () => apiGet<Report>(`/kpi/report?from=${from}&to=${to}`),
  });

  const [editRates, setEditRates] = useState<{ consultationOnline: string; consultationOffline: string; operation: string } | null>(null);
  const saveRates = useMutation({
    mutationFn: (r: { consultationOnline: number; consultationOffline: number; operation: number }) => apiPut('/kpi/rates', r),
    onSuccess: () => {
      setEditRates(null);
      qc.invalidateQueries({ queryKey: ['kpi-report'] });
    },
  });

  // Клиентский фильтр расшифровки по менеджеру (списки могут быть длинными)
  const [managerFilter, setManagerFilter] = useState('');

  const rows: Row[] = (data?.rows ?? []).map((r, i) => ({ ...r, id: i + 1 }));
  const columns: Column<Row>[] = [
    { header: 'Менеджер', cell: (r) => <span className="font-medium">{r.manager}</span> },
    { header: 'Консультации онлайн', align: 'right', cell: (r) => formatNumber(r.consultationsOnline) },
    { header: 'Консультации офлайн', align: 'right', cell: (r) => formatNumber(r.consultationsOffline) },
    { header: 'Операции', align: 'right', cell: (r) => formatNumber(r.operations) },
    {
      header: 'Вознаграждение (KPI)',
      align: 'right',
      cell: (r) => <span className="font-semibold text-emerald-600">{formatMoney(r.amount)}</span>,
    },
  ];

  // Список менеджеров, встречающихся в расшифровке, — для фильтра
  const managers = Array.from(
    new Set(
      [
        ...(data?.consultations ?? []),
        ...(data?.operations ?? []),
        ...(data?.excludedConsultations ?? []),
        ...(data?.notAttended ?? []),
        ...(data?.pendingApproval ?? []),
        ...(data?.operationsUnpaid ?? []),
      ]
        .map((r) => r.manager)
        .filter((m): m is string => !!m),
    ),
  ).sort((a, b) => a.localeCompare(b, 'ru'));
  const byMgr = <T extends { manager: string | null }>(list: T[]) =>
    managerFilter ? list.filter((r) => r.manager === managerFilter) : list;

  const consList = byMgr(data?.consultations ?? []);
  const opsList = byMgr(data?.operations ?? []);
  const exclList = byMgr(data?.excludedConsultations ?? []);
  const notAttendedList = byMgr(data?.notAttended ?? []);
  const pendingList = byMgr(data?.pendingApproval ?? []);
  const opsUnpaidList = byMgr(data?.operationsUnpaid ?? []);

  const consColumns: Column<ConsRow>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patientFio ?? '—'}</span> },
    { header: 'Дата консультации', cell: (r) => formatDate(r.dateKons) },
    { header: 'Вид', cell: (r) => r.vid ?? '—' },
    { header: 'Вид операции', cell: (r) => r.interestOperation ?? '—' },
    { header: 'Врач', cell: (r) => r.doctor ?? '—' },
    { header: 'Итог', cell: (r) => (r.stage ? <Badge tone="blue">{r.stage}</Badge> : '—') },
    { header: 'Дата записи', cell: (r) => formatDate(r.dateZapis) },
    { header: 'Оплата', align: 'right', cell: (r) => (r.amount ? formatMoney(r.amount) : <Badge tone="green">согласовано</Badge>) },
    { header: 'Менеджер', cell: (r) => r.manager ?? '—' },
  ];
  const opsColumns: Column<OpRow>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patientFio ?? '—'}</span> },
    { header: 'Дата операции', cell: (r) => formatDate(r.dateOp) },
    { header: 'Вид операции', cell: (r) => r.opType ?? '—' },
    { header: 'Хирург', cell: (r) => r.surgeon ?? '—' },
    { header: 'Стоимость', align: 'right', cell: (r) => formatMoney(r.cost ?? 0) },
    { header: 'Менеджер', cell: (r) => r.manager ?? '—' },
  ];
  const exclColumns: Column<ExclRow>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patientFio ?? '—'}</span> },
    { header: 'Дата консультации', cell: (r) => formatDate(r.dateKons) },
    { header: 'Вид операции', cell: (r) => r.interestOperation ?? '—' },
    { header: 'Врач', cell: (r) => r.doctor ?? '—' },
    { header: 'Дата записи', cell: (r) => formatDate(r.dateZapis) },
    { header: 'Менеджер', cell: (r) => r.manager ?? '—' },
  ];
  const notAttendedColumns: Column<NotAttendedRow>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patientFio ?? '—'}</span> },
    { header: 'Дата консультации', cell: (r) => formatDate(r.dateKons) },
    { header: 'Врач', cell: (r) => r.doctor ?? '—' },
    { header: 'Статус', cell: (r) => r.konsStatus ?? <span className="text-slate-400">не указан</span> },
    { header: 'Менеджер', cell: (r) => r.manager ?? '—' },
  ];
  const pendingColumns: Column<PendingRow>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patientFio ?? '—'}</span> },
    { header: 'Дата консультации', cell: (r) => formatDate(r.dateKons) },
    { header: 'Вид', cell: (r) => r.vid ?? '—' },
    { header: 'Врач', cell: (r) => r.doctor ?? '—' },
    { header: 'Менеджер', cell: (r) => r.manager ?? '—' },
    { header: 'Комментарий менеджера', cell: (r) => <CommentCell row={r} /> },
    { header: 'Согласование', align: 'center', cell: (r) => <ApproveCell row={r} isAdmin={isAdmin} /> },
  ];
  const opsUnpaidColumns: Column<OpUnpaidRow>[] = [
    { header: 'Пациент', cell: (r) => <span className="font-medium">{r.patientFio ?? '—'}</span> },
    { header: 'Дата операции', cell: (r) => formatDate(r.dateOp) },
    { header: 'Вид операции', cell: (r) => r.opType ?? '—' },
    { header: 'Хирург', cell: (r) => r.surgeon ?? '—' },
    { header: 'Стоимость', align: 'right', cell: (r) => formatMoney(r.cost ?? 0) },
    { header: 'Оплачено', align: 'right', cell: (r) => formatMoney(r.paid ?? 0) },
    { header: 'Остаток', align: 'right', cell: (r) => <span className="text-rose-600">{formatMoney(r.balance ?? 0)}</span> },
    { header: 'Менеджер', cell: (r) => r.manager ?? '—' },
  ];

  return (
    <div>
      <div className="card mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="font-semibold text-slate-700">Ставки KPI</span>
            <span className="ml-3 text-slate-500">
              консультация онлайн: <b>{formatMoney(data?.rates.consultationOnline ?? 0)}</b> · консультация офлайн:{' '}
              <b>{formatMoney(data?.rates.consultationOffline ?? 0)}</b> · операция: <b>{formatMoney(data?.rates.operation ?? 0)}</b>
            </span>
          </div>
          {isAdmin && !editRates && (
            <button
              className="btn-ghost"
              onClick={() =>
                setEditRates({
                  consultationOnline: String(data?.rates.consultationOnline ?? 0),
                  consultationOffline: String(data?.rates.consultationOffline ?? 0),
                  operation: String(data?.rates.operation ?? 0),
                })
              }
            >
              Изменить ставки
            </button>
          )}
        </div>
        {editRates && (
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
            <div>
              <label className="label">Консультация онлайн</label>
              <div className="w-40">
                <MoneyInput value={editRates.consultationOnline} onChange={(v) => setEditRates((s) => ({ ...s!, consultationOnline: v }))} />
              </div>
            </div>
            <div>
              <label className="label">Консультация офлайн</label>
              <div className="w-40">
                <MoneyInput value={editRates.consultationOffline} onChange={(v) => setEditRates((s) => ({ ...s!, consultationOffline: v }))} />
              </div>
            </div>
            <div>
              <label className="label">За операцию</label>
              <div className="w-40">
                <MoneyInput value={editRates.operation} onChange={(v) => setEditRates((s) => ({ ...s!, operation: v }))} />
              </div>
            </div>
            <button
              className="btn-primary"
              disabled={saveRates.isPending}
              onClick={() =>
                saveRates.mutate({
                  consultationOnline: Number(editRates.consultationOnline || 0),
                  consultationOffline: Number(editRates.consultationOffline || 0),
                  operation: Number(editRates.operation || 0),
                })
              }
            >
              Сохранить
            </button>
            <button className="btn-ghost" onClick={() => setEditRates(null)}>
              Отмена
            </button>
          </div>
        )}
      </div>

      {isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Период</div>
              <div className="mt-1 text-xl font-bold">{data.label}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Консультаций (онлайн/офлайн)</div>
              <div className="mt-1 text-xl font-bold">
                {formatNumber(data.totals.consultationsOnline + data.totals.consultationsOffline)}
                <span className="ml-2 text-sm font-normal text-slate-400">
                  {formatNumber(data.totals.consultationsOnline)} / {formatNumber(data.totals.consultationsOffline)}
                </span>
              </div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Операций</div>
              <div className="mt-1 text-xl font-bold">{formatNumber(data.totals.operations)}</div>
            </div>
            <div className="card">
              <div className="text-xs uppercase text-slate-400">Итого KPI</div>
              <div className="mt-1 text-xl font-bold text-emerald-600">{formatMoney(data.totals.amount)}</div>
            </div>
          </div>
          {data.excludedNoStageCount > 0 && (
            <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              ⚠ <b>{data.excludedNoStageCount}</b>{' '}
              {plural(data.excludedNoStageCount, 'заявка', 'заявки', 'заявок')} без итога не{' '}
              {plural(data.excludedNoStageCount, 'попала', 'попали', 'попали')} в расчёт вознаграждения. Заполните
              итог консультации, чтобы {plural(data.excludedNoStageCount, 'она учлась', 'они учлись', 'они учлись')}.
            </div>
          )}
          {data.pendingApproval.length > 0 && (
            <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              ⏳ <b>{data.pendingApproval.length}</b>{' '}
              {plural(data.pendingApproval.length, 'консультация', 'консультации', 'консультаций')} без оплаты{' '}
              {plural(data.pendingApproval.length, 'ждёт', 'ждут', 'ждут')} согласования (см. блок «Без оплаты — на
              согласовании» ниже).
            </div>
          )}
          {rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">Нет записей за выбранный период</div>
          ) : (
            <Table columns={columns} rows={rows} />
          )}

          {/* Расшифровка расчёта */}
          <div className="mt-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold uppercase tracking-wide text-slate-500">Расшифровка расчёта</div>
              {managers.length > 1 && (
                <select className="input w-56" value={managerFilter} onChange={(e) => setManagerFilter(e.target.value)}>
                  <option value="">Все менеджеры</option>
                  {managers.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="mb-2 text-sm font-semibold text-slate-700">
              Консультации в расчёте <span className="text-slate-400">({consList.length})</span>
            </div>
            {consList.length === 0 ? (
              <div className="mb-6 py-6 text-center text-sm text-slate-400">Нет консультаций</div>
            ) : (
              <div className="mb-6">
                <Table columns={consColumns} rows={consList} />
              </div>
            )}

            <div className="mb-2 text-sm font-semibold text-slate-700">
              Операции в расчёте <span className="text-slate-400">({opsList.length})</span>
            </div>
            {opsList.length === 0 ? (
              <div className="mb-6 py-6 text-center text-sm text-slate-400">Нет операций</div>
            ) : (
              <div className="mb-6">
                <Table columns={opsColumns} rows={opsList} />
              </div>
            )}

            {pendingList.length > 0 && (
              <div className="mb-6">
                <div className="mb-2 text-sm font-semibold text-amber-700">
                  Без оплаты — на согласовании <span className="text-amber-500">({pendingList.length})</span>
                </div>
                <div className="mb-2 text-xs text-slate-500">
                  Консультация состоялась и есть итог, но нет оплаты. Менеджер добавляет комментарий, админ согласовывает —
                  после этого она попадает в расчёт.
                </div>
                <Table columns={pendingColumns} rows={pendingList} />
              </div>
            )}

            {exclList.length > 0 && (
              <div className="mb-6">
                <div className="mb-2 text-sm font-semibold text-amber-700">
                  Заявки без итога — не в расчёте <span className="text-amber-500">({exclList.length})</span>
                </div>
                <Table columns={exclColumns} rows={exclList} />
              </div>
            )}

            {notAttendedList.length > 0 && (
              <div className="mb-6">
                <div className="mb-2 text-sm font-semibold text-slate-600">
                  Не прошли консультацию — не в расчёте <span className="text-slate-400">({notAttendedList.length})</span>
                </div>
                <Table columns={notAttendedColumns} rows={notAttendedList} />
              </div>
            )}

            {opsUnpaidList.length > 0 && (
              <div className="mb-6">
                <div className="mb-2 text-sm font-semibold text-slate-600">
                  Операции без 100% оплаты — не в расчёте <span className="text-slate-400">({opsUnpaidList.length})</span>
                </div>
                <Table columns={opsUnpaidColumns} rows={opsUnpaidList} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Русская форма множественного числа: (1 заявка, 2 заявки, 5 заявок)
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// ================= Вкладка «Качество» (мини-дашборд) =================
interface Target {
  green: number;
  yellow: number;
}
interface QSettings {
  timelinessHours: number;
  minResultLen: number;
  templateDays: number;
  conversionDays: number;
  targets: { quality: Target; timeliness: Target; conversion: Target };
}
interface QRow {
  id: number;
  manager: string;
  consultations: number;
  assessable: number;
  noHistory: number;
  timelyPct: number | null;
  qualityPct: number | null;
  conversionPct: number;
}
interface QReport {
  from: string;
  to: string;
  settings: QSettings;
  rows: Omit<QRow, 'id'>[];
  totals: { consultations: number; assessable: number; noHistory: number; timelyPct: number | null; qualityPct: number | null; conversionPct: number };
  pendingConversion: number;
}

const fmtPct = (v: number | null) => (v == null ? '—' : `${v}%`);
const tone = (v: number | null, t: Target) =>
  v == null ? 'text-slate-400' : v >= t.green ? 'text-emerald-600' : v >= t.yellow ? 'text-amber-600' : 'text-rose-600';

function QualityTab({ from, to }: { from: string; to: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { data: dict } = useDictionaries();
  const [manager, setManager] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['kpi-quality', from, to, manager],
    queryFn: () => apiGet<QReport>(`/kpi/quality?from=${from}&to=${to}${manager ? `&manager=${encodeURIComponent(manager)}` : ''}`),
  });

  const rows: QRow[] = (data?.rows ?? []).map((r, i) => ({ ...r, id: i + 1 }));
  const t = data?.settings.targets;

  const columns: Column<QRow>[] = [
    { header: 'Менеджер', cell: (r) => <span className="font-medium">{r.manager}</span> },
    { header: 'Консультаций', align: 'right', cell: (r) => r.consultations },
    {
      header: 'Качество',
      align: 'right',
      cell: (r) => <span className={`font-semibold ${tone(r.qualityPct, t!.quality)}`}>{fmtPct(r.qualityPct)}</span>,
    },
    {
      header: 'Своевременность',
      align: 'right',
      cell: (r) => <span className={`font-semibold ${tone(r.timelyPct, t!.timeliness)}`}>{fmtPct(r.timelyPct)}</span>,
    },
    {
      header: 'Конверсия',
      align: 'right',
      cell: (r) => <span className={`font-semibold ${tone(r.conversionPct, t!.conversion)}`}>{fmtPct(r.conversionPct)}</span>,
    },
    {
      header: 'Без истории',
      align: 'right',
      cell: (r) => (r.noHistory ? <span className="text-slate-400">{r.noHistory}</span> : '—'),
    },
  ];

  return (
    <div>
      {/* Фильтр по менеджеру (период — общий, вверху страницы) */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-500">Менеджер</span>
        <select className="input w-56" value={manager} onChange={(e) => setManager(e.target.value)}>
          <option value="">Все</option>
          {dict?.manager?.map((m) => (
            <option key={m.id} value={m.label}>
              {m.label}
            </option>
          ))}
        </select>
        {isAdmin && (
          <button className="btn-ghost ml-auto" onClick={() => setShowSettings((v) => !v)}>
            ⚙️ Настройки
          </button>
        )}
      </div>

      {isAdmin && showSettings && <SettingsPanel settings={data?.settings} onSaved={() => qc.invalidateQueries({ queryKey: ['kpi-quality'] })} />}

      {isLoading || !data || !t ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <QualityTile label="Качественные итоги" value={fmtPct(data.totals.qualityPct)} target={t.quality} pct={data.totals.qualityPct} />
            <QualityTile label="Своевременность" value={fmtPct(data.totals.timelyPct)} target={t.timeliness} pct={data.totals.timelyPct} />
            <QualityTile label="Конверсия в операцию" value={fmtPct(data.totals.conversionPct)} target={t.conversion} pct={data.totals.conversionPct} />
          </div>

          {/* Пояснения по данным */}
          {(data.totals.noHistory > 0 || data.pendingConversion > 0) && (
            <div className="mb-3 space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-200">
              {data.totals.noHistory > 0 && (
                <div>
                  • {data.totals.noHistory} консультаций без истории аудита — не учтены в качестве и своевременности (итог заносился до
                  внедрения журнала или импортом).
                </div>
              )}
              {data.pendingConversion > 0 && (
                <div>
                  • По {data.pendingConversion} консультациям окно конверсии ({data.settings.conversionDays} дн.) ещё не закрыто — показатель
                  может вырасти.
                </div>
              )}
            </div>
          )}

          {rows.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">Нет состоявшихся консультаций за выбранный период</div>
          ) : (
            <Table columns={columns} rows={rows} />
          )}
        </>
      )}
    </div>
  );
}

function QualityTile({ label, value, target, pct }: { label: string; value: string; target: Target; pct: number | null }) {
  return (
    <div className="card">
      <div className="text-xs uppercase text-slate-400">{label}</div>
      <div className={`mt-1 text-3xl font-bold ${tone(pct, target)}`}>{value}</div>
      <div className="text-xs text-slate-400">
        цель ≥ {target.green}% · норма ≥ {target.yellow}%
      </div>
    </div>
  );
}

// Панель настроек дашборда (только админ)
function SettingsPanel({ settings, onSaved }: { settings?: QSettings; onSaved: () => void }) {
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const cur = form ?? (settings ? flatten(settings) : null);

  const save = useMutation({
    mutationFn: (body: Record<string, number>) => apiPut('/kpi/settings', body),
    onSuccess: () => {
      setForm(null);
      onSaved();
    },
  });

  if (!cur) return null;
  const set = (k: string, v: string) => setForm({ ...cur, [k]: v });
  const num = (k: string) => (
    <input type="number" min={0} className="input" value={cur[k]} onChange={(e) => set(k, e.target.value)} />
  );

  return (
    <div className="card mb-4">
      <div className="mb-3 text-sm font-semibold text-slate-700">Настройки дашборда качества</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label">Срок итога, часов</label>
          {num('kpi_timeliness_hours')}
        </div>
        <div>
          <label className="label">Мин. длина итога</label>
          {num('kpi_min_result_len')}
        </div>
        <div>
          <label className="label">Окно шаблонности, дн.</label>
          {num('kpi_template_days')}
        </div>
        <div>
          <label className="label">Окно конверсии, дн.</label>
          {num('kpi_conversion_days')}
        </div>
        <div>
          <label className="label">Качество: зелёный / жёлтый %</label>
          <div className="flex gap-2">
            {num('kpi_target_quality_green')}
            {num('kpi_target_quality_yellow')}
          </div>
        </div>
        <div>
          <label className="label">Своевременность: зел. / жёлт. %</label>
          <div className="flex gap-2">
            {num('kpi_target_timeliness_green')}
            {num('kpi_target_timeliness_yellow')}
          </div>
        </div>
        <div>
          <label className="label">Конверсия: зел. / жёлт. %</label>
          <div className="flex gap-2">
            {num('kpi_target_conversion_green')}
            {num('kpi_target_conversion_yellow')}
          </div>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="btn-primary"
          disabled={save.isPending}
          onClick={() => save.mutate(Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, Number(v)])))}
        >
          Сохранить настройки
        </button>
        {form && (
          <button className="btn-ghost" onClick={() => setForm(null)}>
            Сбросить
          </button>
        )}
      </div>
    </div>
  );
}

function flatten(s: QSettings): Record<string, string> {
  return {
    kpi_timeliness_hours: String(s.timelinessHours),
    kpi_min_result_len: String(s.minResultLen),
    kpi_template_days: String(s.templateDays),
    kpi_conversion_days: String(s.conversionDays),
    kpi_target_quality_green: String(s.targets.quality.green),
    kpi_target_quality_yellow: String(s.targets.quality.yellow),
    kpi_target_timeliness_green: String(s.targets.timeliness.green),
    kpi_target_timeliness_yellow: String(s.targets.timeliness.yellow),
    kpi_target_conversion_green: String(s.targets.conversion.green),
    kpi_target_conversion_yellow: String(s.targets.conversion.yellow),
  };
}
