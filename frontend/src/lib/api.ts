export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || '').replace(/\/$/, '') || undefined;

/** CSRF tokens are kept in memory only (never localStorage) — one per session scope. */
const csrf: Record<'customer' | 'admin', string | null> = { customer: null, admin: null };
export const setCsrf = (scope: 'customer' | 'admin', t: string | null) => { csrf[scope] = t; };

type Opts = { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined | null>; form?: FormData };

function scopeOf(path: string): 'customer' | 'admin' { return path.startsWith('/admin') ? 'admin' : 'customer'; }

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const q = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
  const method = opts.method ?? (opts.body || opts.form ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const scope = scopeOf(path);
  // Public booking is made with the customer session if there is one.
  if (method !== 'GET' && csrf[scope]) headers['X-CSRF-Token'] = csrf[scope]!;
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}${q ? `?${q}` : ''}`, { method, headers, credentials: 'include', body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Something went wrong. Please try again.', e?.details);
  }
  return data as T;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
