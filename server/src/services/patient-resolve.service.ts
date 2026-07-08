import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma, type PrismaClientOrTx } from '../lib/prisma.js';
import { normalizePhone } from '../lib/phone.js';
import { assertDictionaryValue } from './dictionary.service.js';
import { writeAudit } from './audit.service.js';
import { badRequest } from '../lib/http.js';

export interface PatientInput {
  fio: string;
  phone: string;
  city?: string | null;
  birthDate?: Date | string | null;
}

// Находит пациента по телефону (ключ связи из ТЗ) или создаёт нового.
// Непустые поля обновляются, чтобы данные оставались актуальными; удалённый
// пациент восстанавливается. Возвращает patientId для привязки записи.
export async function resolvePatient(
  input: PatientInput,
  req: Request,
  client: PrismaClientOrTx = prisma,
): Promise<number> {
  const phone = normalizePhone(input.phone ?? '');
  const fio = (input.fio ?? '').trim();
  if (!fio || !phone) throw badRequest('Для пациента обязательны ФИО и телефон');
  await assertDictionaryValue('city', input.city ?? null, client);

  const userId = req.user!.id;
  const birthDate = input.birthDate ? new Date(input.birthDate) : null;
  const existing = await client.patient.findUnique({ where: { phone } });

  if (existing) {
    const data: Record<string, unknown> = {};
    if (fio && fio !== existing.fio) data.fio = fio;
    if (input.city && input.city !== existing.city) data.city = input.city;
    if (birthDate && (!existing.birthDate || birthDate.getTime() !== existing.birthDate.getTime()))
      data.birthDate = birthDate;
    if (existing.deletedAt) {
      data.deletedAt = null;
      data.deletedBy = null;
    }
    if (Object.keys(data).length) {
      data.updatedBy = userId;
      const updated = await client.patient.update({ where: { id: existing.id }, data });
      await writeAudit(
        req,
        {
          action: existing.deletedAt ? 'restore' : 'update',
          entity: 'patient',
          entityId: existing.id,
          before: existing,
          after: updated,
        },
        client,
      );
    }
    return existing.id;
  }

  try {
    const created = await client.patient.create({
      data: { fio, phone, city: input.city ?? null, birthDate, createdBy: userId, updatedBy: userId },
    });
    await writeAudit(req, { action: 'create', entity: 'patient', entityId: created.id, after: created }, client);
    return created.id;
  } catch (e) {
    // Гонка двух одновременных сабмитов: параллельный запрос успел создать пациента
    // с тем же телефоном (@unique). Не падаем 500 — берём уже созданного.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await client.patient.findUnique({ where: { phone } });
      if (again) return again.id;
    }
    throw e;
  }
}
