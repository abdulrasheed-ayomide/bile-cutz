import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAdminAuth, useCustomerAuth } from '../lib/auth';
import { useSettings } from '../lib/settings';
import { socialLinks } from '../lib/socialLinks';
import { useSocket, SocketProvider } from '../lib/socket';
import type { Notification } from '../lib/types';
import { Spinner } from './ui';

export function Brand({ to = '/' }: { to?: string }) {
  const { settings } = useSettings();
  const b = settings?.business;
  return (
    <Link to={to} className="brand" aria-label={`${b?.name ?? 'Bile Cutz'} home`}>
      {b?.logoUrl ? <img src={b.logoUrl} alt="" /> : <span className="brand-pole" aria-hidden />}
      {b?.name ?? 'Bile Cutz'}
    </Link>
  );
}

function SocialIcon({ platform }: { platform: (typeof socialLinks)[number]['platform'] }) {
  const common = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true as const };
  if (platform === 'Facebook') return <svg {...common}><path d="M13.5 21v-8h2.7l.4-3h-3.1V8.1c0-.9.3-1.6 1.6-1.6h1.7V3.8c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3V10H7.3v3h2.8v8h3.4Z" /></svg>;
  if (platform === 'Instagram') return <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.8" r=".8" fill="currentColor" stroke="none" /></svg>;
  if (platform === 'TikTok') return <svg {...common}><path d="M19.6 8.2a6.8 6.8 0 0 1-4.2-1.5v8.1a5.6 5.6 0 1 1-4.8-5.5v3.2a2.5 2.5 0 1 0 1.7 2.3V3h3.1c.2 2.2 1.8 3.9 4.2 4.2v1Z" /></svg>;
  return <svg {...common}><path d="M18.9 3H22l-6.8 7.8L23.2 21h-6.3L12 14.8 6.5 21H3.4l7.2-8.3L2.8 3h6.5l4.5 5.9L18.9 3Zm-1.1 16h1.7L8.3 4.9H6.5L17.8 19Z" /></svg>;
}

/** Scroll to top on navigation. */
function ScrollTop() { const { pathname } = useLocation(); useEffect(() => { window.scrollTo(0, 0); }, [pathname]); return null; }

export function PublicLayout() {
  const { user, logout } = useCustomerAuth();
  const { settings, error } = useSettings();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const b = settings?.business;
  const configuredSocialLinks = socialLinks.filter((social) => social.url.trim());
  return (
    <>
      <ScrollTop />
      <a className="skip" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="wrap">
          <Brand />
          <button className="nav-toggle" aria-expanded={open} aria-controls="site-nav" aria-label="Menu" onClick={() => setOpen(!open)}>{open ? '✕' : '☰'}</button>
          <nav id="site-nav" className={`nav ${open ? 'open' : ''}`} aria-label="Main">
            <NavLink to="/services">Services</NavLink>
            <NavLink to="/gallery">Gallery</NavLink>
            <NavLink to="/reviews">Reviews</NavLink>
            <NavLink to="/about">About</NavLink>
            <NavLink to="/faq">FAQ</NavLink>
            <NavLink to="/contact">Contact</NavLink>
            {user ? (
              <>
                <NavLink to="/account">{user.fullName.split(' ')[0]}</NavLink>
                <button className="nav-link" onClick={() => logout()}>Sign out</button>
              </>
            ) : <NavLink to="/login">Sign in</NavLink>}
            <Link to="/book" className="btn btn-primary btn-sm">Book an appointment</Link>
          </nav>
        </div>
      </header>
      <main id="main">
        {error && !settings ? <div className="wrap section"><div className="alert alert-error" role="alert">We couldn’t load the shop details. Please refresh the page.</div></div> : <Outlet />}
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <div className="footer-grid">
            <div><Brand /><p className="muted" style={{ marginTop: '.75rem', maxWidth: '32ch' }}>{b?.tagline}</p></div>
            <div><h4>Visit</h4><p className="muted" style={{ whiteSpace: 'pre-line' }}>{b?.address}</p></div>
            <div><h4>Contact</h4><ul>
              {b?.phone && <li><a href={`tel:${b.phone.replace(/\s/g, '')}`}>{b.phone}</a></li>}
              {b?.email && <li><a href={`mailto:${b.email}`}>{b.email}</a></li>}
              {b?.whatsappLink && <li><a href={b.whatsappLink} target="_blank" rel="noopener noreferrer">Message on WhatsApp</a></li>}
            </ul>{configuredSocialLinks.length > 0 && <div className="row" aria-label="Social media" style={{ gap: '.65rem', marginTop: '.75rem' }}>
              {configuredSocialLinks.map((social) => <a key={social.platform} href={social.url} target="_blank" rel="noopener noreferrer" aria-label={social.platform} title={social.platform} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 32, minHeight: 32 }}><SocialIcon platform={social.platform} /></a>)}
            </div>}</div>
            <div><h4>Explore</h4><ul>
              <li><Link to="/book">Book an appointment</Link></li><li><Link to="/services">Services</Link></li><li><Link to="/faq">FAQ</Link></li><li><Link to="/register">Create an account</Link></li>
            </ul></div>
          </div>
          <div className="legal">© {new Date().getFullYear()} {b?.name}. Payment is made at the shop.</div>
        </div>
      </footer>
    </>
  );
}

/* ---------------- Customer account ---------------- */
function useUnread(scope: 'customer' | 'admin') {
  const [count, setCount] = useState(0);
  const { socket } = useSocket();
  const base = scope === 'admin' ? '/admin/notifications' : '/notifications';
  useEffect(() => {
    const load = () => api<{ unreadCount: number }>(`${base}/unread-count`).then((r) => setCount(r.unreadCount)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    const on = (_p: { notification: Notification }) => load();
    socket?.on('notification:new', on);
    window.addEventListener('notifications:changed', load);
    return () => { clearInterval(t); socket?.off('notification:new', on); window.removeEventListener('notifications:changed', load); };
  }, [socket, base]);
  return count;
}

function AccountMenu({ name, email, items, onLogout }: { name: string; email: string; items: { to: string; label: string }[]; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open]);
  return (
    <div className="menu">
      <button className="avatar" aria-haspopup="menu" aria-expanded={open} aria-label="Account menu" onClick={() => setOpen(!open)}>{name.trim()[0]?.toUpperCase()}</button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="who"><strong>{name}</strong><div className="muted small">{email}</div></div>
          {items.map((i) => <Link key={i.to} to={i.to} role="menuitem">{i.label}</Link>)}
          <button role="menuitem" onClick={onLogout}>Sign out</button>
        </div>
      )}
    </div>
  );
}

const ICON = { bell: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></svg> };

export function AccountLayout() {
  const { user, loading, logout } = useCustomerAuth();
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setMenu(false), [loc.pathname]);
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return (
    <SocketProvider scope="customer" enabled>
      <AccountShell menu={menu} setMenu={setMenu} onLogout={async () => { await logout(); nav('/'); }} />
    </SocketProvider>
  );
}

function AccountShell({ menu, setMenu, onLogout }: { menu: boolean; setMenu: (b: boolean) => void; onLogout: () => void }) {
  const { user } = useCustomerAuth();
  const unread = useUnread('customer');
  const [chatUnread, setChatUnread] = useState(0);
  const { socket } = useSocket();
  useEffect(() => {
    const load = () => api<{ conversation: { unreadCount: number } }>('/chat/conversation').then((r) => setChatUnread(r.conversation.unreadCount)).catch(() => {});
    load();
    socket?.on('message:new', load); socket?.on('messages:read', load);
    window.addEventListener('chat:changed', load);
    return () => { socket?.off('message:new', load); socket?.off('messages:read', load); window.removeEventListener('chat:changed', load); };
  }, [socket]);
  const link = (to: string, label: string, end = false, n = 0) => <NavLink to={to} end={end} className="side-link">{label}{n > 0 && <span className="count">{n}</span>}</NavLink>;
  return (
    <div className="shell">
      <ScrollTop />
      <div className={`shell-scrim ${menu ? 'open' : ''}`} onClick={() => setMenu(false)} />
      <aside className={`sidebar ${menu ? 'open' : ''}`} aria-label="Account">
        <Brand />
        <nav>
          {link('/account', 'Overview', true)}
          {link('/account/appointments', 'My appointments')}
          {link('/account/messages', 'Messages', false, chatUnread)}
          {link('/account/notifications', 'Notifications', false, unread)}
          {link('/account/profile', 'Profile & password')}
          <div className="side-group">Shop</div>
          <Link className="side-link" to="/book">Book an appointment</Link>
          <Link className="side-link" to="/">Back to website</Link>
        </nav>
      </aside>
      <div className="shell-main">
        <div className="topbar no-print">
          <button className="btn btn-ghost btn-sm menu-btn" aria-label="Open menu" onClick={() => setMenu(true)}>☰</button>
          <span className="grow">Welcome back, <strong>{user!.fullName}</strong></span>
          <Link to="/account/notifications" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>{ICON.bell}{unread > 0 && <span className="count">{unread}</span>}</Link>
          <AccountMenu name={user!.fullName} email={user!.email} items={[{ to: '/account', label: 'My account' }, { to: '/account/profile', label: 'Profile & password' }]} onLogout={onLogout} />
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

/* ---------------- Admin ---------------- */
export function AdminLayout() {
  const { user, loading, logout } = useAdminAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [loc.pathname]);
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/admin/login" state={{ from: loc.pathname }} replace />;
  return (
    <SocketProvider scope="admin" enabled>
      <AdminShell menu={menu} setMenu={setMenu} onLogout={async () => { await logout(); nav('/admin/login'); }} />
    </SocketProvider>
  );
}

function AdminShell({ menu, setMenu, onLogout }: { menu: boolean; setMenu: (b: boolean) => void; onLogout: () => void }) {
  const { user } = useAdminAuth();
  const unread = useUnread('admin');
  const [chat, setChat] = useState(0);
  const [pending, setPending] = useState(0);
  const { socket } = useSocket();
  useEffect(() => {
    const load = () => api<any>('/admin/dashboard/summary').then((r) => { setChat(r.unreadConversations); setPending(r.pendingApprovals); }).catch(() => {});
    load();
    const ev = ['message:new', 'messages:read', 'notification:new'];
    ev.forEach((e) => socket?.on(e, load));
    window.addEventListener('admin:changed', load);
    const t = setInterval(load, 60_000);
    return () => { ev.forEach((e) => socket?.off(e, load)); window.removeEventListener('admin:changed', load); clearInterval(t); };
  }, [socket]);
  const isAdmin = user!.role === 'admin';
  const L = (to: string, label: string, n = 0, end = false) => <NavLink to={to} end={end} className="side-link">{label}{n > 0 && <span className="count">{n}</span>}</NavLink>;
  return (
    <div className="shell">
      <ScrollTop />
      <div className={`shell-scrim ${menu ? 'open' : ''}`} onClick={() => setMenu(false)} />
      <aside className={`sidebar ${menu ? 'open' : ''}`} aria-label="Admin">
        <Brand to="/admin" />
        <nav>
          {L('/admin', 'Dashboard', 0, true)}
          <div className="side-group">Bookings</div>
          {L('/admin/appointments', 'Appointments', pending)}
          {L('/admin/calendar', 'Calendar')}
          {L('/admin/bookings/new', 'New booking')}
          <div className="side-group">People</div>
          {L('/admin/customers', 'Customers')}
          {L('/admin/messages', 'Messages', chat)}
          {L('/admin/reviews', 'Reviews')}
          <div className="side-group">Shop</div>
          {L('/admin/services', 'Services')}
          {L('/admin/gallery', 'Gallery')}
          {L('/admin/faqs', 'FAQs')}
          {isAdmin && L('/admin/settings', 'Settings')}
          {isAdmin && L('/admin/system', 'System')}
          {L('/admin/notifications', 'Notifications', unread)}
        </nav>
      </aside>
      <div className="shell-main">
        <div className="topbar no-print">
          <button className="btn btn-ghost btn-sm menu-btn" aria-label="Open menu" onClick={() => setMenu(true)}>☰</button>
          <span className="grow muted small">Shop dashboard</span>
          <Link to="/admin/notifications" className="bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>{ICON.bell}{unread > 0 && <span className="count">{unread}</span>}</Link>
          <AccountMenu name={user!.fullName} email={`${user!.email} · ${user!.role === 'admin' ? 'Owner' : 'Staff'}`} items={[...(isAdmin ? [{ to: '/admin/settings', label: 'Settings' }] : []), { to: '/admin/profile', label: 'Profile' }, { to: '/', label: 'View website' }]} onLogout={onLogout} />
        </div>
        <div className="content"><Outlet /></div>
      </div>
    </div>
  );
}

export const PageTitle = ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
  <div className="row between" style={{ marginBottom: '1.25rem' }}><h1 style={{ fontSize: 'clamp(1.8rem,4vw,2.6rem)', margin: 0 }}>{children}</h1>{actions && <div className="row">{actions}</div>}</div>
);
