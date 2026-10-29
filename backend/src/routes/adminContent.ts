import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAdmin, requireStaff } from '../middleware/auth.js';
import { noStore, parse } from '../middleware/common.js';
import { audit } from '../services/audit.js';
import { deleteStored, saveImage } from '../services/storage.js';
import { mapService } from './public.js';

const uuid = z.string().uuid('Invalid id');
const adminActor = (req: any) => ({ id: req.auth.user.id as string, role: 'admin' });
export const adminContentRouter = Router();
adminContentRouter.use(noStore);

// ---- services ------------------------------------------------------------------------------
const serviceBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(1000).default(''),
  price: z.number().min(0).max(100_000_000),
  durationMinutes: z.number().int().min(5).max(480),
  imageUrl: z.string().url().max(500).nullable().optional(),
  isActive: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
});

adminContentRouter.get('/services', requireStaff, async (_req, res) => {
  res.json({ items: (await query('SELECT * FROM services WHERE deleted_at IS NULL ORDER BY sort_order, created_at')).map(mapService) });
});
adminContentRouter.post('/services', requireAdmin, async (req, res) => {
  const b = parse(serviceBody, req.body);
  const r = await queryOne(
    `INSERT INTO services (name, description, price, duration_minutes, image_url, is_active, is_featured, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(max(sort_order),0)+1 FROM services)) RETURNING *`,
    [b.name, b.description, b.price, b.durationMinutes, b.imageUrl ?? null, b.isActive, b.isFeatured],
  );
  await audit(adminActor(req), 'service.create', 'service', r.id, { name: b.name });
  res.status(201).json({ service: mapService(r) });
});
adminContentRouter.post('/services/reorder', requireAdmin, async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(200) }), req.body);
  await withTransaction(async (c) => { for (let i = 0; i < ids.length; i++) await query('UPDATE services SET sort_order = $2 WHERE id = $1', [ids[i], i + 1], c); });
  res.json({ ok: true });
});
adminContentRouter.patch('/services/:id', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(serviceBody.partial(), req.body);
  const cur = await queryOne('SELECT * FROM services WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!cur) throw notFound('Service not found.');
  // Existing appointments keep their own snapshot of name/price/duration, so editing is always safe.
  const r = await queryOne(
    `UPDATE services SET name=$2, description=$3, price=$4, duration_minutes=$5, image_url=$6, is_active=$7, is_featured=$8, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, b.name ?? cur.name, b.description ?? cur.description, b.price ?? cur.price, b.durationMinutes ?? cur.duration_minutes,
     b.imageUrl === undefined ? cur.image_url : b.imageUrl, b.isActive ?? cur.is_active, b.isFeatured ?? cur.is_featured],
  );
  await audit(adminActor(req), 'service.update', 'service', id, { fields: Object.keys(b) });
  res.json({ service: mapService(r) });
});
adminContentRouter.delete('/services/:id', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const r = await queryOne('UPDATE services SET deleted_at = now(), is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
  if (!r) throw notFound('Service not found.');
  await audit(adminActor(req), 'service.delete', 'service', id);
  res.json({ ok: true });
});

// ---- uploads -------------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
adminContentRouter.post('/uploads', requireAdmin, upload.single('file'), async (req, res) => {
  const kind = parse(z.enum(['gallery', 'service', 'logo', 'hero']), req.body?.kind);
  if (!req.file) throw badRequest('Choose an image to upload.');
  const saved = await saveImage(req.file.buffer, kind);
  await audit(adminActor(req), 'upload.create', 'upload', saved.storagePath);
  res.status(201).json(saved);
});

// ---- gallery -------------------------------------------------------------------------------
const mapGallery = (r: any) => ({ id: r.id, url: r.url, caption: r.caption, sortOrder: r.sort_order, isActive: r.is_active });
adminContentRouter.get('/gallery', requireStaff, async (_req, res) => {
  res.json({ items: (await query('SELECT * FROM gallery_images ORDER BY sort_order, created_at')).map(mapGallery) });
});
adminContentRouter.post('/gallery', requireAdmin, async (req, res) => {
  const b = parse(z.object({ url: z.string().url().max(500), storagePath: z.string().max(300).nullable().optional(), caption: z.string().trim().max(200).default('') }), req.body);
  const r = await queryOne(`INSERT INTO gallery_images (url, storage_path, caption, sort_order) VALUES ($1,$2,$3,(SELECT COALESCE(max(sort_order),0)+1 FROM gallery_images)) RETURNING *`, [b.url, b.storagePath ?? null, b.caption]);
  await audit(adminActor(req), 'gallery.create', 'gallery', r.id);
  res.status(201).json({ image: mapGallery(r) });
});
adminContentRouter.post('/gallery/reorder', requireAdmin, async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(500) }), req.body);
  await withTransaction(async (c) => { for (let i = 0; i < ids.length; i++) await query('UPDATE gallery_images SET sort_order = $2 WHERE id = $1', [ids[i], i + 1], c); });
  res.json({ ok: true });
});
adminContentRouter.patch('/gallery/:id', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(z.object({ caption: z.string().trim().max(200).optional(), isActive: z.boolean().optional() }), req.body);
  const r = await queryOne(`UPDATE gallery_images SET caption = COALESCE($2, caption), is_active = COALESCE($3, is_active) WHERE id = $1 RETURNING *`, [id, b.caption ?? null, b.isActive ?? null]);
  if (!r) throw notFound('Image not found.');
  await audit(adminActor(req), 'gallery.update', 'gallery', id);
  res.json({ image: mapGallery(r) });
});
adminContentRouter.delete('/gallery/:id', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const r = await queryOne('DELETE FROM gallery_images WHERE id = $1 RETURNING storage_path', [id]);
  if (!r) throw notFound('Image not found.');
  await deleteStored(r.storage_path);
  await audit(adminActor(req), 'gallery.delete', 'gallery', id);
  res.json({ ok: true });
});

// ---- FAQs ----------------------------------------------------------------------------------
const mapFaq = (r: any) => ({ id: r.id, question: r.question, answer: r.answer, sortOrder: r.sort_order, isActive: r.is_active });
const faqBody = z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(3000), isActive: z.boolean().default(true) });
adminContentRouter.get('/faqs', requireStaff, async (_req, res) => res.json({ items: (await query('SELECT * FROM faqs ORDER BY sort_order, question')).map(mapFaq) }));
adminContentRouter.post('/faqs', requireAdmin, async (req, res) => {
  const b = parse(faqBody, req.body);
  const r = await queryOne(`INSERT INTO faqs (question, answer, is_active, sort_order) VALUES ($1,$2,$3,(SELECT COALESCE(max(sort_order),0)+1 FROM faqs)) RETURNING *`, [b.question, b.answer, b.isActive]);
  await audit(adminActor(req), 'faq.create', 'faq', r.id);
  res.status(201).json({ faq: mapFaq(r) });
});
adminContentRouter.patch('/faqs/:id', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(faqBody.partial(), req.body);
  const r = await queryOne(`UPDATE faqs SET question = COALESCE($2, question), answer = COALESCE($3, answer), is_active = COALESCE($4, is_active) WHERE id = $1 RETURNING *`, [id, b.question ?? null, b.answer ?? null, b.isActive ?? null]);
  if (!r) throw notFound('FAQ not found.');
  await audit(adminActor(req), 'faq.update', 'faq', id);
  res.json({ faq: mapFaq(r) });
});
adminContentRouter.delete('/faqs/:id', requireAdmin, async (req, res) => {
  const id = parse(uuid, req.params.id);
  if (!(await queryOne('DELETE FROM faqs WHERE id = $1 RETURNING id', [id]))) throw notFound('FAQ not found.');
  await audit(adminActor(req), 'faq.delete', 'faq', id);
  res.json({ ok: true });
});
