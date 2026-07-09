import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { JournalPage } from '../components/JournalPage';
import { useDictionaries } from '../lib/dictionaries';
import { useAuth } from '../lib/auth';
import { apiPatch } from '../api/client';
import { formatDate, formatMoney } from '../lib/format';
import { Badge, Modal } from '../components/ui';
import { EntityForm, type Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface Consultation {
  id: number;
  patient?: { fio: string };
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

  const columns: Column<Consultation>[] = [
    { header: 'Пациент', cell: (c) => <span className="font-medium">{c.patient?.fio ?? '—'}</span> },
    { header: 'Дата', cell: (c) => formatDate(c.dateKons) },
    { header: 'Менеджер', cell: (c) => c.manager ?? '—' },
    { header: 'Врач', cell: (c) => c.doctor ?? '—' },
    { header: 'Интерес', cell: (c) => c.interestOperation ?? '—' },
    {
      header: 'Оплата',
      align: 'right',
      cell: (c) => (c.amount ? formatMoney(c.amount) : <span className="text-slate-400">бесплатно</span>),
    },
    { header: 'Итог', cell: (c) => (c.stage ? <Badge tone="blue">{c.stage}</Badge> : <Badge tone="amber">нет итога</Badge>) },
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
        renderFilters={(params, setParam) => (
          <select
            className="input max-w-xs"
            value={(params.stage as string) ?? ''}
            onChange={(e) => setParam('stage', e.target.value)}
          >
            <option value="">Все стадии</option>
            {dict?.consultation_stage?.map((s) => (
              <option key={s.id} value={s.label}>
                {s.label}
              </option>
            ))}
          </select>
        )}
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
