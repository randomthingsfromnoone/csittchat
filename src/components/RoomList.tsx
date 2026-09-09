import type { ChatClient } from '../client';
import { duration } from '../model';
import { unreadLabel } from '../read-state';
export function RoomList({ client, create }: { client: ChatClient; create: () => void }) {
  const rooms = [...(client.store?.rooms.values() || [])]
    .filter((r) => r.expiresAt > client.now)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  return (
    <aside className="sidebar" aria-label="Nyilvános szobák">
      <section className="square">
        <div className="section-heading">
          <div>
            <h2>
              Szobák <span className="count">{String(rooms.length + 1).padStart(2, '0')}</span>
            </h2>
            <p className="muted">Minden beszélgetés nyilvános.</p>
          </div>
          <button className="primary-button" disabled={!client.canWrite} onClick={create}>
            + Új szoba
          </button>
        </div>
        <div className="room-list">
          {['main', ...rooms.map((r) => r.id)].map((id) => {
            const room = client.store?.rooms.get(id);
            const unread = client.unread(id);
            return (
              <article
                key={id}
                className={`room-card${id === 'main' ? ' main-card' : ''}${client.selected === id ? ' active' : ''}`}
              >
                <span className="room-symbol">#</span>
                <div className="room-card-copy">
                  <div className="room-title-line">
                    <h3>{room?.title || '#main'}</h3>
                    {id === 'main' && <span className="default-badge">Állandó</span>}
                    {unread > 0 && (
                      <span className="unread-badge" aria-label={`${unread} olvasatlan üzenet`}>
                        {unreadLabel(unread)}
                      </span>
                    )}
                  </div>
                  <p className="room-activity">
                    {room && room.lastActivityAt > room.createdAt
                      ? 'A beszélgetés újraindította a 6 órát.'
                      : 'Kezdd te a beszélgetést!'}
                  </p>
                </div>
                <div className="room-metrics">
                  <span>Kb. {client.store?.participants(id, client.now) || 0} fő</span>
                  <span className="room-time">
                    {room ? `Még ${duration(room.expiresAt - client.now)}` : 'Mindig nyitva'}
                  </span>
                </div>
                <a
                  className="join-button"
                  href={`#room/${id}`}
                  aria-current={client.selected === id ? 'page' : undefined}
                  aria-label={id === 'main' ? 'Belépés a #main szobába' : 'Belépés a szobába'}
                >
                  Belépés ↗
                </a>
              </article>
            );
          })}
        </div>
        <div className="square-footnote">
          <span>
            Kb. {client.store?.participants(undefined, client.now) || 0} résztvevő a közös térben
          </span>
          <span className="mono">Szobák: 6 óra csend után zárnak · Üzenetek: 30 perc</span>
        </div>
      </section>
    </aside>
  );
}
