import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { PublicSettings } from './types';

const Ctx = createContext<{ settings: PublicSettings | null; error: boolean; reload: () => void }>({ settings: null, error: false, reload: () => {} });
export const useSettings = () => useContext(Ctx);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [error, setError] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    api<PublicSettings>('/public/settings').then((s) => { setSettings(s); setError(false); document.title = `${s.business.name} — ${s.business.tagline}`; }).catch(() => setError(true));
  }, [n]);
  return <Ctx.Provider value={{ settings, error, reload: () => setN((x) => x + 1) }}>{children}</Ctx.Provider>;
}
