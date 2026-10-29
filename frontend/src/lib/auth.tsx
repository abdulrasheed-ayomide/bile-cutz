import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrf } from './api';
import type { User } from './types';

interface AuthState { user: User | null; loading: boolean; login: (email: string, password: string) => Promise<User>; register: (b: any) => Promise<User>; logout: () => Promise<void>; setUser: (u: User) => void }

function make(scope: 'customer' | 'admin') {
  const prefix = scope === 'admin' ? '/admin/auth' : '/auth';
  const Ctx = createContext<AuthState>(null as any);
  function Provider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
      api<{ user: User; csrfToken: string }>(`${prefix}/me`).then((r) => { setCsrf(scope, r.csrfToken); setUser(r.user); }).catch(() => setUser(null)).finally(() => setLoading(false));
    }, []);
    const login = useCallback(async (email: string, password: string) => {
      const r = await api<{ user: User; csrfToken: string }>(`${prefix}/login`, { body: { email, password } });
      setCsrf(scope, r.csrfToken); setUser(r.user); return r.user;
    }, []);
    const register = useCallback(async (b: any) => {
      const r = await api<{ user: User; csrfToken: string }>(`${prefix}/register`, { body: b });
      setCsrf(scope, r.csrfToken); setUser(r.user); return r.user;
    }, []);
    const logout = useCallback(async () => { await api(`${prefix}/logout`, { method: 'POST', body: {} }).catch(() => {}); setCsrf(scope, null); setUser(null); }, []);
    const value = useMemo(() => ({ user, loading, login, register, logout, setUser }), [user, loading, login, register, logout]);
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  }
  return { Provider, use: () => useContext(Ctx) };
}

const customer = make('customer');
const admin = make('admin');
export const CustomerAuthProvider = customer.Provider;
export const useCustomerAuth = customer.use;
export const AdminAuthProvider = admin.Provider;
export const useAdminAuth = admin.use;
