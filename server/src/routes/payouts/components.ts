import { Router } from 'express';
import { z } from 'zod';
import { ComponentValueSource, ComponentDirection, CalcStage } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, notFound } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireAdmin } from '../../middleware/rbac.js';
import { writeAudit } from '../../services/audit.service.js';
import { serialize } from '../../lib/serialize.js';
import { requiredString, optionalString, requiredDate } from '../../schemas.js';

// Компоненты расчёта выплат. У модели CalcComponent НЕТ deletedAt — фабрика не
// подходит, ручной роутер. Только администратор. Системные (isSystem) удалить нельзя,
// можно только деактивировать; используемый в схемах компонент тоже деактивируется.
const router = Router();
router.use(requireAuth, requireAdmin);

const createSchema = z.object({
  code: requiredString('Необходим код компонента', 50),
  name: requiredString('Необходимо название компонента', 200),
  valueSource: z.nativeEnum(ComponentValueSource),
  direction: z.nativeEnum(ComponentDirection).default('deduction'),
  defaultStage: z.nativeEnum(CalcStage).default('before_share'),
  defaultValue: z.coerce.number().optional().nullable(),
  operationField: optionalString(50),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.coerce.boolean().default(true),
  description: optionalString(),
});
// Код менять нельзя (по нему идёт сид и логика расчёта).
const updateSchema = createSchema.omit({ code: true }).partial();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    // _count.tableValues — есть ли у компонента таблица «вид операции → сумма» (для UI).
    const rows = await prisma.calcComponent.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { tableValues: true } } },
    });
    res.json({ items: serialize(rows) });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = createSchema.parse(req.body);
    const dup = await prisma.calcComponent.findUnique({ where: { code: data.code } });
    if (dup) throw badRequest('Компонент с таким кодом уже существует');
    const created = await prisma.calcComponent.create({
      data: { ...data, isSystem: false, createdBy: req.user!.id, updatedBy: req.user!.id },
    });
    await writeAudit(req, { action: 'create', entity: 'calc_component', entityId: created.id, after: created });
    res.status(201).json(serialize(created));
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.calcComponent.findUnique({ where: { id } });
    if (!before) throw notFound('Компонент не найден');
    const data = updateSchema.parse(req.body);
    const updated = await prisma.calcComponent.update({ where: { id }, data: { ...data, updatedBy: req.user!.id } });
    await writeAudit(req, { action: 'update', entity: 'calc_component', entityId: id, before, after: updated });
    res.json(serialize(updated));
  }),
);

// Удаление разрешено только для несистемного и неиспользуемого компонента; иначе —
// деактивация (isActive=false) с понятным сообщением.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const before = await prisma.calcComponent.findUnique({ where: { id } });
    if (!before) throw notFound('Компонент не найден');
    const usedCount = await prisma.schemeComponent.count({ where: { componentId: id } });
    if (before.isSystem || usedCount > 0) {
      const updated = await prisma.calcComponent.update({ where: { id }, data: { isActive: false, updatedBy: req.user!.id } });
      await writeAudit(req, { action: 'update', entity: 'calc_component', entityId: id, before, after: updated });
      return res.json({
        deactivated: true,
        message: before.isSystem
          ? 'Системный компонент удалить нельзя — он деактивирован.'
          : 'Компонент используется в схемах — деактивирован, не удалён.',
        item: serialize(updated),
      });
    }
    await prisma.calcComponent.delete({ where: { id } });
    await writeAudit(req, { action: 'delete', entity: 'calc_component', entityId: id, before });
    res.json({ deleted: true });
  }),
);

// ---------- Таблица «вид операции → сумма» компонента (наркоз, седация, …) ----------
// Глобальная (schemeId null), append-only: изменение = новая запись с новой validFrom.
router.get(
  '/:id/table',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const rows = await prisma.componentTableValue.findMany({ where: { componentId: id, schemeId: null }, orderBy: [{ key: 'asc' }, { validFrom: 'desc' }] });
    res.json({ items: serialize(rows) });
  }),
);
const tableRowSchema = z.object({
  key: requiredString('Укажите вид операции', 200),
  value: z.coerce.number({ invalid_type_error: 'Сумма должна быть числом' }).min(0),
  validFrom: requiredDate('Укажите дату начала действия'),
});
router.post(
  '/:id/table',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const comp = await prisma.calcComponent.findUnique({ where: { id } });
    if (!comp) throw notFound('Компонент не найден');
    const d = tableRowSchema.parse(req.body);
    const created = await prisma.componentTableValue.create({ data: { componentId: id, schemeId: null, key: d.key, value: d.value, validFrom: d.validFrom } });
    await writeAudit(req, { action: 'create', entity: 'component_table_value', entityId: created.id, after: created });
    res.status(201).json(serialize(created));
  }),
);

export default router;
