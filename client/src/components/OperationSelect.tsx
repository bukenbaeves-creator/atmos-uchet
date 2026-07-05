import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ListResponse } from '../api/hooks';
import { formatDate, formatMoney } from '../lib/format';

interface Operation {
  id: number;
  dateOp: string | null;
  opType: string | null;
  balance: number;
}

// Выбор операции пациента (без ручного ввода ID). Доступен, когда выбран
// существующий пациент.
export function OperationSelect({
  patientId,
  value,
  onChange,
}: {
  patientId?: number | null;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const { data } = useQuery({
    queryKey: ['operations', 'for-patient', patientId],
    queryFn: () => apiGet<ListResponse<Operation>>(`/operations?patientId=${patientId}&pageSize=100`),
    enabled: !!patientId,
  });

  if (!patientId) {
    return (
      <div className="input bg-slate-50 text-slate-400">
        Для существующего пациента здесь можно выбрать операцию. Для предоплаты нового пациента
        операция создастся автоматически по «Виду операции».
      </div>
    );
  }

  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">— платёж не за операцию —</option>
      {data?.items?.map((o) => (
        <option key={o.id} value={o.id}>
          {formatDate(o.dateOp)} · {o.opType ?? 'операция'} · остаток {formatMoney(o.balance)}
        </option>
      ))}
    </select>
  );
}
