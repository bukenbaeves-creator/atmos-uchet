import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, forbidden, notFound } from './lib/http.js';
import { requireAuth } from './middleware/auth.js';
import { requireAdmin, canEditRecord } from './middleware/rbac.js';
import { writeAudit } from './services/audit.service.js';
import { serialize } from './lib/serialize.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = any;

export interface CrudConfig {
  entity: string; // тип сущности для аудита: patient | consultation | operation | payment
  model: AnyModel; // делегат Prisma (prisma.patient и т.д.)
  createSchema: z.ZodTypeAny;
  updateSchema?: z.ZodTypeAny;
  include?: Record<string, unknown>;
  orderBy?: unknown;
  // Формирует where-фрагмент из query-фильтров (?filter=...)
  buildWhere?: (query: Record<string, unknown>) => Record<string, unknown>;
  // Полнотекстовый поиск (?search=...)
  search?: (term: string) => Record<string, unknown>;
  // Доп. валидация (проверка справочников и т.п.)
  validate?: (data: Record<string, unknown>) => Promise<void>;
  // Преобразование строки для ответа (вычисляемые поля)
  transform?: (row: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  // Преобразование данных перед записью (например, upsert пациента -> patientId)
  prepareData?: (data: Record<string, unknown>, req: Request) => Promise<Record<string, unknown>>;
  // Хук после создания (например, создать связанный платёж из консультации)
  afterCreate?: (created: Record<string, unknown>, req: Request) => Promise<void>;
}

async function present(cfg: CrudConfig, row: Record<string, unknown>) {
  const s = serialize(row);
  return cfg.transform ? await cfg.transform(s) : s;
}

export function makeCrudRouter(cfg: CrudConfig): Router {
  const router = Router();
  router.use(requireAuth);

  // Список с поиском, фильтрами и пагинацией
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const q = req.query as Record<string, unknown>;
      const page = Math.max(1, Number(q.page ?? 1));
      const pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? 50)));
      const search = typeof q.search === 'string' ? q.search.trim() : '';

      const and: Record<string, unknown>[] = [{ deletedAt: null }];
      if (cfg.buildWhere) and.push(cfg.buildWhere(q));
      if (search && cfg.search) and.push(cfg.search(search));

      const where = { AND: and };
      const [rows, total] = await Promise.all([
        cfg.model.findMany({
          where,
          include: cfg.include,
          orderBy: cfg.orderBy ?? { id: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        cfg.model.count({ where }),
      ]);

      const items = await Promise.all(rows.map((r: Record<string, unknown>) => present(cfg, r)));
      res.json({ items, total, page, pageSize });
    }),
  );

  // Одна запись
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = Number(req.params.id);
      const row = await cfg.model.findFirst({ where: { id, deletedAt: null }, include: cfg.include });
      if (!row) throw notFound();
      res.json(await present(cfg, row));
    }),
  );

  // Создание
  router.post(
    '/',
    asyncHandler(async (req: Request, res) => {
      let data = cfg.createSchema.parse(req.body) as Record<string, unknown>;
      if (cfg.validate) await cfg.validate(data);
      if (cfg.prepareData) data = await cfg.prepareData(data, req);
      const created = await cfg.model.create({
        data: { ...data, createdBy: req.user!.id, updatedBy: req.user!.id },
        include: cfg.include,
      });
      await writeAudit(req, { action: 'create', entity: cfg.entity, entityId: created.id, after: created });
      if (cfg.afterCreate) await cfg.afterCreate(created, req);
      res.status(201).json(await present(cfg, created));
    }),
  );

  // Обновление (оператор — только свою запись за сегодня; админ — любую)
  router.put(
    '/:id',
    asyncHandler(async (req: Request, res) => {
      const id = Number(req.params.id);
      const existing = await cfg.model.findFirst({ where: { id, deletedAt: null }, include: cfg.include });
      if (!existing) throw notFound();
      if (!canEditRecord(req.user!, existing)) {
        throw forbidden('Оператор может редактировать только свою запись в день её создания');
      }
      const schema = cfg.updateSchema ?? cfg.createSchema;
      let data = schema.parse(req.body) as Record<string, unknown>;
      if (cfg.validate) await cfg.validate(data);
      if (cfg.prepareData) data = await cfg.prepareData(data, req);
      const updated = await cfg.model.update({
        where: { id },
        data: { ...data, updatedBy: req.user!.id },
        include: cfg.include,
      });
      await writeAudit(req, {
        action: 'update',
        entity: cfg.entity,
        entityId: id,
        before: existing,
        after: updated,
      });
      res.json(await present(cfg, updated));
    }),
  );

  // Мягкое удаление (только админ)
  router.delete(
    '/:id',
    requireAdmin,
    asyncHandler(async (req: Request, res) => {
      const id = Number(req.params.id);
      const existing = await cfg.model.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw notFound();
      const updated = await cfg.model.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: req.user!.id },
      });
      await writeAudit(req, {
        action: 'delete',
        entity: cfg.entity,
        entityId: id,
        before: existing,
        after: updated,
      });
      res.json({ ok: true });
    }),
  );

  // Восстановление удалённой записи (только админ)
  router.patch(
    '/:id/restore',
    requireAdmin,
    asyncHandler(async (req: Request, res) => {
      const id = Number(req.params.id);
      const existing = await cfg.model.findFirst({ where: { id, NOT: { deletedAt: null } } });
      if (!existing) throw notFound('Удалённая запись не найдена');
      const updated = await cfg.model.update({
        where: { id },
        data: { deletedAt: null, deletedBy: null, updatedBy: req.user!.id },
        include: cfg.include,
      });
      await writeAudit(req, {
        action: 'restore',
        entity: cfg.entity,
        entityId: id,
        before: existing,
        after: updated,
      });
      res.json(await present(cfg, updated));
    }),
  );

  return router;
}
