import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ListResponse } from '../api/hooks';
import { useDictionaries } from '../lib/dictionaries';
import { toInputDate } from '../lib/format';
import { PhoneInput } from './PhoneInput';

export interface PatientValue {
  fio?: string;
  phone?: string;
  city?: string | null;
  birthDate?: string | null;
  patientId?: number | null; // id найденного существующего пациента (для привязок)
}

interface Patient {
  id: number;
  fio: string;
  phone: string;
  city: string | null;
  birthDate: string | null;
}

// Ввод пациента прямо в форме журнала: поиск существующего (автоподстановка по
// ФИО/телефону) ИЛИ ввод нового. На сервере пациент находится/создаётся по телефону.
export function PatientBlock({ value, onChange }: { value: PatientValue; onChange: (v: PatientValue) => void }) {
  const v = value || {};
  const set = (k: keyof PatientValue, val: unknown) => onChange({ ...v, [k]: val });
  const { data: dict } = useDictionaries();
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['patients', 'block', term],
    queryFn: () => apiGet<ListResponse<Patient>>(`/patients?pageSize=8&search=${encodeURIComponent(term)}`),
    enabled: open && term.length >= 1,
  });

  const pickExisting = (p: Patient) => {
    onChange({ fio: p.fio, phone: p.phone, city: p.city ?? '', birthDate: toInputDate(p.birthDate), patientId: p.id });
    setTerm('');
    setOpen(false);
  };

  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Пациент</div>

      {/* Поиск существующего */}
      <div className="relative mb-3">
        <input
          className="input"
          placeholder="🔍 Найти существующего (ФИО или телефон) — или заполните поля ниже"
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
        {open && (data?.items?.length ?? 0) > 0 && (
          <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {data!.items.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-brand-50"
                  onClick={() => pickExisting(p)}
                >
                  <span className="font-medium">{p.fio}</span>
                  <span className="text-xs text-slate-400">
                    {p.phone}
                    {p.city ? ` · ${p.city}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Поля пациента */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label">
            ФИО <span className="text-rose-500">*</span>
          </label>
          <input className="input" required value={v.fio ?? ''} onChange={(e) => set('fio', e.target.value)} />
          <div className="mt-1 text-xs text-slate-400">Желательно указать фамилию и имя пациента.</div>
        </div>
        <div>
          <label className="label">
            Телефон <span className="text-rose-500">*</span>
          </label>
          <PhoneInput
            required
            value={(v.phone as string) ?? ''}
            onChange={(val) => onChange({ ...v, phone: val, patientId: undefined })}
          />
        </div>
        <div>
          <label className="label">Город</label>
          <select className="input" required value={(v.city as string) ?? ''} onChange={(e) => set('city', e.target.value)}>
            <option value="">— не выбрано —</option>
            {dict?.city?.map((o) => (
              <option key={o.id} value={o.label}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Дата рождения</label>
          <input
            type="date"
            className="input"
            min="1900-01-01"
            max={new Date().toISOString().slice(0, 10)}
            value={(v.birthDate as string) ?? ''}
            onChange={(e) => set('birthDate', e.target.value)}
          />
        </div>
      </div>
      <div className="mt-2 text-xs text-slate-400">
        Если пациент с таким телефоном уже есть — запись привяжется к нему; иначе он появится во вкладке «Пациенты».
      </div>
    </div>
  );
}
