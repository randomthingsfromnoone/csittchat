import './style.css';
import logoUrl from '../logo.png';
import type { GDB, gdb as GdbFactory } from 'genosdb';
import { ChatStore } from './store';
import { duration, isRoomId, isUuid, MESSAGE_TTL, PRESENCE_TTL, ROOM_TTL, validText, type RoomRecord } from './model';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
const button = (text: string, className = '') => {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
};
function timeAgo(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return 'az imént';
  if (seconds < 60) return `${seconds} másodperce`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} perce` : `${Math.floor(minutes / 60)} órája`;
}
const app = document.querySelector<HTMLDivElement>('#app')!;
let identity = { id: crypto.randomUUID() as string, name: '' };
let identityReady = false;
let storageAvailable = true;
try {
  const saved: unknown = JSON.parse(sessionStorage.getItem('csittchat.identity.session.v1') || 'null');
  if (saved && typeof saved === 'object' && 'id' in saved && 'name' in saved && isUuid(saved.id) && validText(saved.name, 40)) {
    identity = { id: saved.id, name: saved.name };
    identityReady = true;
  }
  // Retire the previous persistent identity; names now belong to this tab session.
  localStorage.removeItem('ephemeral.identity.v1');
} catch { storageAvailable = false; }
const sessionId = crypto.randomUUID();
let store: ChatStore | undefined;
let selected: string | null = null;
let renderPending = false;
let writeBusy = false;
let roomEnteredAt = 0;
let lastWrite = 0;
let lastMessageSignature = '';
const drafts = new Map<string, string>();

const header = el('header', 'site-header');
const headerInner = el('div', 'header-inner');
const brand = el('a', 'brand'); brand.href = '#';
brand.setAttribute('aria-label', 'CsittChat — Közös tér');
const logo = el('img', 'brand-logo');
logo.src = logoUrl; logo.alt = 'CsittChat'; logo.width = 1254; logo.height = 1254;
brand.append(logo);
const status = el('div', 'network-status');
const statusDot = el('span', 'status-dot');
const statusText = el('span', '', 'Helyi tárhely indítása…');
status.append(statusDot, statusText);
const headerActions = el('div', 'header-actions');
const currentName = el('span', 'current-name');
currentName.title = 'A beceneved erre a munkamenetre szól, itt nem módosítható.';
const aboutButton = button('Tudnivalók', 'ghost-button');
headerActions.append(status, currentName, aboutButton);
headerInner.append(brand, headerActions); header.append(headerInner);

const main = el('main', 'page');
const intro = el('section', 'intro');
const introCopy = el('div');
introCopy.append(el('p', 'eyebrow', 'NYILVÁNOS · IDEIGLENES · KÖZVETLEN'), el('h1', '', 'Egy kis idő, együtt.'), el('p', 'intro-description', 'Válassz egy szobát, vagy indíts beszélgetést. Az üzenetek 30 percig maradnak.'));
const lobbyJoin = el('a', 'primary-button', 'Belépek a #main szobába →'); lobbyJoin.href = '#room/main';
const lobbyStats = el('div', 'lobby-stats');
introCopy.append(lobbyJoin, lobbyStats);
intro.append(introCopy);

const identityBar = el('div', 'identity-bar');
const identityForm = el('form', 'identity-form');
const identityLabel = el('label', '', 'A beceneved'); identityLabel.htmlFor = 'display-name';
const nameInput = el('input'); nameInput.id = 'display-name'; nameInput.name = 'display-name'; nameInput.maxLength = 40; nameInput.required = true; nameInput.value = identity.name; nameInput.setAttribute('autocomplete', 'nickname');
nameInput.placeholder = 'Milyen néven csatlakozol?';
const saveName = button('Belépés →', 'primary-button'); saveName.type = 'submit';
const identityError = el('p', 'form-error'); identityError.setAttribute('role', 'alert');
identityForm.append(identityLabel, nameInput, identityError, saveName);
const localNote = el('p', 'local-note', storageAvailable ? 'A neved ebben a böngészőfülben frissítés után is megmarad. Új munkamenetben új nevet választhatsz.' : 'A böngésző nem engedélyezi a mentést. Frissítéskor újra nevet kell megadnod.');
identityBar.append(identityForm, localNote);
const notice = el('p', 'notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
function notify(message: string) { notice.textContent = message; notice.hidden = false; }
function failed(error: unknown) { console.error(error); notify('Nem sikerült a helyi mentés. A piszkozatod megmaradt, próbáld újra.'); }

const square = el('section', 'square');
const squareHeading = el('div', 'section-heading');
const squareTitle = el('div');
const roomCount = el('span', 'count', '01');
const squareH2 = el('h2', '', 'Szobák'); squareH2.append(roomCount);
squareTitle.append(squareH2, el('p', 'muted', 'Minden beszélgetés nyilvános.'));
const createButton = button('+ Új szoba', 'primary-button'); createButton.disabled = true;
squareHeading.append(squareTitle, createButton);
const roomList = el('div', 'room-list');
const squareFooter = el('div', 'square-footnote');
const knownPeople = el('span', '', 'Kapcsolódás…');
squareFooter.append(knownPeople, el('span', 'mono', 'Szobák: 6 óra · Üzenetek: 30 perc'));
square.append(squareHeading, roomList, squareFooter);

const roomView = el('section', 'room-view'); roomView.hidden = true;
const back = el('a', 'back-link', '← Vissza a közös térre'); back.href = '#';
const roomHeader = el('div', 'room-header');
const roomTitle = el('h2');
const roomMeta = el('p', 'muted mono');
const roomHeaderCopy = el('div'); roomHeaderCopy.append(roomTitle, roomMeta);
const roomBadge = el('span', 'public-badge', 'Nyilvános');
const reloadHistory = button('Újratöltés', 'ghost-button');
reloadHistory.title = 'Újraolvassa a már beérkezett előzményeket.';
const roomActions = el('div', 'room-actions'); roomActions.append(roomBadge, reloadHistory);
roomHeader.append(roomHeaderCopy, roomActions);
const historyStatus = el('p', 'history-status'); historyStatus.setAttribute('role', 'status');
const messageList = el('div', 'messages'); messageList.setAttribute('role', 'log'); messageList.setAttribute('aria-label', 'Beszélgetés'); messageList.setAttribute('aria-live', 'polite');
const composer = el('form', 'composer');
const messageLabel = el('label', 'sr-only', 'Üzenet'); messageLabel.htmlFor = 'message';
const messageInput = el('textarea'); messageInput.id = 'message'; messageInput.name = 'message'; messageInput.rows = 2; messageInput.maxLength = 2000; messageInput.required = true; messageInput.placeholder = 'Mi jár a fejedben?';
const composerBottom = el('div', 'composer-bottom');
const characterCount = el('span', 'muted mono', '0 / 2000');
const sendButton = button('Küldés ↗', 'primary-button'); sendButton.type = 'submit';
composerBottom.append(characterCount, sendButton);
composer.append(messageLabel, messageInput, composerBottom);
roomView.append(back, roomHeader, historyStatus, messageList, composer, el('p', 'composer-hint', 'Enter: küldés · Shift + Enter: új sor · 30 perc után eltűnik'));

const privacy = el('aside', 'privacy-note');
privacy.append(el('span', 'privacy-icon', '◷'), el('p', '', 'Az üzenetek a hivatalos alkalmazásban ideiglenesek, de más résztvevők elmenthetik vagy rögzíthetik őket.'));
const sidebar = el('aside', 'sidebar'); sidebar.setAttribute('aria-label', 'Nyilvános szobák');
sidebar.append(square);
const content = el('div', 'content'); content.append(intro, roomView);
main.append(sidebar, content);
const banner = el('div', 'banner'); banner.append(notice);
app.append(header, banner, main, privacy);

const identityDialog = el('dialog', 'name-dialog');
identityDialog.setAttribute('aria-labelledby', 'name-dialog-title');
const identityHeading = el('h2', '', 'Hogy szólíthatunk?'); identityHeading.id = 'name-dialog-title';
identityDialog.append(el('span', 'dialog-symbol', '#'), identityHeading, el('p', 'muted', 'Válassz egy becenevet a beszélgetéshez. Belépés után ebben a munkamenetben nem módosítható.'), identityBar);
identityDialog.addEventListener('cancel', event => event.preventDefault());
app.append(identityDialog);

const about = el('dialog', 'about-dialog'); about.setAttribute('aria-labelledby', 'about-title');
const aboutHeading = el('h2', '', 'Egy kis időre. Nyilvánosan.'); aboutHeading.id = 'about-title';
const closeAbout = button('Rendben', 'primary-button');
about.append(aboutHeading, el('p', '', 'A szobák 6 óráig, az üzenetek 30 percig élnek. A #main mindig nyitva marad. Csak a még le nem járt, a böngésződben tárolt vagy elérhető résztvevőktől átvett üzenetek jelennek meg.'), el('p', '', 'A létszám becsült, a becenevek nem hitelesítettek. A böngészők GenosDB és WebRTC segítségével kapcsolódnak. A kapcsolat létrejötte még nem jelenti az összes előzmény megérkezését.'), el('p', '', 'A becenév a böngészőfül munkamenetéhez tartozik. A böngésző munkamenet-visszaállítása visszahozhatja a nevet is. A névkorlátozás a felület működése, nem hitelesítés.'), el('p', '', 'Más résztvevők elmenthetik vagy rögzíthetik a beszélgetést. A P2P-kapcsolat nem biztosít anonimitást.'), closeAbout);
app.append(about);
aboutButton.onclick = () => about.showModal(); closeAbout.onclick = () => about.close();

const dialog = el('dialog', 'create-dialog');
const createForm = el('form');
const dialogTop = el('div', 'dialog-top');
const closeDialog = button('×', 'close-button'); closeDialog.setAttribute('aria-label', 'Bezárás');
const dialogHeading = el('h2', '', 'Indíts egy beszélgetést.'); dialogHeading.id = 'dialog-title'; dialog.setAttribute('aria-labelledby', 'dialog-title');
dialogTop.append(el('p', 'eyebrow', 'VAN MIRŐL BESZÉLGETNI'), closeDialog);
const titleLabel = el('label', 'field-label', 'A szoba neve'); titleLabel.htmlFor = 'room-title';
const titleInput = el('input'); titleInput.id = 'room-title'; titleInput.name = 'room-title'; titleInput.maxLength = 100; titleInput.required = true; titleInput.placeholder = 'Miről beszélgetnél?';
const createSubmit = button('Szoba létrehozása ↗', 'primary-button'); createSubmit.type = 'submit';
const createError = el('p', 'form-error'); createError.setAttribute('role', 'alert');
for (const field of [nameInput, titleInput, messageInput]) {
  field.addEventListener('invalid', () => {
    if (field.validity.valueMissing) field.setCustomValidity('Töltsd ki ezt a mezőt.');
    else if (field.validity.tooLong) field.setCustomValidity(`Legfeljebb ${field.maxLength} karaktert adj meg.`);
  });
  field.addEventListener('input', () => field.setCustomValidity(''));
}
createForm.append(dialogTop, dialogHeading, el('p', 'muted', 'Bárki beléphet. A szoba 6 órán át marad nyitva.'), titleLabel, titleInput, createError, createSubmit);
dialog.append(createForm); app.append(dialog);
createButton.onclick = () => { createError.textContent = ''; dialog.showModal(); titleInput.focus(); };
closeDialog.onclick = () => dialog.close();
dialog.addEventListener('click', e => { if (e.target === dialog && (e.clientX < dialog.getBoundingClientRect().left || e.clientX > dialog.getBoundingClientRect().right || e.clientY < dialog.getBoundingClientRect().top || e.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });

identityForm.onsubmit = e => {
  e.preventDefault();
  if (identityReady) return;
  const name = nameInput.value.trim();
  if (!validText(name, 40)) { identityError.textContent = 'Válassz 1–40 karakteres becenevet, sortörés és vezérlőkarakterek nélkül.'; return; }
  identity = { id: identity.id, name };
  identityReady = true;
  try { sessionStorage.setItem('csittchat.identity.session.v1', JSON.stringify(identity)); }
  catch { notify('A beceneved most használható, de frissítéskor újra meg kell adnod.'); }
  nameInput.disabled = true; saveName.disabled = true;
  identityDialog.close();
  render();
  void start();
};

createForm.onsubmit = async e => {
  e.preventDefault();
  if (!store || !identityReady || createSubmit.disabled) return;
  const title = titleInput.value.trim();
  if (!validText(title, 100)) { createError.textContent = 'Adj meg 1–100 karaktert, sortörés és vezérlőkarakterek nélkül.'; return; }
  createSubmit.disabled = true;
  const now = Date.now();
  const record: RoomRecord = { kind: 'room', id: crypto.randomUUID(), title, creator: identity.id, createdAt: now, expiresAt: now + ROOM_TTL, lastActivityAt: now };
  try {
    await store.put(record);
    dialog.close(); titleInput.value = ''; location.hash = `room/${record.id}`;
  } catch (error) { console.error(error); createError.textContent = 'Nem sikerült létrehozni a szobát. Próbáld újra.'; }
  finally { createSubmit.disabled = false; }
};

messageInput.oninput = () => {
  if (selected) drafts.set(selected, messageInput.value);
  characterCount.textContent = `${messageInput.value.length.toLocaleString('hu-HU')} / 2000`;
};
messageInput.onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); composer.requestSubmit(); }
};
composer.onsubmit = async e => {
  e.preventDefault();
  if (!store || !identityReady || !selected || writeBusy) return;
  const roomId = selected;
  const text = messageInput.value.trim();
  const now = Date.now();
  if (!validText(text, 2000, true)) { notify('Írj 1–2000 karakteres üzenetet, vezérlőkarakterek nélkül.'); return; }
  if (roomId !== 'main' && (!store.rooms.has(roomId) || store.rooms.get(roomId)!.expiresAt <= now)) { notify('Ez a szoba már lejárt, vagy még nem érhető el.'); return; }
  if (now - lastWrite < 750) { notify('Várj egy pillanatot a következő üzenet elküldése előtt.'); return; }
  writeBusy = true; sendButton.disabled = true;
  const draft = messageInput.value;
  try {
    await store.put({ kind: 'message', id: crypto.randomUUID(), roomId, authorId: identity.id, authorName: identity.name, text, createdAt: now, expiresAt: now + MESSAGE_TTL });
    lastWrite = now;
    if (drafts.get(roomId) === draft) drafts.delete(roomId);
    if (selected === roomId && messageInput.value === draft) { messageInput.value = ''; characterCount.textContent = '0 / 2000'; }
    notice.hidden = true;
    messageList.scrollTop = messageList.scrollHeight;
  } catch (error) { failed(error); }
  finally { writeBusy = false; render(); }
};

async function heartbeat() {
  if (!store || !identityReady) return;
  const now = Date.now();
  try { await store.put({ kind: 'presence', id: sessionId, roomId: selected, authorId: identity.id, createdAt: now, expiresAt: now + PRESENCE_TTL }); }
  catch (error) { failed(error); }
}

function navigate() {
  if (selected) drafts.set(selected, messageInput.value);
  const id = location.hash.startsWith('#room/') ? location.hash.slice(6) : null;
  selected = isRoomId(id) ? id : null;
  main.classList.toggle('in-room', selected !== null);
  intro.hidden = selected !== null; roomView.hidden = selected === null;
  roomEnteredAt = Date.now();
  lastMessageSignature = '';
  messageInput.value = selected ? drafts.get(selected) || '' : '';
  characterCount.textContent = `${messageInput.value.length.toLocaleString('hu-HU')} / 2000`;
  render(); void store?.watchRoom(selected); void heartbeat();
}
window.addEventListener('hashchange', navigate);
reloadHistory.onclick = () => { if (store) void store.watchRoom(selected); };
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}

const cards = new Map<string, { node: HTMLElement; title: HTMLElement; people: HTMLElement; time: HTMLElement; activity: HTMLElement }>();
function roomCard(id: string) {
  const node = el('article', `room-card${id === 'main' ? ' main-card' : ''}`);
  const symbol = el('span', 'room-symbol', '#');
  const copy = el('div', 'room-card-copy');
  const titleLine = el('div', 'room-title-line'); const title = el('h3');
  titleLine.append(title);
  if (id === 'main') titleLine.append(el('span', 'default-badge', 'Állandó'));
  const activity = el('p', 'room-activity'); copy.append(titleLine, activity);
  const metrics = el('div', 'room-metrics'); const people = el('span'); const time = el('span', 'room-time'); metrics.append(people, time);
  const join = el('a', 'join-button', 'Belépés ↗'); join.href = `#room/${id}`;
  join.setAttribute('aria-label', id === 'main' ? 'Belépés a #main szobába' : 'Belépés a szobába');
  node.append(symbol, copy, metrics, join);
  const card = { node, title, people, time, activity }; cards.set(id, card); return card;
}

function render() {
  const now = Date.now();
  currentName.textContent = identityReady ? identity.name : '';
  currentName.hidden = !identityReady;
  const peers = store?.db.room ? Object.keys(store.db.room.getPeers()).length : 0;
  statusDot.classList.toggle('connected', peers > 0);
  statusText.textContent = !identityReady ? 'Válassz becenevet' : !store ? 'Helyi tárhely indítása…' : !navigator.onLine ? 'Nincs internet · helyben mentve' : peers > 0 ? `${peers} közvetlen kapcsolat` : 'Kapcsolatok keresése…';
  status.title = 'A közvetlen WebRTC-kapcsolatok száma, nem a hálózat teljes létszáma. Egy kapcsolat önmagában nem igazolja az üzenet kézbesítését.';
  const rooms = [...store?.rooms.values() || []].filter(r => r.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  roomCount.textContent = String(rooms.length + 1).padStart(2, '0');
  const people = store?.participants(undefined, now) || 0;
  knownPeople.textContent = `Kb. ${people} résztvevő a közös térben`;
  lobbyStats.textContent = `${rooms.length + 1} nyilvános szoba · kb. ${people} résztvevő`;
  const ids = ['main', ...rooms.map(r => r.id)];
  for (const [id, card] of cards) if (!ids.includes(id)) { card.node.remove(); cards.delete(id); }
  for (const id of ids) {
    const room = store?.rooms.get(id);
    const card = cards.get(id) || roomCard(id);
    card.node.classList.toggle('active', selected === id);
    const link = card.node.querySelector('a')!;
    if (selected === id) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    card.title.textContent = room?.title || '#main';
    const participants = store?.participants(id, now) || 0;
    card.people.textContent = `Kb. ${participants} fő`;
    card.time.textContent = room ? `Még ${duration(room.expiresAt - now)}` : 'Mindig nyitva';
    const recent = store?.visibleMessages(id, now).at(-1);
    const roomAge = room ? `A szoba ${timeAgo(now - room.createdAt)} nyílt` : '';
    card.activity.textContent = recent ? `Utolsó üzenet: ${timeAgo(now - recent.createdAt)}${room ? ` · ${roomAge}` : ''}` : room ? `${roomAge} · Kezdd te a beszélgetést!` : 'Az ajtó mindig nyitva. Nézz be és köszönj!';
    // Only move nodes when order changes, preserving keyboard focus.
    const index = ids.indexOf(id);
    if (roomList.children[index] !== card.node) roomList.insertBefore(card.node, roomList.children[index] || null);
  }
  if (!selected) return;
  const room = store?.rooms.get(selected);
  const available = selected === 'main' || !!room && room.expiresAt > now;
  roomTitle.textContent = selected === 'main' ? '#main' : room?.title || 'A szoba nem érhető el';
  roomMeta.textContent = available ? `${room ? `Még ${duration(room.expiresAt - now)}` : 'Mindig nyitva'} · ${store?.participants(selected, now) || 0} fő · becsült létszám` : 'A szoba lejárhatott, vagy még nem kapcsolódott olyan résztvevő, akinél megtalálható.';
  messageInput.disabled = !store || !identityReady || !available;
  sendButton.disabled = !store || !identityReady || !available || writeBusy;
  reloadHistory.disabled = !store || store.historyState === 'loading';
  const messages = available ? store?.visibleMessages(selected, now) || [] : [];
  const historyState = store?.historyState || 'loading';
  const waiting = !messages.length && now - roomEnteredAt < 15000;
  historyStatus.textContent = historyState === 'loading' ? 'Előzmények betöltése…' : historyState === 'error' ? 'Az előzményeket nem sikerült beolvasni. Próbáld az újratöltést.' : messages.length ? `${messages.length} ismert üzenet · az utolsó 30 percből` : 'A csatlakozó böngészőktől még érkezhetnek előzmények.';
  const signature = `${selected}:${available}:${historyState}:${waiting}:${messages.map(m => m.id).join(',')}`;
  if (signature !== lastMessageSignature) {
    const atBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 90;
    const previousScroll = messageList.scrollTop;
    const initial = !lastMessageSignature;
    lastMessageSignature = signature;
    const nodes: HTMLElement[] = [];
    if (!messages.length) {
      const empty = el('div', 'empty-conversation');
      empty.append(el('span', 'empty-symbol', '↳'), el('h3', '', !available ? 'Most nincs itt semmi.' : historyState === 'loading' || waiting ? 'Várjuk a beszélgetést…' : 'Még nincs ismert üzenet.'), el('p', 'muted', available ? 'Írhatsz közben. Az elérhető, 30 percnél frissebb előzmények automatikusan megjelennek.' : 'Térj vissza a közös térre, vagy várd meg, amíg a böngészők szinkronizálnak.'));
      nodes.push(empty);
    }
    for (const message of messages) {
      const item = el('article', `message${message.authorId === identity.id ? ' own-message' : ''}`);
      item.dataset.messageId = message.id;
      const meta = el('div', 'message-meta'); const author = el('strong', '', message.authorName);
      author.title = `Nem hitelesített helyi azonosító: ${message.authorId}`;
      const time = el('time', 'mono', new Date(message.createdAt).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', hour12: false })); time.dateTime = new Date(message.createdAt).toISOString();
      const expires = el('span', 'message-expiry mono', `Még ${duration(message.expiresAt - now)}`); expires.dataset.expires = String(message.expiresAt);
      meta.append(author, time); if (message.authorId === identity.id) meta.append(el('span', 'you-tag', 'te')); meta.append(expires);
      item.append(meta, el('p', 'message-text', message.text)); nodes.push(item);
    }
    messageList.replaceChildren(...nodes);
    messageList.scrollTop = atBottom || initial ? messageList.scrollHeight : previousScroll;
  }
  messageList.querySelectorAll<HTMLElement>('[data-expires]').forEach(node => { node.textContent = `Még ${duration(Number(node.dataset.expires) - now)}`; });
}

async function start() {
  try {
    // Runtime URL stays relative to index.html, including GitHub Pages subpaths.
    const url = new URL('./vendor/genosdb/index.js', document.baseURI).href;
    const { gdb } = await import(/* @vite-ignore */ url) as { gdb: typeof GdbFactory };
    const relayUrls = (import.meta.env.VITE_CHAT_RELAYS || '').split(',').map((url: string) => url.trim()).filter(Boolean);
    if (relayUrls.some((url: string) => !/^wss:\/\//.test(url) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url))) {
      throw new Error('VITE_CHAT_RELAYS: use wss:// URLs (ws:// is allowed only on localhost).');
    }
    const db: GDB = await gdb(import.meta.env.VITE_CHAT_NETWORK || 'ephemeral-pub-v1', {
      rtc: { cells: true, ...(relayUrls.length ? { relayUrls } : {}) }, debug: import.meta.env.VITE_GDB_DEBUG === '1',
    });
    store = new ChatStore(db, scheduleRender, failed);
    await store.start();
    createButton.disabled = false;
    for (const event of ['peer:leave', 'mesh:state']) db.room?.on(event, scheduleRender);
    db.room?.on('peer:join', () => {
      scheduleRender();
      store?.scheduleHistoryRecovery();
      if (selected) void store?.watchRoom(selected);
    });
    if (db.room && Object.keys(db.room.getPeers()).length) store.scheduleHistoryRecovery();
    navigate();
    setInterval(() => { render(); void store?.sweep(); }, 1000);
    setInterval(() => void heartbeat(), 25000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void store?.sweep(); void store?.watchRoom(selected); store?.scheduleHistoryRecovery(); void heartbeat(); } });
    window.addEventListener('online', () => { render(); void store?.watchRoom(selected); store?.scheduleHistoryRecovery(); void heartbeat(); });
    window.addEventListener('offline', render);
    // Presence expires even when unload cannot finish. No network write is
    // required during page teardown, which also keeps bfcache navigation safe.
  } catch (error) {
    console.error(error);
    statusText.textContent = 'Nem sikerült elindulni';
    notify('Nem sikerült megnyitni a beszélgetés helyi tárhelyét. Használj naprakész böngészőt HTTPS-kapcsolattal (vagy localhoston), engedélyezd a böngésző tárhelyét, majd töltsd újra az oldalt.');
  }
}
navigate();
if (identityReady) void start();
else { identityDialog.showModal(); nameInput.focus(); }
