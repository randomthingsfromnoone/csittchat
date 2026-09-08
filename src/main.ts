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
const app = document.querySelector<HTMLDivElement>('#app')!;
let identity = { id: crypto.randomUUID() as string, name: `vandor-${Math.floor(Math.random() * 9000 + 1000)}` };
let storageAvailable = true;
try {
  const saved: unknown = JSON.parse(localStorage.getItem('ephemeral.identity.v1') || 'null');
  if (saved && typeof saved === 'object' && 'id' in saved && 'name' in saved && isUuid(saved.id) && validText(saved.name, 40)) {
    identity = { id: saved.id, name: saved.name };
  }
  localStorage.setItem('ephemeral.identity.v1', JSON.stringify(identity));
} catch { storageAvailable = false; }
const sessionId = crypto.randomUUID();
let store: ChatStore | undefined;
let selected: string | null = null;
let renderPending = false;
let writeBusy = false;
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
headerInner.append(brand, status); header.append(headerInner);

const main = el('main', 'page');
const intro = el('section', 'intro');
const introCopy = el('div');
introCopy.append(el('p', 'eyebrow', 'EGY KIS KÍSÉRLET A KÖZÖS JELENLÉTRE'), el('h1', '', 'Egy kis idő, együtt.'), el('p', 'intro-description', 'Közös tér futó gondolatoknak és nyílt beszélgetéseknek.\nRegisztráció nélkül. Egy kis időre. Itt és most.'));
const experiment = el('div', 'experiment-note');
experiment.append(el('span', 'experiment-icon', '↗'), el('span', '', 'Böngészők között.\nEmberek között.'));
intro.append(introCopy, experiment);

const identityBar = el('div', 'identity-bar');
const identityForm = el('form', 'identity-form');
const identityLabel = el('label', '', 'A beceneved'); identityLabel.htmlFor = 'display-name';
const nameInput = el('input'); nameInput.id = 'display-name'; nameInput.name = 'display-name'; nameInput.maxLength = 40; nameInput.required = true; nameInput.value = identity.name; nameInput.setAttribute('autocomplete', 'nickname');
const saveName = button('Név mentése', 'text-button'); saveName.type = 'submit';
identityForm.append(el('span', 'avatar', '☺'), identityLabel, nameInput, saveName);
const localNote = el('span', 'local-note', storageAvailable ? 'Csak egy becenév. Ennyi az egész.' : 'Nincs helyi tárhely · a neved csak erre a látogatásra szól.');
identityBar.append(identityForm, localNote);
const notice = el('p', 'notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
function notify(message: string) { notice.textContent = message; notice.hidden = false; }
function failed(error: unknown) { console.error(error); notify('Nem sikerült a helyi mentés. A piszkozatod megmaradt, próbáld újra.'); }

const square = el('section', 'square');
const squareHeading = el('div', 'section-heading');
const squareTitle = el('div');
const roomCount = el('span', 'count', '01');
const squareH2 = el('h2', '', 'Közös tér'); squareH2.append(roomCount);
squareTitle.append(squareH2, el('p', 'muted', 'Csatlakozz egy beszélgetéshez, vagy indíts egyet.'));
const createButton = button('+ Új szoba', 'primary-button'); createButton.disabled = true;
squareHeading.append(squareTitle, createButton);
const roomList = el('div', 'room-list');
const squareFooter = el('div', 'square-footnote');
squareFooter.append(el('span', '', 'Minden szoba nyilvános. Bárki csatlakozhat.'), el('span', 'mono', 'SZOBÁK: 6 ÓRA / ÜZENETEK: 30 PERC'));
square.append(squareHeading, roomList, squareFooter);

const roomView = el('section', 'room-view'); roomView.hidden = true;
const back = el('a', 'back-link', '← Vissza a közös térre'); back.href = '#';
const roomHeader = el('div', 'room-header');
const roomTitle = el('h2');
const roomMeta = el('p', 'muted mono');
const roomHeaderCopy = el('div'); roomHeaderCopy.append(roomTitle, roomMeta);
const roomBadge = el('span', 'public-badge', '↗ NYILVÁNOS SZOBA'); roomHeader.append(roomHeaderCopy, roomBadge);
const messageList = el('div', 'messages'); messageList.setAttribute('role', 'log'); messageList.setAttribute('aria-label', 'Beszélgetés'); messageList.setAttribute('aria-live', 'polite');
const composer = el('form', 'composer');
const messageLabel = el('label', 'sr-only', 'Üzenet'); messageLabel.htmlFor = 'message';
const messageInput = el('textarea'); messageInput.id = 'message'; messageInput.name = 'message'; messageInput.rows = 2; messageInput.maxLength = 2000; messageInput.required = true; messageInput.placeholder = 'Mi jár a fejedben?';
const composerBottom = el('div', 'composer-bottom');
const characterCount = el('span', 'muted mono', '0 / 2000');
const sendButton = button('Küldés ↗', 'primary-button'); sendButton.type = 'submit';
composerBottom.append(characterCount, sendButton);
composer.append(messageLabel, messageInput, composerBottom);
roomView.append(back, roomHeader, messageList, composer, el('p', 'composer-hint', 'Enter: küldés · Shift + Enter: új sor · 30 perc után eltűnik'));

const privacy = el('aside', 'privacy-note');
privacy.append(el('span', 'privacy-icon', '◷'), el('p', '', 'Az üzenetek a hivatalos alkalmazásban ideiglenesek, de más résztvevők elmenthetik vagy rögzíthetik őket.'));
const footer = el('footer', 'site-footer');
const footerCopy = el('div'); footerCopy.append(el('span', 'footer-brand', 'CsittChat'), el('span', 'muted', 'Egy hely, egy kis időre.'));
const about = el('details', 'about');
about.append(el('summary', '', 'Hogyan működik? ↗'), el('p', '', 'A böngésződ tárolja a nyilvános szobákat és üzeneteket, és GenosDB, illetve WebRTC segítségével osztja meg őket más böngészőkkel. A közvetítő szerverek a kapcsolat felépítését segítik, nem a beszélgetéseket tárolják. A szobák 6 óráig, az üzenetek 30 percig élnek. A #main szoba mindig nyitva marad. A létszám becsült, a nevek nem hitelesítettek. Az elérhetőség attól függ, hogy más résztvevők böngészői elérhetők-e.'));
footer.append(footerCopy, about);
main.append(intro, identityBar, notice, square, roomView, privacy, footer);
app.append(header, main);

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
  const name = nameInput.value.trim();
  if (!validText(name, 40)) { notify('Válassz 1–40 karakteres becenevet, sortörés és vezérlőkarakterek nélkül.'); return; }
  identity.name = name; nameInput.value = name;
  try { localStorage.setItem('ephemeral.identity.v1', JSON.stringify(identity)); notify('A becenevedet elmentettük ebben a böngészőben.'); }
  catch { notify('A beceneved megváltozott erre a látogatásra, de a böngésző tárhelye nem érhető el.'); }
};

createForm.onsubmit = async e => {
  e.preventDefault();
  if (!store || createSubmit.disabled) return;
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
  if (!store || !selected || writeBusy) return;
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
  if (!store) return;
  const now = Date.now();
  try { await store.put({ kind: 'presence', id: sessionId, roomId: selected, authorId: identity.id, createdAt: now, expiresAt: now + PRESENCE_TTL }); }
  catch (error) { failed(error); }
}

function navigate() {
  if (selected) drafts.set(selected, messageInput.value);
  const id = location.hash.startsWith('#room/') ? location.hash.slice(6) : null;
  selected = isRoomId(id) ? id : null;
  square.hidden = selected !== null; intro.hidden = selected !== null; roomView.hidden = selected === null;
  lastMessageSignature = '';
  messageInput.value = selected ? drafts.get(selected) || '' : '';
  characterCount.textContent = `${messageInput.value.length.toLocaleString('hu-HU')} / 2000`;
  render(); void heartbeat();
}
window.addEventListener('hashchange', navigate);
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
  if (id === 'main') titleLine.append(el('span', 'default-badge', 'A KÖZÖS SZOBA'));
  const activity = el('p', 'room-activity'); copy.append(titleLine, activity);
  const metrics = el('div', 'room-metrics'); const people = el('span'); const time = el('span', 'room-time'); metrics.append(people, time);
  const join = el('a', 'join-button', 'Belépés ↗'); join.href = `#room/${id}`;
  join.setAttribute('aria-label', id === 'main' ? 'Belépés a #main szobába' : 'Belépés a szobába');
  node.append(symbol, copy, metrics, join);
  const card = { node, title, people, time, activity }; cards.set(id, card); return card;
}

function render() {
  const now = Date.now();
  const peers = store?.db.room ? Object.keys(store.db.room.getPeers()).length : 0;
  statusDot.classList.toggle('connected', peers > 0);
  statusText.textContent = !store ? 'Helyi tárhely indítása…' : !navigator.onLine ? 'Nincs internet · helyben mentve' : peers > 0 ? `${peers} közvetlen kapcsolat` : 'Kapcsolatok keresése…';
  status.title = 'A közvetlen WebRTC-kapcsolatok száma, nem a hálózat teljes létszáma. Egy kapcsolat önmagában nem igazolja az üzenet kézbesítését.';
  const rooms = [...store?.rooms.values() || []].filter(r => r.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  roomCount.textContent = String(rooms.length + 1).padStart(2, '0');
  const ids = ['main', ...rooms.map(r => r.id)];
  for (const [id, card] of cards) if (!ids.includes(id)) { card.node.remove(); cards.delete(id); }
  for (const id of ids) {
    const room = store?.rooms.get(id);
    const card = cards.get(id) || roomCard(id);
    card.title.textContent = room?.title || '#main';
    const participants = store?.participants(id, now) || 0;
    card.people.textContent = `Kb. ${participants} fő`;
    card.time.textContent = room ? `Még ${duration(room.expiresAt - now)}` : 'Mindig nyitva';
    const recent = store?.visibleMessages(id, now).at(-1);
    card.activity.textContent = recent ? `Utolsó üzenet óta: ${duration(now - recent.createdAt)}${room ? ` · Szoba kora: ${duration(now - room.createdAt)}` : ''}` : room ? `Szoba kora: ${duration(now - room.createdAt)} · Kezdd te a beszélgetést!` : 'Az ajtó mindig nyitva. Nézz be és köszönj!';
    // Only move nodes when order changes, preserving keyboard focus.
    const index = ids.indexOf(id);
    if (roomList.children[index] !== card.node) roomList.insertBefore(card.node, roomList.children[index] || null);
  }
  if (!selected) return;
  const room = store?.rooms.get(selected);
  const available = selected === 'main' || !!room && room.expiresAt > now;
  roomTitle.textContent = selected === 'main' ? '#main' : room?.title || 'A szoba nem érhető el';
  roomMeta.textContent = available ? `${room ? `Még ${duration(room.expiresAt - now)}` : 'Mindig nyitva'} · ${store?.participants(selected, now) || 0} fő · becsült létszám` : 'A szoba lejárhatott, vagy még nem kapcsolódott olyan résztvevő, akinél megtalálható.';
  messageInput.disabled = !store || !available;
  sendButton.disabled = !store || !available || writeBusy;
  const messages = available ? store?.visibleMessages(selected, now) || [] : [];
  const signature = `${selected}:${available}:${messages.map(m => m.id).join(',')}`;
  if (signature !== lastMessageSignature) {
    const atBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 90;
    const previousScroll = messageList.scrollTop;
    const initial = !lastMessageSignature;
    lastMessageSignature = signature;
    const nodes: HTMLElement[] = [];
    if (!messages.length) {
      const empty = el('div', 'empty-conversation');
      empty.append(el('span', 'empty-symbol', '↳'), el('h3', '', available ? 'Valahol minden beszélgetés elkezdődik.' : 'Most nincs itt semmi.'), el('p', 'muted', available ? 'Köszönj be, kérdezz valamit. Töltsünk itt egy kis időt!' : 'Térj vissza a közös térre, vagy várd meg, amíg a böngészők szinkronizálnak.'));
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
    const db: GDB = await gdb(import.meta.env.VITE_CHAT_NETWORK || 'ephemeral-pub-v1', { rtc: { cells: true } });
    store = new ChatStore(db, scheduleRender, failed);
    await store.start();
    createButton.disabled = false;
    for (const event of ['peer:join', 'peer:leave', 'mesh:state']) db.room?.on(event, scheduleRender);
    navigate();
    setInterval(() => { render(); void store?.sweep(); }, 1000);
    setInterval(() => void heartbeat(), 25000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); void store?.sweep(); void heartbeat(); } });
    window.addEventListener('online', () => { render(); void heartbeat(); });
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
void start();
