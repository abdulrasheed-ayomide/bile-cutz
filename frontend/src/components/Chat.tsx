import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errMsg } from '../lib/api';
import { clockTime } from '../lib/format';
import { useSocket } from '../lib/socket';
import type { Message } from '../lib/types';
import { Spinner } from './ui';

type Local = Message & { state?: 'sending' | 'failed' };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/**
 * One private conversation thread. Messages persist server-side; the socket only adds live delivery.
 * On (re)connect we fetch anything missed with ?after=<lastId>, and sends are idempotent via clientMessageId.
 */
export function ChatThread({ conversationId, side, title, onBack }: { conversationId: string; side: 'customer' | 'staff'; title: string; onBack?: () => void }) {
  const base = side === 'customer' ? '/chat' : '/admin/chat';
  const { socket, state } = useSocket();
  const [msgs, setMsgs] = useState<Local[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const merge = useCallback((incoming: Message[]) => {
    setMsgs((cur) => {
      const byId = new Map(cur.map((m) => [m.clientMessageId ?? `id:${m.id}`, m]));
      for (const m of incoming) byId.set(m.clientMessageId ?? `id:${m.id}`, m);
      return [...byId.values()].sort((a, b) => (a.state ? 1 : 0) - (b.state ? 1 : 0) || a.id - b.id);
    });
  }, []);
  const markRead = useCallback(() => { api(`${base}/conversations/${conversationId}/read`, { method: 'POST', body: {} }).then(() => window.dispatchEvent(new Event(side === 'customer' ? 'chat:changed' : 'admin:changed'))).catch(() => {}); }, [base, conversationId, side]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setMsgs([]); setError('');
    api<{ items: Message[]; hasMore: boolean }>(`${base}/conversations/${conversationId}/messages`, { query: { limit: 30 } })
      .then((r) => { if (!alive) return; setMsgs(r.items); setMore(r.hasMore); markRead(); })
      .catch((e) => alive && setError(errMsg(e))).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [base, conversationId, markRead]);

  // live messages
  useEffect(() => {
    if (!socket) return;
    const onMsg = ({ message }: { message: Message }) => {
      if (message.conversationId !== conversationId) return;
      merge([message]);
      if (message.senderRole !== (side === 'customer' ? 'customer' : 'staff')) markRead();
    };
    socket.on('message:new', onMsg);
    return () => { socket.off('message:new', onMsg); };
  }, [socket, conversationId, side, merge, markRead]);

  // catch up after a reconnect
  const lastId = useRef(0);
  lastId.current = msgs.filter((m) => !m.state).at(-1)?.id ?? 0;
  useEffect(() => {
    if (state !== 'online') return;
    api<{ items: Message[] }>(`${base}/conversations/${conversationId}/messages`, { query: { after: lastId.current } }).then((r) => r.items.length && merge(r.items)).catch(() => {});
  }, [state, base, conversationId, merge]);

  useEffect(() => { if (stick.current) log.current?.scrollTo({ top: log.current.scrollHeight }); }, [msgs]);

  async function loadOlder() {
    const first = msgs.find((m) => !m.state);
    if (!first) return;
    const r = await api<{ items: Message[]; hasMore: boolean }>(`${base}/conversations/${conversationId}/messages`, { query: { before: first.id, limit: 30 } });
    stick.current = false; merge(r.items); setMore(r.hasMore);
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText(''); stick.current = true;
    await deliver(body, uid());
  }
  async function deliver(body: string, clientMessageId: string) {
    const temp: Local = { id: Number.MAX_SAFE_INTEGER, conversationId, senderId: '', senderRole: side === 'customer' ? 'customer' : 'staff', body, clientMessageId, createdAt: new Date().toISOString(), readAt: null, state: 'sending' };
    setMsgs((c) => [...c.filter((m) => m.clientMessageId !== clientMessageId), temp]);
    try {
      // REST is the reliable path: the message is stored before we get a response.
      const r = await api<{ message: Message }>(`${base}/conversations/${conversationId}/messages`, { body: { body, clientMessageId } });
      merge([r.message]);
    } catch {
      setMsgs((c) => c.map((m) => (m.clientMessageId === clientMessageId ? { ...m, state: 'failed' } : m)));
    }
  }
  const mine = (m: Message) => m.senderRole === (side === 'customer' ? 'customer' : 'staff');

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="row">{onBack && <button className="btn btn-ghost btn-sm" onClick={onBack} aria-label="Back to conversations">‹</button>}<strong>{title}</strong></span>
        <span className="small muted" role="status">{state === 'online' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Offline — messages still send'}</span>
      </div>
      <div className="chat-log" ref={log} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-live="polite">
        {loading ? <Spinner /> : error ? <div className="alert alert-error">{error}</div> : (
          <>
            {more && <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'center' }} onClick={loadOlder}>Load earlier messages</button>}
            {msgs.length === 0 && <p className="muted center">No messages yet. {side === 'customer' ? 'Say hello — we’ll reply here.' : 'Write the first reply below.'}</p>}
            {msgs.map((m) => (
              <div key={m.clientMessageId ?? m.id} className={`bubble ${mine(m) ? 'mine' : ''} ${m.state === 'sending' ? 'pending' : ''} ${m.state === 'failed' ? 'failed' : ''}`}>
                {m.body}
                <time>{m.state === 'sending' ? 'Sending…' : m.state === 'failed' ? <>Not sent · <button className="link-btn" onClick={() => deliver(m.body, m.clientMessageId!)}>Retry</button></> : clockTime(m.createdAt)}{!m.state && mine(m) && m.readAt ? ' · Seen' : ''}</time>
              </div>))}
          </>)}
      </div>
      <form className="chat-form" onSubmit={send}>
        <label className="sr-only" htmlFor="chat-input">Message</label>
        <textarea id="chat-input" value={text} maxLength={2000} placeholder="Type a message" rows={1} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={!text.trim()}>Send</button>
      </form>
    </div>
  );
}
