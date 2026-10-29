import fs from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Email adapter.
 *  - smtp:        real delivery (required in production; enforced at startup).
 *  - dev-outbox:  development ONLY. Writes each email as JSON to backend/.dev-outbox so you can copy
 *                 a reset link without SMTP. The env validator refuses this provider in production, so
 *                 reset tokens can never be written to disk by accident on a live deployment.
 * Message bodies (which contain reset links) are never logged.
 */
let transporter: Transporter | null = null;

export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (env.EMAIL_PROVIDER === 'dev-outbox') {
    if (env.isProd) throw new Error('dev-outbox email provider is disabled in production');
    const dir = path.resolve(process.cwd(), '.dev-outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...msg, createdAt: new Date().toISOString() }, null, 2));
    logger.info('email written to dev outbox', { subject: msg.subject });
    return;
  }
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  await transporter.sendMail({ from: env.EMAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  logger.info('email sent', { subject: msg.subject });
}

/** Fire-and-forget wrapper: a mail failure must never fail the user's request. */
export function sendEmailSafe(msg: EmailMessage): void {
  sendEmail(msg).catch((err) => logger.error('email send failed', { subject: msg.subject, error: (err as Error).message }));
}
