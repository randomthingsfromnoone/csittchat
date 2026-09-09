import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import logoUrl from '../logo.png';
import { client } from './client';
import type { MessageRecord } from './model';
import { Dialog } from './components/Dialog';
import { AccountDialog, LoginDialog, UsersDialog } from './components/IdentityDialogs';
import { RoomList } from './components/RoomList';
import { Conversation } from './components/Conversation';
import { unreadLabel } from './read-state';
function CreateRoom({ close }: { close: () => void }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await client.createRoom(title);
      close();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Nem sikerült létrehozni.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Indíts egy beszélgetést." className="create-dialog" onClose={close}>
      <p className="muted">
        Bárki beléphet. A szoba 6 óra csend után bezár; minden új üzenet újraindítja a 6 órát.
      </p>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="room-title">
          A szoba neve
        </label>
        <input
          id="room-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={100}
          required
          autoFocus
          placeholder="Miről beszélgetnél?"
        />
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button className="primary-button" type="submit" disabled={busy}>
          Szoba létrehozása ↗
        </button>
      </form>
    </Dialog>
  );
}
export function App() {
  useSyncExternalStore(client.subscribe, client.snapshot);
  const [modal, setModal] = useState<'about' | 'create' | 'users' | 'account' | null>(null);
  const [readers, setReaders] = useState<MessageRecord | null>(null);
  useEffect(() => {
    client.init();
  }, []);
  const peers = client.store?.db.room ? Object.keys(client.store.db.room.getPeers()).length : 0;
  const totalUnread = ['main', ...(client.store?.rooms.keys() || [])].reduce(
    (sum, id) => sum + client.unread(id),
    0,
  );
  useEffect(() => {
    document.title = `${totalUnread ? `(${unreadLabel(totalUnread)}) ` : ''}CsittChat — egy kis idő, együtt`;
  }, [totalUnread]);
  const close = () => {
    setModal(null);
    setReaders(null);
  };
  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="#" aria-label="CsittChat — Közös tér">
            <img className="brand-logo" src={logoUrl} alt="CsittChat" width={1254} height={1254} />
          </a>
          <div className="header-actions">
            <div
              className="network-status"
              title="Közvetlen WebRTC-kapcsolatok; nem a teljes hálózat létszáma."
            >
              <span className={`status-dot${peers > 0 ? ' connected' : ''}`} />
              <span>
                {!client.identity
                  ? 'Válassz becenevet'
                  : !client.store
                    ? 'Helyi tárhely indítása…'
                    : !client.canWrite
                      ? 'A névfoglalásra várunk…'
                      : !navigator.onLine
                        ? 'Nincs internet'
                        : peers > 0
                          ? `${peers} közvetlen kapcsolat`
                          : 'Kapcsolatok keresése…'}
              </span>
            </div>
            {client.identity && (
              <>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setModal('users');
                    void client.refreshUsers();
                  }}
                >
                  Felhasználók
                </button>
                <button className="current-name" onClick={() => setModal('account')}>
                  {client.identity.name}
                </button>
              </>
            )}
            <button className="ghost-button" onClick={() => setModal('about')}>
              Tudnivalók
            </button>
          </div>
        </div>
      </header>
      <div className="banner">
        <p className="notice" role="status" hidden={!client.notice}>
          {client.notice}
        </p>
      </div>
      <main className={`page${client.selected ? ' in-room' : ''}`}>
        <RoomList client={client} create={() => setModal('create')} />
        <div className="content">
          {client.selected ? (
            <Conversation
              key={client.selected}
              client={client}
              reading={!modal && !readers && !!client.identity}
              showReaders={setReaders}
            />
          ) : (
            <section className="intro">
              <div>
                <p className="eyebrow">NYILVÁNOS · IDEIGLENES · KÖZVETLEN</p>
                <h1>Egy kis idő, együtt.</h1>
                <p className="intro-description">
                  Válassz egy szobát, vagy indíts beszélgetést. Az üzenetek 30 percig maradnak.
                </p>
                <a className="primary-button" href="#room/main">
                  Belépek a #main szobába →
                </a>
                <div className="lobby-stats">
                  {(client.store?.rooms.size || 0) + 1} nyilvános szoba · kb.{' '}
                  {client.store?.participants(undefined, client.now) || 0} résztvevő
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
      <aside className="privacy-note">
        <span className="privacy-icon">◷</span>
        <p>
          Az üzenetek a hivatalos alkalmazásban ideiglenesek, de más résztvevők elmenthetik vagy
          rögzíthetik őket.
        </p>
      </aside>
      {!client.identity && <LoginDialog client={client} />}
      {modal === 'create' && <CreateRoom close={close} />}
      {modal === 'users' && <UsersDialog client={client} close={close} />}
      {modal === 'account' && <AccountDialog client={client} close={close} />}
      {modal === 'about' && (
        <Dialog title="Egy kis időre. Nyilvánosan." className="about-dialog" onClose={close}>
          <p>
            A szobák 6 óra csend után zárnak be. Minden új üzenettől újraindul a 6 óra. Az üzenetek
            és a hozzájuk tartozó láttamozások 30 perc után eltűnnek. A #main mindig nyitva marad.
          </p>
          <p>
            Az olvasatlan számlálót a böngésződ tárolja. A „Látta” listán megjelenik a beceneved,
            amikor az üzenet látható a megnyitott, aktív böngészőfülben. Ez nem igazolja, hogy el is
            olvastad.
          </p>
          <p>
            A névfoglalásokat a résztvevők szinkronizálják. A vendégnevek 90 másodperc
            kapcsolatkimaradás után felszabadulnak; a tartós nevek offline is foglaltak. A tartós
            fiók a 12 helyreállító szóval nyitható meg újra. Hálózati szakadás alatt átmeneti
            névütközés lehet; kapcsolódás után a korábbi regisztráció marad használható.
          </p>
          <p>
            A beszélgetések nyilvánosak. Más résztvevők elmenthetik vagy rögzíthetik őket. A
            P2P-kapcsolat nem biztosít anonimitást, és a kapcsolat létrejötte nem igazolja az
            előzmények megérkezését.
          </p>
          <button className="primary-button" onClick={close}>
            Rendben
          </button>
        </Dialog>
      )}
      {readers && (
        <Dialog title="Látta" onClose={close}>
          <p className="muted">Akiknél ez az üzenet megjelent az aktív beszélgetésben:</p>
          <ul className="user-list">
            {client.store?.readers(readers, client.now).map((reader) => (
              <li key={reader.authorId}>
                <strong>{reader.authorName}</strong>
                <time className="muted">
                  {new Date(reader.createdAt).toLocaleTimeString('hu-HU', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </li>
            ))}
          </ul>
          {!client.store?.readers(readers, client.now).length && (
            <p className="local-note">Még nem érkezett láttamozás.</p>
          )}
        </Dialog>
      )}
    </>
  );
}
