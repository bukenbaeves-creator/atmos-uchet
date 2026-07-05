import { useMemo, useState } from 'react';
import { useDictionaries } from '../lib/dictionaries';
import { toInputDate } from '../lib/format';
import { ApiError } from '../api/client';
import { PatientField } from './PatientField';
import { PatientBlock, type PatientValue } from './PatientBlock';
import { MoneyInput } from './MoneyInput';
import { OperationSelect } from './OperationSelect';
import { PhoneInput } from './PhoneInput';

export type FieldType =
  | 'text'
  | 'number'
  | 'money'
  | 'date'
  | 'time'
  | 'select'
  | 'checkbox'
  | 'textarea'
  | 'patient'
  | 'patientBlock'
  | 'operation'
  | 'phone';

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  dict?: string; // категория справочника для select
  span?: 1 | 2;
  // Условное отображение: поле показывается/отправляется только когда возвращает true
  showWhen?: (values: Record<string, unknown>) => boolean;
}

interface Props {
  fields: Field[];
  initial?: Record<string, unknown>;
  submitLabel?: string;
  onSubmit: (data: Record<string, unknown>) => Promise<unknown>;
  onDone: () => void;
}

function initialValue(field: Field, initial?: Record<string, unknown>) {
  if (field.type === 'patientBlock') {
    const p = (initial?.patient as Record<string, unknown> | undefined) ?? {};
    return {
      fio: (p.fio as string) ?? '',
      phone: (p.phone as string) ?? '',
      city: (p.city as string) ?? '',
      birthDate: toInputDate(p.birthDate as string),
      patientId: (p.id as number) ?? undefined,
    } as PatientValue;
  }
  const raw = initial?.[field.name];
  if (field.type === 'date') return toInputDate(raw as string);
  if (field.type === 'checkbox') return Boolean(raw);
  if (raw == null) return '';
  return raw;
}

export function EntityForm({ fields, initial, submitLabel = 'Сохранить', onSubmit, onDone }: Props) {
  const { data: dict } = useDictionaries();
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of fields) v[f.name] = initialValue(f, initial);
    return v;
  });
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<{ path: string; message: string }[] | undefined>();
  const [saving, setSaving] = useState(false);

  const set = (name: string, value: unknown) => setValues((s) => ({ ...s, [name]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDetails(undefined);
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.showWhen && !f.showWhen(values)) continue; // скрытые поля не отправляем
        let v = values[f.name];
        if (f.type === 'patientBlock') {
          const p = (v as PatientValue) ?? {};
          payload[f.name] = {
            fio: (p.fio ?? '').trim(),
            phone: (p.phone ?? '').trim(),
            city: p.city || '', // пусто -> '' даёт русскую ошибку «Необходимо указать город»
            birthDate: p.birthDate || null,
          };
          continue;
        }
        if (f.type === 'money' || f.type === 'number' || f.type === 'operation')
          v = v === '' || v == null ? null : Number(v);
        if (f.type === 'checkbox') v = Boolean(v);
        if (
          (f.type === 'text' ||
            f.type === 'textarea' ||
            f.type === 'select' ||
            f.type === 'time' ||
            f.type === 'date') &&
          v === ''
        )
          v = null;
        payload[f.name] = v;
      }
      await onSubmit(payload);
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setDetails(err.details);
      } else {
        setError('Не удалось сохранить');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields
          .filter((f) => !f.showWhen || f.showWhen(values))
          .map((f) => (
          <div key={f.name} className={f.span === 2 ? 'sm:col-span-2' : ''}>
            {f.type !== 'checkbox' && f.type !== 'patientBlock' && (
              <label className="label">
                {f.label}
                {f.required && <span className="text-rose-500"> *</span>}
              </label>
            )}
            <FieldControl
              field={f}
              value={values[f.name]}
              onChange={(v) => set(f.name, v)}
              options={f.dict ? dict?.[f.dict] ?? [] : []}
              form={values}
            />
          </div>
        ))}
      </div>

      {error && (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {details && details.length ? (
            <>
              <div className="font-medium">Проверьте заполнение полей:</div>
              <ul className="mt-1 list-inside list-disc">
                {details.map((d, i) => (
                  <li key={i}>{d.message}</li>
                ))}
              </ul>
            </>
          ) : (
            error
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Отмена
        </button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Сохранение…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  options,
  form,
}: {
  field: Field;
  value: unknown;
  onChange: (v: unknown) => void;
  options: { id: number; label: string }[];
  form: Record<string, unknown>;
}) {
  const opts = useMemo(() => options, [options]);
  switch (field.type) {
    case 'patientBlock':
      return <PatientBlock value={value as PatientValue} onChange={(v) => onChange(v)} />;
    case 'operation': {
      const patient = form.patient as PatientValue | undefined;
      return (
        <OperationSelect
          patientId={patient?.patientId ?? null}
          value={(value as number | null) ?? null}
          onChange={onChange}
        />
      );
    }
    case 'patient':
      return <PatientField value={value as number | null} onChange={onChange} />;
    case 'select':
      return (
        <select
          className="input"
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— не выбрано —</option>
          {opts.map((o) => (
            <option key={o.id} value={o.label}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'checkbox':
      return (
        <label className="mt-5 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
        </label>
      );
    case 'textarea':
      return (
        <textarea
          className="input min-h-[70px]"
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          className="input"
          required={field.required}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'time':
      return <input type="time" className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'money':
      return <MoneyInput value={value as number | string | null} onChange={onChange} />;
    case 'phone':
      return <PhoneInput value={(value as string) ?? ''} onChange={(v) => onChange(v)} />;
    case 'number':
      return (
        <input
          type="number"
          className="input"
          value={(value as string | number) ?? ''}
          min={0}
          step={1}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <input type="text" className="input" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}
