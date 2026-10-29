import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type T = { id: number; kind: 'ok' | 'error'; text: string };
const Ctx = createContext<(kind: 'ok' | 'error', text: string) => void>(() => {});
export const useToast = () => useContext(Ctx);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const push = useCallback((kind: 'ok' | 'error', text: string) => {
    const id = ++seq;
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 5000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </Ctx.Provider>
  );
}
