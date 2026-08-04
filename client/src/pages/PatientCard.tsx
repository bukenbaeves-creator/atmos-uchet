import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import { formatDate, formatMoney } from '../lib/format';
import { PageHeader, Spinner, Badge } from '../components/ui';

interface CardData {
  patient: { id: number; fio: string; phone: string; city: string | null; birthDate: string | null };
  consultations: { id: number; dateKons: string | null; stage: string | null; doctor: string | null; amount: number | null }[];
  operations: {
    id: number;
    dateOp: string | null;
    opType: string | null;
    totalDue: number;
    paid: number;
    balance: number;
    fullyPaid: boolean;
  }[];
  payments: {
    id: number;
    date: string | null;
    serviceType: string | null;
    amount: number;
    payMethod: string | null;
    operationId: number | null;
  }[];
  totalBalance: number;
  summary: { received: number; toOperations: number; toOther: number; totalDue: number; totalBalance: number };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="mb-3 text-sm font-semibold text-slate-700">{title}</div>
      {children}
    </div>
  );
}

export function PatientCard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['patient-card', id],
    queryFn: () => apiGet<CardData>(`/patients/${id}/card`),
  });

  if (isLoading) return <Spinner />;
  if (isError || !data)
    return (
      <div className="py-12 text-center text-sm text-slate-400">
        Пациент не найден или данные не загрузились.{' '}
        <button className="text-brand-600 hover:underline" onClick={() => navigate('/patients')}>
          К списку пациентов
        </button>
      </div>
    );
  const p = data.patient;
  // Карта «id операции → короткая подпись» для привязки платежей
  const opById = new Map(data.operations.map((o) => [o.id, `${o.opType ?? '—'} · ${formatDate(o.dateOp)}`]));
  const s = data.summary;

  return (
    <div>
      <PageHeader
        title={p.fio}
        subtitle={`${p.phone} · ${p.city ?? 'город не указан'} · д.р. ${formatDate(p.birthDate)}`}
        actions={
          <>
            <button className="btn-ghost" onClick={() => navigate('/consultations')}>
              + Консультация
            </button>
            <button className="btn-ghost" onClick={() => navigate('/operations')}>
              + Операция
            </button>
            <button className="btn-ghost" onClick={() => navigate(-1)}>
              ← Назад
            </button>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="card">
          <div className="text-xs uppercase text-slate-400">Суммарный остаток</div>
          <div className={`mt-1 text-2xl font-bold ${data.totalBalance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
            {formatMoney(data.totalBalance)}
          </div>
        </div>
        <div className="card">
          <div className="text-xs uppercase text-slate-400">Консультаций</div>
          <div className="mt-1 text-2xl font-bold">{data.consultations.length}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase text-slate-400">Операций</div>
          <div className="mt-1 text-2xl font-bold">{data.operations.length}</div>
        </div>
        <div className="card">
          <div className="text-xs uppercase text-slate-400">Платежей</div>
          <div className="mt-1 text-2xl font-bold">{data.payments.length}</div>
        </div>
      </div>

      <div className="mb-4 card">
        <div className="mb-3 text-sm font-semibold text-slate-700">Сверка по деньгам</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm lg:grid-cols-3">
          <div className="flex items-center justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">Получено всего</span>
            <span className="font-semibold tabular-nums">{formatMoney(s.received)}</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">На операции</span>
            <span className="tabular-nums text-emerald-600">{formatMoney(s.toOperations)}</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">Прочие услуги</span>
            <span className="tabular-nums">{formatMoney(s.toOther)}</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">К оплате по операциям</span>
            <span className="tabular-nums">{formatMoney(s.totalDue)}</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100 pb-1">
            <span className="text-slate-500">Долг по операциям</span>
            <span className={`font-semibold tabular-nums ${s.totalBalance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
              {formatMoney(s.totalBalance)}
            </span>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-400">
          «Получено всего» = «На операции» + «Прочие услуги». Прочие услуги (консультации, анализы) не привязаны к
          операциям, поэтому в долг по операциям не входят.
        </div>
      </div>

      <div className="space-y-4">
        <Section title="Консультации">
          {data.consultations.length === 0 ? (
            <div className="text-sm text-slate-400">Нет консультаций</div>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.consultations.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2">
                  <span>
                    {formatDate(c.dateKons)} · {c.doctor ?? '—'}
                  </span>
                  <span className="flex items-center gap-3">
                    {c.stage ? <Badge tone="blue">{c.stage}</Badge> : <Badge tone="red">нет итога</Badge>}
                    <span className="tabular-nums">{formatMoney(c.amount)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Операции">
          {data.operations.length === 0 ? (
            <div className="text-sm text-slate-400">Нет операций</div>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.operations.map((o) => (
                <li key={o.id} className="flex items-center justify-between py-2">
                  <span>
                    {formatDate(o.dateOp)} · {o.opType ?? '—'}
                  </span>
                  <span className="flex items-center gap-4">
                    <span className="text-slate-500">к оплате {formatMoney(o.totalDue)}</span>
                    <span className="text-emerald-600">оплачено {formatMoney(o.paid)}</span>
                    <span className={o.balance > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}>
                      остаток {formatMoney(o.balance)}
                    </span>
                    {o.fullyPaid ? <Badge tone="green">100%</Badge> : <Badge tone="amber">долг</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Платежи">
          {data.payments.length === 0 ? (
            <div className="text-sm text-slate-400">Нет платежей</div>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {data.payments.map((pay) => (
                <li key={pay.id} className="flex items-center justify-between py-2">
                  <span>
                    {formatDate(pay.date)} · {pay.serviceType ?? '—'} · {pay.payMethod ?? '—'}
                    {pay.operationId && opById.has(pay.operationId) ? (
                      <span className="text-slate-500"> · операция: {opById.get(pay.operationId)}</span>
                    ) : (
                      <span className="text-slate-400"> · без привязки к операции</span>
                    )}
                  </span>
                  <span className="font-semibold tabular-nums">{formatMoney(pay.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
