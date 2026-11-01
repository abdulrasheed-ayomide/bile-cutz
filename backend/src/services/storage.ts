import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../config/env.js';
import { badRequest } from '../lib/errors.js';
import { UPLOAD_DIR } from '../app.js';

const MAX_DIMENSIONS: Record<string, { width: number; height: number }> = {
  gallery: { width: 2000, height: 2000 },
  service: { width: 1200, height: 1200 },
  logo: { width: 1000, height: 1000 },
  hero: { width: 2400, height: 1400 },
};

/** Detects the real image type from magic bytes — the client-declared type/extension is never trusted. */
export function sniffImage(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

export async function saveImage(buf: Buffer, kind: string): Promise<{ url: string; storagePath: string }> {
  const type = sniffImage(buf);
  if (!type) throw badRequest('Only JPEG, PNG or WebP images are allowed.');
  const dimensions = MAX_DIMENSIONS[kind];
  if (!dimensions) throw badRequest('Unsupported image category.');
  let processed: Buffer;
  try {
    const options = { failOn: 'error' as const, limitInputPixels: 40_000_000 };
    const metadata = await sharp(buf, options).metadata();
    if (metadata.format !== type) throw new Error('Image format does not match its signature.');
    processed = await sharp(buf, options)
      .rotate()
      .resize({ ...dimensions, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch {
    throw badRequest('The uploaded file is not a valid image.');
  }
  const name = `${kind}/${crypto.randomBytes(16).toString('hex')}.webp`;
  if (env.STORAGE_PROVIDER === 'supabase') {
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_STORAGE_BUCKET}/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'image/webp', 'x-upsert': 'false' },
      body: new Uint8Array(processed),
    });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status})`);
    return { url: `${env.SUPABASE_URL}/storage/v1/object/public/${env.SUPABASE_STORAGE_BUCKET}/${name}`, storagePath: name };
  }
  const full = path.join(UPLOAD_DIR, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, processed);
  return { url: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/uploads/${name}`, storagePath: name };
}

export async function deleteStored(storagePath: string | null | undefined) {
  if (!storagePath || storagePath.includes('..')) return;
  try {
    if (env.STORAGE_PROVIDER === 'supabase') {
      await fetch(`${env.SUPABASE_URL}/storage/v1/object/${env.SUPABASE_STORAGE_BUCKET}/${storagePath}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      });
    } else fs.rmSync(path.join(UPLOAD_DIR, storagePath), { force: true });
  } catch { /* best effort */ }
}
