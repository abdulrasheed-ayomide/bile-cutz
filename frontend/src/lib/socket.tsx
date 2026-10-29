import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SOCKET_URL, api } from './api';

type Conn = 'connecting' | 'online' | 'offline';
const Ctx = createContext<{ socket: Socket | null; state: Conn }>({ socket: null, state: 'offline' });
export const useSocket = () => useContext(Ctx);

/** Opens an authenticated Socket.IO connection using a short-lived ticket from the REST API. */
export function SocketProvider({ scope, enabled, children }: { scope: 'customer' | 'admin'; enabled: boolean; children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [state, setState] = useState<Conn>('connecting');
  const ref = useRef<Socket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const path = scope === 'admin' ? '/admin/chat/socket-ticket' : '/chat/socket-ticket';
    const s = io(SOCKET_URL ?? window.location.origin, {
      // A fresh ticket is requested for EVERY (re)connection attempt; tickets live 60 seconds.
      auth: (cb) => { api<{ ticket: string }>(path, { method: 'POST', body: {} }).then((r) => cb({ ticket: r.ticket })).catch(() => cb({ ticket: '' })); },
      transports: ['websocket', 'polling'], reconnectionDelayMax: 8000,
    });
    ref.current = s;
    s.on('connect', () => !cancelled && setState('online'));
    s.on('disconnect', () => !cancelled && setState('offline'));
    s.on('connect_error', () => !cancelled && setState('offline'));
    setSocket(s);
    return () => { cancelled = true; s.close(); ref.current = null; setSocket(null); };
  }, [scope, enabled]);

  return <Ctx.Provider value={{ socket, state }}>{children}</Ctx.Provider>;
}
