import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from '../api/client';
import { PageHeader, Spinner, EmptyState, Modal, Badge } from '../components/ui';
import { Table, type Column } from '../components/Table';
import { useDictionaries } from '../lib/dictionaries';

// Экран «Настройки выплат» — конструктор модуля выплат врачам (только администратор).
// Шесть вкладок: получатели, компоненты расчёта, ставки эквайринга, тарифы анестезии,
// нормативы материалов, схемы выплат. Все справочники append-only/версионные —
// см. соответствующие роуты /api/payouts/*.

const TABS = [
  { key: 'payees', label: 'Врачи' },
  { key: 'components', label: 'Компоненты' },
  { key: 'acquiring', label: 'Ставки эквайринга' },
  { key: 'anesthesia', label: 'Тарифы анестезии' },
  { key: 'norms', label: 'Нормативы материалов' },
  { key: 'schemes', label: 'Схемы' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const KIND_LABEL: Record<string, string> = { surgeon: 'Хирург', anesthesiologist: 'Анестезиолог', resident: 'Резидент', assistant: 'Ассистент' };
const LEGAL_LABEL: Record<string, string> = { individual: 'Физлицо', ip: 'ИП' };
const VALUE_SOURCE_LABEL: Record<string, string> = {
  fixed: 'фикс. сумма', pct_of_base: '% от базы', pct_of_payments: '% от оплат', operation_field: 'поле операции',
  warehouse_fact: 'факт склад', warehouse_or_norm: 'склад/норматив', table_by_source: 'табл. по источнику',
  table_by_op_type: 'табл. по виду', manual: 'вручную', per_day: 'за день',
};
const STAGE_LABEL: Record<string, string> = { before_share: 'до доли', after_share: 'после доли' };
const DIRECTION_LABEL: Record<string, string> = { deduction: 'вычет', addition: 'начисление' };
const SCHEME_KIND_LABEL: Record<string, string> = { share_based: 'доля от базы', tariff_based: 'тариф за операцию' };
const SHARE_MODE_LABEL: Record<string, string> = { constant: 'постоянная', by_source: 'по источнику оплаты', by_op_type: 'по виду операции' };

const fmtDate = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '—');
const fmtMoney = (v: number | string | null) => (v == null ? '—' : Number(v).toLocaleString('ru-RU'));

// Выпадающий список из существующего справочника (doctor/terminal/op_type/zapis) —
// чтобы не вводить значения вручную и не было расхождений с данными операций.
function DictSelect({ category, value, onChange, placeholder = '— выберите —', required }: { category: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  const { data } = useDictionaries();
  const options = data?.[category] ?? [];
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.label}>{o.label}</option>
      ))}
    </select>
  );
}

export function PayoutSettings() {
  const [tab, setTab] = useState<TabKey>('payees');
  return (
    <div>
      <PageHeader
        title="Настройки выплат"
        subtitle="Конструктор расчёта выплат врачам: получатели, компоненты, ставки, тарифы, нормативы и схемы."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'payees' && <PayeesTab />}
      {tab === 'components' && <ComponentsTab />}
      {tab === 'acquiring' && <AcquiringTab />}
      {tab === 'anesthesia' && <AnesthesiaTab />}
      {tab === 'norms' && <NormsTab />}
      {tab === 'schemes' && <SchemesTab />}
    </div>
  );
}

// Обёртка вокруг useQuery для списков конструктора (ответ вида { items: [...] }).
function useItems<T>(key: string, path: string) {
  return useQuery({ queryKey: [key], queryFn: () => apiGet<{ items: T[] }>(path) });
}

function TabShell({ isLoading, isError, empty, children }: { isLoading: boolean; isError: boolean; empty: boolean; children: React.ReactNode }) {
  if (isError) return <EmptyState>Не удалось загрузить данные. Обновите страницу или войдите заново.</EmptyState>;
  if (isLoading) return <Spinner />;
  if (empty) return <EmptyState>Записей пока нет.</EmptyState>;
  return <>{children}</>;
}

// ---------- Врачи (получатели) ----------
interface Payee { id: number; fio: string; dictionaryLabel: string | null; kind: string; legalForm: string; iin: string | null; bankAccount: string | null; active: boolean; }
function PayeesTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useItems<Payee>('payout-payees', '/payouts/payees');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ fio: '', kind: 'surgeon', dictionaryLabel: '', legalForm: 'individual', iin: '', bankAccount: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await apiPost('/payouts/payees', {
        fio: form.fio, kind: form.kind, legalForm: form.legalForm,
        dictionaryLabel: form.dictionaryLabel || null, iin: form.iin || null, bankAccount: form.bankAccount || null,
      });
      qc.invalidateQueries({ queryKey: ['payout-payees'] });
      setOpen(false); setForm({ fio: '', kind: 'surgeon', dictionaryLabel: '', legalForm: 'individual', iin: '', bankAccount: '' });
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Не удалось сохранить'); } finally { setBusy(false); }
  };
  const columns: Column<Payee>[] = [
    { header: 'ФИО', cell: (p) => <span className="font-medium">{p.fio}</span> },
    { header: 'Роль', cell: (p) => KIND_LABEL[p.kind] ?? p.kind },
    { header: 'Форма', cell: (p) => LEGAL_LABEL[p.legalForm] ?? p.legalForm },
    { header: 'Метка справочника', cell: (p) => p.dictionaryLabel ?? '—' },
    { header: 'Статус', cell: (p) => (p.active ? <Badge tone="green">активен</Badge> : <Badge tone="slate">скрыт</Badge>) },
  ];
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setOpen(true)}>+ Врач</button></div>
      <TabShell isLoading={isLoading} isError={isError} empty={!data || data.items.length === 0}>
        <Table columns={columns} rows={data?.items ?? []} />
      </TabShell>
      <Modal open={open} onClose={() => setOpen(false)} title="Новый получатель выплаты">
        <form onSubmit={submit} className="space-y-3">
          <div><label className="label">ФИО</label><input className="input" value={form.fio} onChange={(e) => setForm({ ...form, fio: e.target.value })} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Роль</label>
              <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div><label className="label">Форма</label>
              <select className="input" value={form.legalForm} onChange={(e) => setForm({ ...form, legalForm: e.target.value })}>
                {Object.entries(LEGAL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div><label className="label">Врач из справочника (значение поля «Врач» в операциях)</label>
            <DictSelect category="doctor" value={form.dictionaryLabel} onChange={(v) => setForm({ ...form, dictionaryLabel: v, fio: form.fio || v })} placeholder="— выберите врача —" />
            <p className="mt-1 text-xs text-slate-400">По этому значению начисления привяжутся к операциям автоматически.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">ИИН</label><input className="input" value={form.iin} onChange={(e) => setForm({ ...form, iin: e.target.value })} /></div>
            <div><label className="label">Счёт</label><input className="input" value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} /></div>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Отмена</button><button className="btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- Компоненты расчёта ----------
interface Comp { id: number; code: string; name: string; valueSource: string; direction: string; defaultStage: string; isSystem: boolean; isActive: boolean; _count?: { tableValues: number }; }
function ComponentsTab() {
  const { data, isLoading, isError } = useItems<Comp>('payout-components', '/payouts/components');
  const [tableFor, setTableFor] = useState<Comp | null>(null);
  const hasTable = (c: Comp) => c.valueSource === 'operation_field' || c.valueSource === 'table_by_op_type';
  const columns: Column<Comp>[] = [
    { header: 'Компонент', cell: (c) => <span className="font-medium">{c.name}</span> },
    { header: 'Код', cell: (c) => <code className="text-xs text-slate-500">{c.code}</code> },
    { header: 'Источник значения', cell: (c) => VALUE_SOURCE_LABEL[c.valueSource] ?? c.valueSource },
    { header: 'Направление', cell: (c) => DIRECTION_LABEL[c.direction] ?? c.direction },
    { header: 'Стадия', cell: (c) => STAGE_LABEL[c.defaultStage] ?? c.defaultStage },
    { header: 'Тип', cell: (c) => (c.isSystem ? <Badge tone="blue">системный</Badge> : <Badge tone="slate">свой</Badge>) },
    { header: 'Статус', cell: (c) => (c.isActive ? <Badge tone="green">активен</Badge> : <Badge tone="amber">выключен</Badge>) },
    {
      header: '',
      align: 'right',
      cell: (c) =>
        hasTable(c) ? (
          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setTableFor(c)}>Таблица по видам операций</button>
        ) : null,
    },
  ];
  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">
        Системные компоненты созданы автоматически. У наркоза, седации, имплантов и медсестры можно задать таблицу
        «вид операции → сумма» — она общая для всех врачей; в схеме врача выбирается режим «по таблице».
      </p>
      <TabShell isLoading={isLoading} isError={isError} empty={!data || data.items.length === 0}>
        <Table columns={columns} rows={data?.items ?? []} />
      </TabShell>
      <Modal open={tableFor != null} onClose={() => setTableFor(null)} title={`Таблица по видам операций · ${tableFor?.name ?? ''}`} wide>
        {tableFor && <ComponentTableEditor comp={tableFor} />}
      </Modal>
    </div>
  );
}

// Таблица «вид операции → сумма» компонента: общая для всех врачей, append-only
// (изменение = новая строка с новой датой). Вид операции не в таблице — вычета нет.
interface TableRow { id: number; key: string; value: number; validFrom: string }
function ComponentTableEditor({ comp }: { comp: Comp }) {
  const qc = useQueryClient();
  const key = ['payout-component-table', comp.id];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => apiGet<{ items: TableRow[] }>(`/payouts/components/${comp.id}/table`) });
  // Действующие схемы, где этот компонент включён НЕ в режиме «по таблице» — таблица к ним
  // не применяется, пока не создать новую версию схемы с режимом «по таблице».
  const schemesQ = useItems<Scheme>('payout-schemes', '/payouts/schemes');
  const payeesQ = useItems<Payee>('payout-payees', '/payouts/payees');
  const notUsingTable = (schemesQ.data?.items ?? [])
    .filter((s) => !s.validTo)
    .map((s) => ({ s, it: s.items.find((i) => i.componentId === comp.id && i.enabled) }))
    .filter((x) => x.it && x.it.filter?.mode !== 'table' && !(comp.valueSource === 'table_by_op_type' && !x.it.useOwnValue))
    .map((x) => ({
      scheme: x.s,
      fio: payeesQ.data?.items.find((p) => p.id === x.s.payeeId)?.fio ?? `#${x.s.payeeId}`,
      how: x.it!.useOwnValue && x.it!.value != null ? `фикс ${fmtMoney(Number(x.it!.value))}` : 'из карточки операции',
    }));
  const [form, setForm] = useState({ key: '', value: '', validFrom: '2020-01-01' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await apiPost(`/payouts/components/${comp.id}/table`, { key: form.key, value: Number(String(form.value).replace(/\s/g, '').replace(',', '.')), validFrom: form.validFrom });
      qc.invalidateQueries({ queryKey: key });
      setForm({ key: '', value: '', validFrom: '2020-01-01' });
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Не удалось сохранить'); } finally { setBusy(false); }
  };
  // Показываем действующие значения (последняя дата по каждому виду операции).
  const items = data?.items ?? [];
  const latest = new Map<string, TableRow>();
  for (const r of items) if (!latest.has(r.key)) latest.set(r.key, r);
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Сумма вычета по виду операции. Виды, которых нет в таблице, вычета не дают (напр. блефаропластика без наркоза).</p>
      {notUsingTable.length > 0 ? (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div className="font-medium">Таблица пока НЕ применяется к этим схемам — у «{comp.name}» там другой режим:</div>
          <ul className="mt-1 list-inside list-disc">
            {notUsingTable.map((x) => (
              <li key={x.scheme.id}>{x.fio} — схема «{x.scheme.name}» ({x.how})</li>
            ))}
          </ul>
          <div className="mt-1 text-xs">Создайте новую версию схемы («Схемы → + Схема») и выберите у «{comp.name}» режим «по таблице видов операций» — старая версия закроется автоматически. Затем «↻ Пересчитать выплаты».</div>
        </div>
      ) : (
        schemesQ.data && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Все действующие схемы с этим компонентом используют таблицу.</div>
      )}
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2"><label className="label">Вид операции</label><DictSelect category="op_type" value={form.key} onChange={(v) => setForm({ ...form, key: v })} required /></div>
        <div><label className="label">Сумма, ₸</label><input className="input" placeholder="напр. 250000" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required /></div>
        <div><label className="label">Действует с</label><input type="date" className="input" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} required /></div>
        {err && <p className="text-sm text-red-600 sm:col-span-4">{err}</p>}
        <div className="flex justify-end sm:col-span-4"><button className="btn-primary" disabled={busy}>{busy ? 'Сохранение…' : '+ Добавить / обновить'}</button></div>
      </form>
      {isLoading ? <Spinner /> : latest.size === 0 ? (
        <EmptyState>Таблица пуста — вычет по этому компоненту пока нигде не применяется.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                <th className="px-3 py-2 text-left">Вид операции</th>
                <th className="w-36 px-3 py-2 text-right">Сумма, ₸</th>
                <th className="w-36 px-3 py-2 text-center">Действует с</th>
              </tr>
            </thead>
            <tbody>
              {[...latest.values()].map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-1.5 font-medium">{r.key}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(r.value)}</td>
                  <td className="px-3 py-1.5 text-center">{fmtDate(r.validFrom)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------- Ставки эквайринга (append-only) ----------
interface Acq { id: number; terminal: string; ratePct: number; validFrom: string; note: string | null; }
function AcquiringTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useItems<Acq>('payout-acquiring', '/payouts/rates/acquiring');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ terminal: '', ratePct: '', validFrom: '2020-01-01', note: '' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await apiPost('/payouts/rates/acquiring', { terminal: form.terminal, ratePct: Number(form.ratePct), validFrom: form.validFrom, note: form.note || null });
      qc.invalidateQueries({ queryKey: ['payout-acquiring'] });
      setOpen(false); setForm({ terminal: '', ratePct: '', validFrom: '2020-01-01', note: '' });
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Не удалось сохранить'); } finally { setBusy(false); }
  };
  const columns: Column<Acq>[] = [
    { header: 'Терминал', cell: (r) => <span className="font-medium">{r.terminal}</span> },
    { header: 'Ставка, %', align: 'right', cell: (r) => Number(r.ratePct).toLocaleString('ru-RU') },
    { header: 'Действует с', cell: (r) => fmtDate(r.validFrom) },
    { header: 'Примечание', cell: (r) => r.note ?? '—' },
  ];
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setOpen(true)}>+ Ставка</button></div>
      <p className="mb-3 text-sm text-slate-500">
        Ставки применяются к платежам со способом «Через терминал» — по терминалу платежа. Наличные, «на счёт» и рассрочка
        комиссией не облагаются. Изменение ставки — новая запись с новой датой; старые сохраняются для прошлых расчётов.
        Если в схеме врача у «Комиссии банка» вписан свой %, он заменяет эти ставки для этого врача.
      </p>
      <TabShell isLoading={isLoading} isError={isError} empty={!data || data.items.length === 0}>
        <Table columns={columns} rows={data?.items ?? []} />
      </TabShell>
      <Modal open={open} onClose={() => setOpen(false)} title="Новая ставка эквайринга">
        <form onSubmit={submit} className="space-y-3">
          <div><label className="label">Терминал</label><DictSelect category="terminal" value={form.terminal} onChange={(v) => setForm({ ...form, terminal: v })} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Ставка, %</label>
              <input type="number" step="any" min={0} max={100} className="input" placeholder="напр. 1.5" value={form.ratePct} onChange={(e) => setForm({ ...form, ratePct: e.target.value })} required />
              <p className="mt-1 text-xs text-slate-400">Только число, без знака %. Примеры: 1 — это 1%; 1.5 — это 1,5%; 2.3 — это 2,3%.</p>
            </div>
            <div><label className="label">Действует с</label><input type="date" className="input" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} required /></div>
          </div>
          <div><label className="label">Примечание</label><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Отмена</button><button className="btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- Тарифы анестезии (append-only) ----------
interface Tar { id: number; anesthesiaType: string; minCount: number; maxCount: number | null; amount: number; validFrom: string; }
function AnesthesiaTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useItems<Tar>('payout-anesthesia', '/payouts/tariffs/anesthesia');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ anesthesiaType: '', minCount: '1', maxCount: '', amount: '', validFrom: '2020-01-01' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await apiPost('/payouts/tariffs/anesthesia', {
        anesthesiaType: form.anesthesiaType, minCount: Number(form.minCount),
        maxCount: form.maxCount ? Number(form.maxCount) : null, amount: Number(form.amount), validFrom: form.validFrom,
      });
      qc.invalidateQueries({ queryKey: ['payout-anesthesia'] });
      setOpen(false); setForm({ anesthesiaType: '', minCount: '1', maxCount: '', amount: '', validFrom: '2020-01-01' });
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Не удалось сохранить'); } finally { setBusy(false); }
  };
  const columns: Column<Tar>[] = [
    { header: 'Тип наркоза', cell: (r) => <span className="font-medium">{r.anesthesiaType}</span> },
    { header: 'Кол-во от', align: 'right', cell: (r) => r.minCount },
    { header: 'до', align: 'right', cell: (r) => r.maxCount ?? '∞' },
    { header: 'Сумма', align: 'right', cell: (r) => fmtMoney(r.amount) },
    { header: 'Действует с', cell: (r) => fmtDate(r.validFrom) },
  ];
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setOpen(true)}>+ Тариф</button></div>
      <TabShell isLoading={isLoading} isError={isError} empty={!data || data.items.length === 0}>
        <Table columns={columns} rows={data?.items ?? []} />
      </TabShell>
      <Modal open={open} onClose={() => setOpen(false)} title="Новый тариф анестезии">
        <form onSubmit={submit} className="space-y-3">
          <div><label className="label">Тип наркоза</label><input className="input" value={form.anesthesiaType} onChange={(e) => setForm({ ...form, anesthesiaType: e.target.value })} required /></div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="label">Кол-во от</label><input type="number" min={1} className="input" value={form.minCount} onChange={(e) => setForm({ ...form, minCount: e.target.value })} required /></div>
            <div><label className="label">до (пусто = ∞)</label><input type="number" min={1} className="input" value={form.maxCount} onChange={(e) => setForm({ ...form, maxCount: e.target.value })} /></div>
            <div><label className="label">Сумма</label><input type="number" step="any" min={0} className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></div>
          </div>
          <div><label className="label">Действует с</label><input type="date" className="input" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} required /></div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Отмена</button><button className="btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- Нормативы материалов (append-only) ----------
interface Norm { id: number; opType: string; amount: number; validFrom: string; }
function NormsTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useItems<Norm>('payout-norms', '/payouts/norms');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ opType: '', amount: '', validFrom: '2020-01-01' });
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await apiPost('/payouts/norms', { opType: form.opType, amount: Number(form.amount), validFrom: form.validFrom });
      qc.invalidateQueries({ queryKey: ['payout-norms'] });
      setOpen(false); setForm({ opType: '', amount: '', validFrom: '2020-01-01' });
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Не удалось сохранить'); } finally { setBusy(false); }
  };
  const columns: Column<Norm>[] = [
    { header: 'Вид операции', cell: (r) => <span className="font-medium">{r.opType}</span> },
    { header: 'Норматив', align: 'right', cell: (r) => fmtMoney(r.amount) },
    { header: 'Действует с', cell: (r) => fmtDate(r.validFrom) },
  ];
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => setOpen(true)}>+ Норматив</button></div>
      <TabShell isLoading={isLoading} isError={isError} empty={!data || data.items.length === 0}>
        <Table columns={columns} rows={data?.items ?? []} />
      </TabShell>
      <Modal open={open} onClose={() => setOpen(false)} title="Новый норматив материалов">
        <form onSubmit={submit} className="space-y-3">
          <div><label className="label">Вид операции</label><DictSelect category="op_type" value={form.opType} onChange={(v) => setForm({ ...form, opType: v })} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Норматив, сумма</label><input type="number" step="any" min={0} className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></div>
            <div><label className="label">Действует с</label><input type="date" className="input" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} required /></div>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Отмена</button><button className="btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- Схемы выплат (версионные) ----------
interface SchemeItem { componentId: number; enabled: boolean; stage: string; useOwnValue: boolean; value: number | null; filter?: { mode?: string } | null }
interface SchemeShare { key: string; share: number }
interface Scheme { id: number; payeeId: number; name: string; kind: string; shareMode: string; shareValue: number | null; withholdIpPct?: number; note?: string | null; version: number; validFrom: string; validTo: string | null; items: SchemeItem[]; shareValues: SchemeShare[]; }
function SchemesTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useItems<Scheme>('payout-schemes', '/payouts/schemes');
  const payees = useItems<Payee>('payout-payees', '/payouts/payees');
  const comps = useItems<Comp>('payout-components', '/payouts/components');
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<Scheme | null>(null); // просмотр параметров сохранённой схемы
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ payeeId: '', name: '', kind: 'share_based', shareMode: 'constant', shareValue: '', validFrom: '2020-01-01', note: '' });
  const [shareRows, setShareRows] = useState<{ key: string; share: string }[]>([{ key: '', share: '' }]);
  const [picked, setPicked] = useState<Record<number, { stage: string; value: string; mode: 'card' | 'fixed' | 'table' }>>({});

  const payeeName = (id: number) => payees.data?.items.find((p) => p.id === id)?.fio ?? `#${id}`;
  const reset = () => {
    setForm({ payeeId: '', name: '', kind: 'share_based', shareMode: 'constant', shareValue: '', validFrom: '2020-01-01', note: '' });
    setShareRows([{ key: '', share: '' }]); setPicked({});
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    // Устойчивый разбор чисел: «1%», «1,5», «0,6» → 1 / 1.5 / 0.6. Раньше «1%» молча
    // превращался в null — комиссия и налог считались нулём.
    const parseNum = (raw: string): number | null => {
      const s = String(raw ?? '').replace(/[%\s]/g, '').replace(',', '.');
      if (s === '') return null;
      return Number(s);
    };
    const items: { componentId: number; stage: string; useOwnValue: boolean; value: number | null; filter?: { mode: string } | null }[] = [];
    for (const [componentId, v] of Object.entries(picked)) {
      const comp = comps.data?.items.find((c) => c.id === Number(componentId));
      const tableCapable = comp?.valueSource === 'operation_field' || comp?.valueSource === 'table_by_op_type';
      const val = v.mode === 'fixed' || !tableCapable ? parseNum(v.value) : null;
      if (val !== null && Number.isNaN(val)) {
        setErr(`Значение компонента «${comp?.name ?? componentId}»: «${v.value}» не число. Введите число, например 1.5 (проценты — без знака %).`);
        return;
      }
      if (tableCapable && v.mode === 'fixed' && val === null) {
        setErr(`Компонент «${comp?.name ?? componentId}»: выбран режим «фикс сумма», но сумма не указана.`);
        return;
      }
      items.push({
        componentId: Number(componentId), stage: v.stage,
        useOwnValue: val !== null, value: val,
        filter: tableCapable && v.mode === 'table' ? { mode: 'table' } : null,
      });
    }
    const shareParsed = parseNum(form.shareValue);
    if (form.shareMode === 'constant' && shareParsed !== null && Number.isNaN(shareParsed)) {
      setErr(`Доля врача: «${form.shareValue}» не число. Введите долю 0…1, например 0.6 (это 60%).`);
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        payeeId: Number(form.payeeId), name: form.name, kind: form.kind, shareMode: form.shareMode,
        validFrom: form.validFrom, note: form.note || null, items,
      };
      if (form.shareMode === 'constant') body.shareValue = shareParsed;
      else {
        const rows: { key: string; share: number }[] = [];
        for (const r of shareRows) {
          if (!r.key || r.share === '') continue;
          const share = parseNum(r.share);
          if (share === null || Number.isNaN(share)) {
            setErr(`Доля для «${r.key}»: «${r.share}» не число. Введите долю 0…1, например 0.6.`);
            setBusy(false);
            return;
          }
          rows.push({ key: r.key, share });
        }
        body.shareValues = rows;
      }
      await apiPost('/payouts/schemes', body);
      qc.invalidateQueries({ queryKey: ['payout-schemes'] });
      setOpen(false); reset();
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Не удалось сохранить'); } finally { setBusy(false); }
  };

  const columns: Column<Scheme>[] = [
    { header: 'Врач', cell: (s) => <span className="font-medium">{payeeName(s.payeeId)}</span> },
    { header: 'Схема', cell: (s) => s.name },
    { header: 'Тип', cell: (s) => SCHEME_KIND_LABEL[s.kind] ?? s.kind },
    { header: 'Доля', cell: (s) => (s.shareMode === 'constant' ? (s.shareValue != null ? `${Math.round(s.shareValue * 100)}%` : '—') : SHARE_MODE_LABEL[s.shareMode]) },
    { header: 'Версия', align: 'right', cell: (s) => s.version },
    { header: 'Период', cell: (s) => `${fmtDate(s.validFrom)} — ${s.validTo ? fmtDate(s.validTo) : 'действует'}` },
    { header: 'Компонентов', align: 'right', cell: (s) => s.items.length },
  ];
  return (
    <div>
      <div className="mb-3 flex justify-end"><button className="btn-primary" onClick={() => { reset(); setOpen(true); }}>+ Схема</button></div>
      <p className="mb-3 text-sm text-slate-500">Изменение условий схемы создаёт новую версию: предыдущая закрывается предыдущим днём. Периоды одного врача не пересекаются. Клик по строке — просмотр параметров схемы.</p>
      <TabShell isLoading={isLoading} isError={isError} empty={!data || data.items.length === 0}>
        <Table columns={columns} rows={data?.items ?? []} onRowClick={(s) => setViewing(s)} />
      </TabShell>

      {/* Просмотр параметров сохранённой схемы (версии неизменяемы — только чтение) */}
      <Modal open={viewing != null} onClose={() => setViewing(null)} title={`Схема «${viewing?.name ?? ''}» · версия ${viewing?.version ?? ''}`} wide>
        {viewing && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div><div className="label">Врач</div><div className="font-medium">{payeeName(viewing.payeeId)}</div></div>
              <div><div className="label">Тип</div><div>{SCHEME_KIND_LABEL[viewing.kind] ?? viewing.kind}</div></div>
              <div><div className="label">Период действия</div><div>{fmtDate(viewing.validFrom)} — {viewing.validTo ? fmtDate(viewing.validTo) : 'действует'}</div></div>
              <div><div className="label">Статус</div>{viewing.validTo ? <Badge tone="slate">закрытая версия</Badge> : <Badge tone="green">действующая</Badge>}</div>
            </div>

            <div>
              <div className="label">Доля врача</div>
              {viewing.shareMode === 'constant' ? (
                <div className="font-medium">{viewing.shareValue != null ? `${Math.round(viewing.shareValue * 10000) / 100}%` : '—'} <span className="font-normal text-slate-400">(постоянная)</span></div>
              ) : (
                <table className="mt-1 text-sm">
                  <tbody>
                    {viewing.shareValues.map((sv, i) => (
                      <tr key={i}><td className="pr-6 text-slate-600">{sv.key}</td><td className="text-right font-medium tabular-nums">{Math.round(Number(sv.share) * 10000) / 100}%</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <div className="label">Компоненты вычетов/начислений</div>
              {viewing.items.length === 0 ? (
                <div className="text-slate-400">Компоненты не включены.</div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
                        <th className="px-3 py-1.5">Компонент</th>
                        <th className="px-3 py-1.5">Стадия</th>
                        <th className="px-3 py-1.5 text-right">Значение</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewing.items.map((it) => {
                        const c = comps.data?.items.find((x) => x.id === it.componentId);
                        const vs = c?.valueSource;
                        const isPct = vs === 'pct_of_payments' || vs === 'pct_of_base';
                        let valText = '—';
                        if (it.filter?.mode === 'table') valText = 'по таблице видов операций';
                        else if (it.useOwnValue && it.value != null) valText = isPct ? `${Number(it.value)}%` : fmtMoney(Number(it.value));
                        else if (vs === 'table_by_op_type') valText = 'по таблице видов операций';
                        else if (vs === 'operation_field') valText = 'из карточки операции';
                        else if (vs === 'warehouse_or_norm') valText = 'склад / норматив (больший)';
                        else if (vs === 'pct_of_payments') valText = 'ставка терминала';
                        return (
                          <tr key={it.componentId} className={`border-b border-slate-50 last:border-0 ${it.enabled ? '' : 'text-slate-300 line-through'}`}>
                            <td className="px-3 py-1.5">{c?.name ?? `#${it.componentId}`} <code className="text-xs text-slate-400">{c?.code ?? ''}</code></td>
                            <td className="px-3 py-1.5">{STAGE_LABEL[it.stage] ?? it.stage}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{valText}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {viewing.note && <div><div className="label">Примечание</div><div className="text-slate-600">{viewing.note}</div></div>}
            <p className="text-xs text-slate-400">Версии схем неизменяемы (по ним считались начисления). Чтобы поменять условия — создайте новую версию через «+ Схема» для этого врача.</p>
            <div className="flex justify-end"><button className="btn-ghost" onClick={() => setViewing(null)}>Закрыть</button></div>
          </div>
        )}
      </Modal>

      <Modal open={open} onClose={() => setOpen(false)} title="Новая схема / версия" wide>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Врач</label>
              <select className="input" value={form.payeeId} onChange={(e) => setForm({ ...form, payeeId: e.target.value })} required>
                <option value="">— выберите —</option>
                {payees.data?.items.map((p) => <option key={p.id} value={p.id}>{p.fio}</option>)}
              </select>
            </div>
            <div><label className="label">Название схемы</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
            <div><label className="label">Тип схемы</label>
              <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {Object.entries(SCHEME_KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div><label className="label">Действует с</label>
              <input type="date" className="input" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} required />
              <p className="mt-1 text-xs text-amber-600">Схема применяется к операциям С ЭТОЙ ДАТЫ. Чтобы посчитать уже проведённые операции — ставьте раннюю дату (по умолчанию 2020-01-01).</p>
            </div>
          </div>

          <div>
            <label className="label">Доля врача</label>
            <select className="input mb-2" value={form.shareMode} onChange={(e) => setForm({ ...form, shareMode: e.target.value })}>
              {Object.entries(SHARE_MODE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {form.shareMode === 'constant' ? (
              <input type="number" step="any" min={0} max={1} className="input" placeholder="доля 0…1 (напр. 0.6)" value={form.shareValue} onChange={(e) => setForm({ ...form, shareValue: e.target.value })} />
            ) : (
              <div className="space-y-2">
                {shareRows.map((r, i) => (
                  <div key={i} className="flex gap-2">
                    <div className="flex-1"><DictSelect category="zapis" value={r.key} onChange={(v) => setShareRows(shareRows.map((x, j) => (j === i ? { ...x, key: v } : x)))} placeholder="— источник записи —" /></div>
                    <input type="number" step="any" min={0} max={1} className="input w-32" placeholder="доля 0…1" value={r.share} onChange={(e) => setShareRows(shareRows.map((x, j) => (j === i ? { ...x, share: e.target.value } : x)))} />
                    <button type="button" className="btn-ghost px-2" onClick={() => setShareRows(shareRows.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                <button type="button" className="btn-ghost text-sm" onClick={() => setShareRows([...shareRows, { key: '', share: '' }])}>+ строка</button>
              </div>
            )}
          </div>

          <div>
            <label className="label">Компоненты вычетов/начислений</label>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-100 p-2">
              {comps.data?.items.filter((c) => c.isActive).map((c) => {
                const on = c.id in picked;
                const vs = c.valueSource;
                const isPct = vs === 'pct_of_payments' || vs === 'pct_of_base';
                const noValue = vs === 'warehouse_or_norm';
                const tableCapable = vs === 'operation_field' || vs === 'table_by_op_type';
                const mode = on ? picked[c.id].mode : 'card';
                const hint =
                  vs === 'pct_of_payments' ? 'считается только с оплат «Через терминал»; пусто = по ставкам терминалов (рекомендуется); число = единый % для этого врача вместо ставок'
                    : vs === 'pct_of_base' ? 'процент: «до доли» — от базы, «после доли» — от доли врача'
                    : vs === 'operation_field' ? 'из карточки — сумма из операции; фикс — одна сумма на ВСЕ операции; по таблице — сумма по виду операции из вкладки «Компоненты» (вид не в таблице → 0)'
                    : vs === 'table_by_op_type' ? 'по таблице — сумма по виду операции (вкладка «Компоненты»); фикс — одна сумма на все операции'
                    : vs === 'warehouse_or_norm' ? 'факт со склада или норматив (см. вкладку «Нормативы материалов») — берётся больший'
                    : 'сумма, ₸';
                return (
                  <div key={c.id} className="rounded px-1 py-0.5">
                    <div className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={on} onChange={(e) => {
                        const next = { ...picked };
                        // Если у компонента заполнена таблица по видам операций — по умолчанию «по таблице».
                      if (e.target.checked) next[c.id] = { stage: c.defaultStage, value: '', mode: c.valueSource === 'table_by_op_type' || (c._count?.tableValues ?? 0) > 0 ? 'table' : 'card' };
                        else delete next[c.id];
                        setPicked(next);
                      }} />
                      <span className="flex-1">{c.name} <code className="text-xs text-slate-400">{c.code}</code></span>
                      {on && (
                        <>
                          <select className="input h-8 w-32 py-0 text-xs" value={picked[c.id].stage} onChange={(e) => setPicked({ ...picked, [c.id]: { ...picked[c.id], stage: e.target.value } })}>
                            <option value="before_share">до доли</option>
                            <option value="after_share">после доли</option>
                          </select>
                          {tableCapable && (
                            <select className="input h-8 w-36 py-0 text-xs" value={mode} onChange={(e) => setPicked({ ...picked, [c.id]: { ...picked[c.id], mode: e.target.value as 'card' | 'fixed' | 'table' } })}>
                              {vs === 'operation_field' && <option value="card">из карточки операции</option>}
                              <option value="table">по таблице видов операций</option>
                              <option value="fixed">фикс сумма</option>
                            </select>
                          )}
                          {noValue ? (
                            <span className="w-28 text-center text-xs text-slate-400">склад/норматив</span>
                          ) : tableCapable && mode !== 'fixed' ? (
                            <span className="w-28 text-center text-xs text-slate-400">{mode === 'table' ? 'из таблицы' : 'из операции'}</span>
                          ) : (
                            <input className="input h-8 w-28 py-0 text-xs" placeholder={isPct ? 'напр. 3 (%)' : 'сумма ₸'} value={picked[c.id].value} onChange={(e) => setPicked({ ...picked, [c.id]: { ...picked[c.id], value: e.target.value } })} />
                          )}
                        </>
                      )}
                    </div>
                    {on && <p className="ml-6 text-xs text-slate-400">{hint}</p>}
                  </div>
                );
              })}
            </div>
          </div>

          <div><label className="label">Примечание</label><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Отмена</button><button className="btn-primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></div>
        </form>
      </Modal>
    </div>
  );
}
