import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ListResponse } from '../api/hooks';

interface Patient {
  id: number;
  fio: string;
  phone: string;
}

// Комбобокс выбора пациента с поиском по ФИО/телефону (раздел 9.3/9.4 ТЗ).
export function PatientField({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<string>('');

  // Подгружаем имя выбранного пациента (при редактировании)
  useEffect(() => {
    if (value && !selectedLabel) {
      apiGet<Patient>(`/patients/${value}`)
        .then((p) => setSelectedLabel(`${p.fio} · ${p.phone}`))
        .catch(() => undefined);
    }
    if (!value) setSelectedLabel('');
  }, [value]);

  const { data } = useQuery({
    queryKey: ['patients', 'picker', term],
    queryFn: () => apiGet<ListResponse<Patient>>(`/patients?pageSize=8&search=${encodeURIComponent(term)}`),
    enabled: open && term.length >= 1,
  });

  if (value && selectedLabel) {
    return (
      <div className="flex items-center gap-2">
        <div className="input flex-1 bg-slate-50">{selectedLabel}</div>
        <button type="button" className="btn-ghost px-2 py-2" onClick={() => onChange(null)}>
          Сменить
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        className="input"
        placeholder="Поиск по ФИО или телефону…"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && (data?.items?.length ?? 0) > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {data!.items.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-slate-50"
                onClick={() => {
                  onChange(p.id);
                  setSelectedLabel(`${p.fio} · ${p.phone}`);
                  setOpen(false);
                }}
              >
                <span className="font-medium">{p.fio}</span>
                <span className="text-xs text-slate-400">{p.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
