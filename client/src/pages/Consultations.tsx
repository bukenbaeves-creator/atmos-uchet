import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { JournalPage } from '../components/JournalPage';
import { useDictionaries } from '../lib/dictionaries';
import { useAuth } from '../lib/auth';
import { apiPatch } from '../api/client';
import dayjs from 'dayjs';
import { formatDate, formatMoney } from '../lib/format';
import { Badge, Modal, Hint } from '../components/ui';
import { EntityForm, type Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface Consultation {
  id: number;
  patient?: { fio: string };
  dateZapis: string | null;
  dateKons: string | null;
  stage: string | null;
  resultDetails: string | null;
  doctor: string | null;
  manager: string | null;
  interestOperation: string | null;
  amount: number | null;
  createdBy?: number | null;
  createdAt?: string;
}

// Оплата необязательна (консультация может быть бесплатной). Если сумма указана —
// платёж автоматически попадает в «Кассу». Итог заполняется позже админом.
const paid = (v: Record<string, unknown>) => Number(v.amount) > 0;

const fields: Field[] = [
  { name: 'patient', label: 'Пациент', type: 'patientBlock', required: true, span: 2 },
  { name: 'manager', label: 'Менеджер (кто записал)', type: 'select', dict: 'manager', required: true },
  { name: 'dateZapis', label: 'Дата записи', type: 'date' },
  { name: 'dateKons', label: 'Дата консультации', type: 'date', required: true },
  { name: 'time', label: 'Время', type: 'time' },
  { name: 'vid', label: 'Вид', type: 'select', dict: 'vid', required: true },
  { name: 'interestOperation', label: 'Интересующая операция', type: 'select', dict: 'op_type', required: true },
  { name: 'doctor', label: 'Врач', type: 'select', dict: 'doctor', required: true },
  // --- оплата (необязательно; если указана — попадёт в «Кассу») ---
  { name: 'amount', label: 'Сумма консультации (пусто = бесплатно)', type: 'money' },
  { name: 'payDate', label: 'Дата оплаты', type: 'date', showWhen: paid },
  { name: 'payMethod', label: 'Способ оплаты', type: 'select', dict: 'pay_method', required: true, showWhen: paid },
  {
    name: 'terminal',
    label: 'Терминал',
    type: 'select',
    dict: 'terminal',
    required: true,
    showWhen: (v) => v.payMethod === 'Через терминал' && paid(v),
  },
  { name: 'payNote', label: 'Уточнение по оплате', type: 'textarea', showWhen: paid, span: 2 },
  // --- итог (заполняется позже админом) ---
  {
    name: 'stage',
    label: 'Итог консультации — заполняется после консультации',
    type: 'select',
    dict: 'consultation_stage',
    allowCustom: true,
  },
  { name: 'resultDetails', label: 'Детали итога консультации', type: 'textarea', span: 2 },
];

// Мини-форма «Итог».
const resultFields: Field[] = [
  { name: 'stage', label: 'Итог консультации', type: 'select', dict: 'consultation_stage', allowCustom: true, span: 2 },
  { name: 'resultDetails', label: 'Детали итога консультации', type: 'textarea', span: 2 },
];

// Оператор правит свою консультацию, пока итог не заполнен (даже если дата прошла);
// после заполнения итога — только админ. Перенос даты и поздняя оплата — через
// обычную форму редактирования.
const consultationEditable = (c: Consultation, user: { id: number; role: string } | null) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return c.createdBy === user.id && !c.stage;
};

export function Consultations() {
  const { data: dict } = useDictionaries();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [resultFor, setResultFor] = useState<Consultation | null>(null);

  // Кнопка «Итог» — быстрый ввод итога, пока запись доступна к правке и итог не задан
  const canFillResult = (c: Consultation) => consultationEditable(c, user ?? null) && !c.stage;

  // Дата консультации прошла, а итог не заполнен — напоминаем менеджеру заполнить.
  const overdueNoResult = (c: Consultation) => !c.stage && !!c.dateKons && dayjs(c.dateKons).isBefore(dayjs(), 'day');

  const opt = (arr?: { id: number; label: string }[]) => (arr ?? []).map((o) => ({ value: o.label, label: o.label }));

  const columns: Column<Consultation>[] = [
    { header: 'Пациент', cell: (c) => <span className="font-medium">{c.patient?.fio ?? '—'}</span> },
    { header: 'Дата записи', cell: (c) => formatDate(c.dateZapis), filter: { kind: 'dateRange', paramFrom: 'dateZapisFrom', paramTo: 'dateZapisTo' } },
    { header: 'Дата консультации', cell: (c) => formatDate(c.dateKons), filter: { kind: 'dateRange', paramFrom: 'dateKonsFrom', paramTo: 'dateKonsTo' } },
    { header: 'Менеджер', cell: (c) => c.manager ?? '—', filter: { kind: 'select', param: 'manager', options: opt(dict?.manager) } },
    { header: 'Врач', cell: (c) => c.doctor ?? '—', filter: { kind: 'select', param: 'doctor', options: opt(dict?.doctor) } },
    { header: 'Интерес', cell: (c) => c.interestOperation ?? '—', filter: { kind: 'select', param: 'interestOperation', options: opt(dict?.op_type) } },
    {
      header: 'Оплата',
      align: 'right',
      cell: (c) => (c.amount ? formatMoney(c.amount) : <span className="text-slate-400">бесплатно</span>),
    },
    {
      header: 'Итог',
      filter: { kind: 'select', param: 'stage', options: opt(dict?.consultation_stage) },
      cell: (c) =>
        c.stage ? (
          <Badge tone="blue">{c.stage}</Badge>
        ) : overdueNoResult(c) ? (
          <span className="inline-flex items-center">
            <Badge tone="red">заполните итог</Badge>
            <Hint text="Дата консультации прошла, а итог не заполнен. Заполните итог по кнопке «Итог» или через «Изменить»." />
          </span>
        ) : (
          <Badge tone="amber">нет итога</Badge>
        ),
    },
  ];

  return (
    <>
      <JournalPage<Consultation>
        entity="consultations"
        title="Консультации"
        subtitle="Оператор правит свою запись, пока итог не заполнен (перенос даты, поздняя оплата). После заполнения итога запись закрыта. Оплата отражается в «Кассе»."
        columns={columns}
        fields={fields}
        exportJournal="consultations"
        newButtonLabel="Консультацию"
        rowEditable={consultationEditable}
        rowActions={(c) =>
          canFillResult(c) ? (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setResultFor(c)}>
              Итог
            </button>
          ) : null
        }
        rowClassName={(c) => (overdueNoResult(c) ? 'bg-amber-50/70' : '')}
        notice={(rows) => {
          const n = rows.filter(overdueNoResult).length;
          if (!n) return null;
          return (
            <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
              ⚠ Консультаций с прошедшей датой без итога на этой странице: <b>{n}</b>. Заполните итог — это нужно для отчётности.
            </div>
          );
        }}
      />

      <Modal
        open={resultFor != null}
        onClose={() => setResultFor(null)}
        title={`Итог консультации · ${resultFor?.patient?.fio ?? ''}`}
      >
        {resultFor && (
          <EntityForm
            fields={resultFields}
            initial={resultFor}
            onSubmit={async (payload) => {
              await apiPatch(`/consultations/${resultFor.id}/result`, payload);
              // Итог влияет на список консультаций, воронку/отчёты и справочник стадий
              for (const k of ['consultations', 'dashboard', 'kpi-report', 'dictionaries']) {
                await qc.invalidateQueries({ queryKey: [k] });
              }
            }}
            onDone={() => setResultFor(null)}
          />
        )}
      </Modal>
    </>
  );
}
