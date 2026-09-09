import { useState, type FormEvent } from 'react';
import { guestSecret, newWords, secretFromWords } from '../identity';
import type { ChatClient } from '../client';
import { Dialog } from './Dialog';

export function LoginDialog({ client }: { client: ChatClient }) {
  const [mode, setMode] = useState<'guest' | 'create' | 'restore'>('guest');
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function choose(next: typeof mode) {
    setMode(next);
    setError('');
    setSaved(false);
    setWords(next === 'create' ? newWords() : '');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const secret = mode === 'guest' ? guestSecret() : await secretFromWords(words);
      await client.login(
        secret,
        mode === 'restore' ? '' : name,
        mode === 'create',
        mode === 'restore' ? 'login' : 'register',
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Nem sikerült belépni.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Hogy szólíthatunk?" className="name-dialog">
      {client.starting ? (
        <p className="muted" role="status">
          Kapcsolódás és ismert nevek betöltése…
        </p>
      ) : (
        <>
          <div className="identity-tabs" aria-label="Belépés módja">
            <button
              type="button"
              disabled={busy}
              className={mode === 'guest' ? 'selected' : ''}
              aria-pressed={mode === 'guest'}
              onClick={() => choose('guest')}
            >
              Vendég
            </button>
            <button
              type="button"
              disabled={busy}
              className={mode === 'create' ? 'selected' : ''}
              aria-pressed={mode === 'create'}
              onClick={() => choose('create')}
            >
              Új tartós fiók
            </button>
            <button
              type="button"
              disabled={busy}
              className={mode === 'restore' ? 'selected' : ''}
              aria-pressed={mode === 'restore'}
              onClick={() => choose('restore')}
            >
              Visszaállítás
            </button>
          </div>
          <p className="muted">
            {mode === 'guest'
              ? 'A becenevedet addig foglaljuk, amíg itt vagy. Kapcsolat nélkül 90 másodperc után felszabadul.'
              : mode === 'create'
                ? 'A neved akkor is foglalt marad, amikor nem vagy itt. A fiókodhoz ezzel a 12 szóval tudsz visszatérni.'
                : 'Add meg a saját 12 helyreállító szavadat az eredeti sorrendben.'}
          </p>
          <form className="identity-form" onSubmit={submit}>
            {mode !== 'restore' && (
              <>
                <label htmlFor="display-name">A beceneved</label>
                <input
                  id="display-name"
                  name="display-name"
                  disabled={busy}
                  autoComplete="nickname"
                  value={name}
                  maxLength={40}
                  required
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Milyen néven csatlakozol?"
                />
              </>
            )}
            {mode === 'create' && (
              <>
                <ol className="recovery-words" aria-label="Helyreállító szavak">
                  {words.split(' ').map((word, i) => (
                    <li key={i}>{word}</li>
                  ))}
                </ol>
                <p className="local-note">
                  Írd fel, és őrizd meg ezeket a szavakat. Aki ismeri őket, beléphet a nevedben. A
                  többi résztvevő nem kapja meg őket, és elvesztésük esetén nem tudjuk
                  visszaállítani a fiókot.
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={saved}
                    required
                    onChange={(e) => setSaved(e.target.checked)}
                  />
                  Elmentettem a 12 szót.
                </label>
              </>
            )}
            {mode === 'restore' && (
              <>
                <label htmlFor="recovery">A 12 helyreállító szó</label>
                <textarea
                  id="recovery"
                  disabled={busy}
                  rows={4}
                  value={words}
                  onChange={(e) => setWords(e.target.value)}
                  required
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="primary-button"
              disabled={busy || (mode === 'create' && !saved)}
            >
              {busy ? 'Belépés…' : mode === 'restore' ? 'Fiók visszaállítása' : 'Belépés →'}
            </button>
          </form>
          <p className="local-note">A belépés ebben a böngészőfülben frissítés után is megmarad.</p>
        </>
      )}
    </Dialog>
  );
}
export function UsersDialog({ client, close }: { client: ChatClient; close: () => void }) {
  return (
    <Dialog title="Felhasználók" onClose={close}>
      <p className="muted">
        {client.users.filter((u) => u.online).length} online · Tartós fiókok és a jelenleg foglalt
        vendégnevek.
      </p>
      <ul className="user-list">
        {client.users.map((user) => (
          <li key={user.id}>
            <span className={`status-dot ${user.online ? 'connected' : ''}`} />
            <strong>{user.name}</strong>
            <span className="muted">
              {user.online ? 'Online' : 'Offline'} · {user.permanent ? 'Tartós fiók' : 'Vendég'}
            </span>
          </li>
        ))}
      </ul>
      {!client.users.length && <p className="local-note">A lista még nem érkezett meg.</p>}
    </Dialog>
  );
}
export function AccountDialog({ client, close }: { client: ChatClient; close: () => void }) {
  return (
    <Dialog title={client.identity?.name || 'Fiókom'} onClose={close}>
      <p className="muted">
        {client.identity?.permanent
          ? 'Tartós fiók. A neved offline is foglalt. Másik böngészőben a Visszaállítás gombbal és a 12 szavaddal léphetsz be.'
          : 'Vendégként vagy itt. A neved a kapcsolat megszűnése után legfeljebb 90 másodpercig marad foglalt. Tartós fiókot a belépőképernyőn hozhatsz létre.'}
      </p>
      <button className="primary-button" onClick={() => client.logout()}>
        Kijelentkezés
      </button>
    </Dialog>
  );
}
