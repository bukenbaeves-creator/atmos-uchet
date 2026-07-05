import { useNavigate } from 'react-router-dom';
import { JournalPage } from '../components/JournalPage';
import { formatDate } from '../lib/format';
import type { Field } from '../components/EntityForm';
import type { Column } from '../components/Table';

interface Patient {
  id: number;
  fio: string;
  phone: string;
  city: string | null;
  birthDate: string | null;
  createdBy?: number | null;
  createdAt?: string;
}

const fields: Field[] = [
  { name: 'fio', label: 'ФИО', type: 'text', required: true, span: 2 },
  { name: 'phone', label: 'Телефон', type: 'phone', required: true },
  { name: 'birthDate', label: 'Дата рождения', type: 'date' },
  { name: 'city', label: 'Город', type: 'select', dict: 'city', required: true },
];

export function Patients() {
  const navigate = useNavigate();
  const columns: Column<Patient>[] = [
    { header: 'ФИО', cell: (p) => <span className="font-medium text-brand-700">{p.fio}</span> },
    { header: 'Телефон', cell: (p) => p.phone },
    { header: 'Город', cell: (p) => p.city ?? '—' },
    { header: 'Дата рождения', cell: (p) => formatDate(p.birthDate) },
  ];

  return (
    <JournalPage<Patient>
      entity="patients"
      title="Пациенты"
      subtitle="Реестр пациентов. Клик по строке — карточка пациента."
      columns={columns}
      fields={fields}
      exportJournal="patients"
      newButtonLabel="Пациента"
      onRowClick={(p) => navigate(`/patients/${p.id}`)}
    />
  );
}
