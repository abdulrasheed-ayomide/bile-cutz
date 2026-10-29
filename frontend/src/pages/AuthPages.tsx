import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Field, Spinner } from '../components/ui';
import { ApiError, api, errMsg } from '../lib/api';
import { useAdminAuth, useCustomerAuth } from '../lib/auth';
import { Brand } from '../components/layouts';

function useForm<T extends Record<string, string>>(initial: T) {
  const [v, setV] = useState(initial);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bind = (k: keyof T & string) => ({ id: k, value: v[k], error: fields[k], onChange: (e: any) => setV({ ...v, [k]: e.target.value }) });
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(''); setFields({});
    try { await fn(); } catch (e) { setError(errMsg(e)); if (e instanceof ApiError && e.details?.fields) setFields(e.details.fields); } finally { setBusy(false); }
  }
  return { v, bind, run, error, busy, setError };
}

export function LoginPage() {
  const { user, login, loading } = useCustomerAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as any)?.from ?? '/account';
  const f = useForm({ email: '', password: '' });
  if (loading) return <Spinner />;
  if (user) return <Navigate to="/account" replace />;
  const submit = (e: FormEvent) => { e.preventDefault(); f.run(async () => { await login(f.v.email, f.v.password); nav(from, { replace: true }); }); };
  return (
    <div className="wrap"><form className="auth-box panel" onSubmit={submit} noValidate>
      <h1 style={{ fontSize: '2.4rem' }}>Sign in</h1>
      {f.error && <div className="alert alert-error" role="alert">{f.error}</div>}
      <Field {...f.bind('email')} label="Email" type="email" autoComplete="email" required />
      <Field {...f.bind('password')} label="Password" type="password" autoComplete="current-password" required />
      <button className="btn btn-primary btn-block" disabled={f.busy}>{f.busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="small" style={{ marginTop: '1rem' }}><Link to="/forgot-password">Forgot your password?</Link></p>
      <p className="small muted">New here? <Link to="/register">Create an account</Link> or <Link to="/book">book as a guest</Link>.</p>
    </form></div>
  );
}

export function RegisterPage() {
  const { user, register, loading } = useCustomerAuth();
  const nav = useNavigate();
  const f = useForm({ fullName: '', email: '', phone: '', password: '', confirmPassword: '' });
  if (loading) return <Spinner />;
  if (user) return <Navigate to="/account" replace />;
  const submit = (e: FormEvent) => { e.preventDefault(); f.run(async () => { await register(f.v); nav('/account', { replace: true }); }); };
  return (
    <div className="wrap"><form className="auth-box panel" onSubmit={submit} noValidate>
      <h1 style={{ fontSize: '2.4rem' }}>Create your account</h1>
      {f.error && <div className="alert alert-error" role="alert">{f.error}</div>}
      <Field {...f.bind('fullName')} label="Full name" autoComplete="name" required />
      <Field {...f.bind('email')} label="Email" type="email" autoComplete="email" required hint="You’ll use this to sign in." />
      <Field {...f.bind('phone')} label="Phone (optional)" type="tel" autoComplete="tel" />
      <Field {...f.bind('password')} label="Password" type="password" autoComplete="new-password" hint="At least 8 characters, with a letter and a number." required />
      <Field {...f.bind('confirmPassword')} label="Confirm password" type="password" autoComplete="new-password" required />
      <button className="btn btn-primary btn-block" disabled={f.busy}>{f.busy ? 'Creating account…' : 'Create account'}</button>
      <p className="small muted" style={{ marginTop: '1rem' }}>Already registered? <Link to="/login">Sign in</Link></p>
    </form></div>
  );
}

function ForgotForm({ admin }: { admin?: boolean }) {
  const f = useForm({ email: '' });
  const [sent, setSent] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); f.run(async () => { await api(admin ? '/admin/auth/forgot-password' : '/auth/forgot-password', { body: { email: f.v.email } }); setSent(true); }); };
  return (
    <div className="wrap"><form className="auth-box panel" onSubmit={submit} noValidate>
      <h1 style={{ fontSize: '2.2rem' }}>Reset your password</h1>
      {sent ? <div className="alert alert-ok" role="status">If an account exists for that email, we’ve sent a reset link. It expires in 1 hour.</div> : <>
        {f.error && <div className="alert alert-error" role="alert">{f.error}</div>}
        <p className="muted">Enter your email and we’ll send you a link to choose a new password.</p>
        <Field {...f.bind('email')} label="Email" type="email" autoComplete="email" required />
        <button className="btn btn-primary btn-block" disabled={f.busy}>{f.busy ? 'Sending…' : 'Send reset link'}</button></>}
      <p className="small" style={{ marginTop: '1rem' }}><Link to={admin ? '/admin/login' : '/login'}>Back to sign in</Link></p>
    </form></div>
  );
}
export const ForgotPasswordPage = () => <ForgotForm />;
export const AdminForgotPasswordPage = () => <ForgotForm admin />;

function ResetForm({ admin }: { admin?: boolean }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const f = useForm({ password: '', confirmPassword: '' });
  const [done, setDone] = useState(false);
  const submit = (e: FormEvent) => { e.preventDefault(); f.run(async () => { await api(admin ? '/admin/auth/reset-password' : '/auth/reset-password', { body: { token, ...f.v } }); setDone(true); }); };
  return (
    <div className="wrap"><form className="auth-box panel" onSubmit={submit} noValidate>
      <h1 style={{ fontSize: '2.2rem' }}>Choose a new password</h1>
      {!token ? <div className="alert alert-error">This link is incomplete. Request a new reset link.</div> : done ? <div className="alert alert-ok" role="status">Password updated. You can now <Link to={admin ? '/admin/login' : '/login'}>sign in</Link>.</div> : <>
        {f.error && <div className="alert alert-error" role="alert">{f.error}</div>}
        <Field {...f.bind('password')} label="New password" type="password" autoComplete="new-password" hint="At least 8 characters, with a letter and a number." required />
        <Field {...f.bind('confirmPassword')} label="Confirm new password" type="password" autoComplete="new-password" required />
        <button className="btn btn-primary btn-block" disabled={f.busy}>{f.busy ? 'Saving…' : 'Save new password'}</button></>}
    </form></div>
  );
}
export const ResetPasswordPage = () => <ResetForm />;
export const AdminResetPasswordPage = () => <ResetForm admin />;

export function AdminLoginPage() {
  const { user, login, loading } = useAdminAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const f = useForm({ email: '', password: '' });
  if (loading) return <Spinner />;
  if (user) return <Navigate to="/admin" replace />;
  const submit = (e: FormEvent) => { e.preventDefault(); f.run(async () => { await login(f.v.email, f.v.password); nav((loc.state as any)?.from ?? '/admin', { replace: true }); }); };
  return (
    <div className="wrap" style={{ paddingTop: '2rem' }}>
      <div style={{ textAlign: 'center' }}><Brand to="/admin/login" /></div>
      <form className="auth-box panel" style={{ marginTop: '1.5rem' }} onSubmit={submit} noValidate>
        <h1 style={{ fontSize: '2rem' }}>Shop sign in</h1>
        {f.error && <div className="alert alert-error" role="alert">{f.error}</div>}
        <Field {...f.bind('email')} label="Email" type="email" autoComplete="username" required />
        <Field {...f.bind('password')} label="Password" type="password" autoComplete="current-password" required />
        <button className="btn btn-primary btn-block" disabled={f.busy}>{f.busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="small" style={{ marginTop: '1rem' }}><Link to="/admin/forgot-password">Forgot your password?</Link></p>
      </form>
    </div>
  );
}
