import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatClient } from '../client';
import { duration, type MessageRecord } from '../model';
export function Conversation({
  client,
  reading,
  showReaders,
}: {
  client: ChatClient;
  reading: boolean;
  showReaders: (message: MessageRecord) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const messages = client.messages;
  const signature = messages.map((m) => m.id).join(',');
  const room = client.selected ? client.store?.rooms.get(client.selected) : undefined;
  const history = client.store?.historyState || 'loading';
  const draft = client.drafts.get(client.selected!) || '';
  useLayoutEffect(() => {
    if (list.current && atBottom.current) list.current.scrollTop = list.current.scrollHeight;
  }, [signature]);
  useEffect(() => {
    if (!reading || !list.current) return;
    const root = list.current;
    const mark = () => {
      if (document.hidden || !document.hasFocus()) return;
      const bounds = root.getBoundingClientRect();
      const visible = new Set(
        Array.from(root.querySelectorAll<HTMLElement>('[data-message-id]'))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.bottom > bounds.top && rect.top < bounds.bottom;
          })
          .map((node) => node.dataset.messageId),
      );
      client.markRead(messages.filter((message) => visible.has(message.id)));
    };
    const observer = new IntersectionObserver(mark, { root });
    root.querySelectorAll('[data-message-id]').forEach((node) => observer.observe(node));
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    root.addEventListener('scroll', mark);
    mark();
    return () => {
      observer.disconnect();
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
      root.removeEventListener('scroll', mark);
    };
  }, [client, signature, reading]);
  const disabled = !client.canWrite || !client.available;
  return (
    <section className="room-view">
      <a className="back-link" href="#">
        ← Vissza a közös térre
      </a>
      <div className="room-header">
        <div>
          <h2>{client.available ? room?.title || '#main' : 'A szoba nem érhető el'}</h2>
          <p className="muted mono">
            {client.available
              ? `${room ? `Még ${duration(room.expiresAt - client.now)}` : 'Mindig nyitva'} · ${client.store?.participants(client.selected!, client.now) || 0} fő · becsült létszám`
              : 'A szoba lejárhatott, vagy még nem érkezett meg az adata.'}
          </p>
        </div>
        <div className="room-actions">
          <span className="public-badge">Nyilvános</span>
          <button
            className="ghost-button"
            disabled={!client.store || history === 'loading'}
            onClick={() => void client.store?.watchRoom(client.selected)}
          >
            Újratöltés
          </button>
        </div>
      </div>
      <p className="history-status" role="status">
        {history === 'loading'
          ? 'Előzmények betöltése…'
          : history === 'error'
            ? 'Az előzményeket nem sikerült beolvasni. Próbáld újra.'
            : messages.length
              ? `${messages.length} ismert üzenet · az utolsó 30 percből`
              : 'A csatlakozó böngészőktől még érkezhetnek előzmények.'}
      </p>
      <div
        ref={list}
        className="messages"
        role="log"
        aria-label="Beszélgetés"
        aria-live="polite"
        onScroll={() => {
          const node = list.current!;
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
        }}
      >
        {!messages.length && (
          <div className="empty-conversation">
            <span className="empty-symbol">↳</span>
            <h3>
              {!client.available
                ? 'Most nincs itt semmi.'
                : history === 'loading' || client.now - client.roomEnteredAt < 15000
                  ? 'Várjuk a beszélgetést…'
                  : 'Még nincs ismert üzenet.'}
            </h3>
            <p className="muted">
              {client.available
                ? 'Írhatsz közben. Az elérhető, 30 percnél frissebb előzmények automatikusan megjelennek.'
                : 'Térj vissza a közös térre, vagy várd meg, amíg a böngészők szinkronizálnak.'}
            </p>
          </div>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`message${message.authorId === client.identity?.id ? ' own-message' : ''}`}
            data-message-id={message.id}
          >
            <div className="message-meta">
              <strong>{message.authorName}</strong>
              <time className="mono" dateTime={new Date(message.createdAt).toISOString()}>
                {new Date(message.createdAt).toLocaleTimeString('hu-HU', {
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </time>
              {message.authorId === client.identity?.id && <span className="you-tag">te</span>}
              <span className="message-expiry mono" data-expires={message.expiresAt}>
                Még {duration(message.expiresAt - client.now)}
              </span>
            </div>
            <p className="message-text">{message.text}</p>
            <button className="readers-button" onClick={() => showReaders(message)}>
              Látta: {client.store?.readers(message, client.now).length || 0}
            </button>
          </article>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          atBottom.current = true;
          void client.send();
        }}
      >
        <label className="sr-only" htmlFor="message">
          Üzenet
        </label>
        <textarea
          id="message"
          name="message"
          rows={2}
          maxLength={2000}
          required
          value={draft}
          disabled={disabled}
          placeholder="Mi jár a fejedben?"
          onChange={(event) => {
            client.drafts.set(client.selected!, event.target.value);
            client.changed();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-bottom">
          <span className="muted mono">{draft.length.toLocaleString('hu-HU')} / 2000</span>
          <button type="submit" className="primary-button" disabled={disabled || client.busy}>
            Küldés ↗
          </button>
        </div>
      </form>
      <p className="composer-hint">Enter: küldés · Shift + Enter: új sor · 30 perc után eltűnik</p>
    </section>
  );
}
