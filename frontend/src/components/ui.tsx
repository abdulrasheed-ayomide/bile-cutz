import { useEffect, useRef, useState, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { STATUS_LABEL } from '../lib/format';
import type { Status } from '../lib/types';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="center" role="status"><span className="spinner" aria-hidden /><span className="sr-only">{label}</span></div>;
}
export const Badge = ({ status }: { status: Status | string }) => <span className={`badge badge-${status}`}>{STATUS_LABEL[status as Status] ?? status[0]!.toUpperCase() + status.slice(1)}</span>;
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => <div className="empty"><h3>{title}</h3>{children}</div>;
export const ErrorBox = ({ message, retry }: { message: string; retry?: () => void }) => (
  <div className="alert alert-error" role="alert">{message} {retry && <button className="link-btn" onClick={retry}>Try again</button>}</div>
);
export const Stars = ({ n }: { n: number }) => <span className="stars" role="img" aria-label={`${n} out of 5 stars`}>{'★'.repeat(n)}<span className="off">{'★'.repeat(5 - n)}</span></span>;

type FieldProps = { label: string; error?: string; hint?: string; id: string };
export function Field({ label, error, hint, id, ...p }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined} {...p} />
      {hint && !error && <span className="hint" id={`${id}-h`}>{hint}</span>}
      {error && <span className="err" id={`${id}-e`}>{error}</span>}
    </div>
  );
}
export function TextField({ label, error, hint, id, ...p }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} aria-invalid={!!error} aria-describedby={error ? `${id}-e` : undefined} {...p} />
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="err" id={`${id}-e`}>{error}</span>}
    </div>
  );
}
export function SelectField({ label, id, children, ...p }: { label: string; id: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  return <div className="field"><label htmlFor={id}>{label}</label><select id={id} {...p}>{children}</select></div>;
}

/** Accessible modal: focus trap-lite, Escape to close, focus restored on close. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('textarea,input,select,button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input,select,textarea')];
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}><h3>{title}</h3>{children}</div>
    </div>
  );
}

/** Asks for confirmation (and an optional reason) before a consequential action. */
export function ConfirmDialog({ title, message, confirmLabel, danger, askReason, onConfirm, onClose }: {
  title: string; message: ReactNode; confirmLabel: string; danger?: boolean; askReason?: boolean; onConfirm: (reason?: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{message}</p>
      {askReason && <TextField id="reason" label="Reason (optional)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Keep as is</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(reason.trim() || undefined); onClose(); } finally { setBusy(false); } }}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>{total === 0 ? 'No results' : `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`}</span>
      <span className="row">
        <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </span>
    </div>
  );
}

/** Tiny data hook: loads on mount / when deps change, exposes reload + error. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then((d) => { if (alive) { setData(d); setError(null); } }).catch((e) => alive && setError(e?.message ?? 'Failed to load')).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
