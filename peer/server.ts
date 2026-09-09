import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gdbServer } from './vendor/genossrv.min.js';
import { ChatStore } from './shared/store.ts';
import { cleanGraph } from './policy.ts';
import { verifyRecord } from './shared/verify.mjs';

const network = process.env.GDB_ROOM || 'ephemeral-pub-v3';
const dbPath = resolve(process.env.GDB_DB_PATH || './data/chat.sqlite');
const relay = process.env.GDB_RELAY === '1';
const port = Number(process.env.PORT || 8080);
const healthPort = Number(process.env.HEALTH_PORT || 8081);
const interval = Number(process.env.CLEANUP_INTERVAL_MS || 1000);
if (![port, healthPort].every(p => Number.isInteger(p) && p > 0 && p < 65536) || port === healthPort) throw new Error('Invalid PORT / HEALTH_PORT');
if (!Number.isInteger(interval) || interval < 100 || interval > 60000) throw new Error('Invalid CLEANUP_INTERVAL_MS');
await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
process.env.GDB_RELAY = relay ? '1' : '0';
process.env.PORT = String(port);

// GDB_RELAY_URLS controls external discovery; when relay mode is on, the SDK
// also adds its embedded local relay. No presence records are written here.
const db = await gdbServer(network, {
  rtc: { cells: true }, room: true, saveDelay: 100, oplogSize: 1000,
}, dbPath);
let errors = 0;
let cleaning = false;
let stopping = false;
let lastCleanup = 0;
let removed = 0;
const fail = () => { errors++; console.error('CsittChat: database operation failed; retrying.'); };
const store = new ChatStore(db, () => {}, fail, verifyRecord);
await cleanGraph(db, Date.now(), verifyRecord);
await store.start();
db.room?.on('peer:join', () => store.scheduleHistoryRecovery());
if (db.room && Object.keys(db.room.getPeers()).length) store.scheduleHistoryRecovery();

async function sweep() {
  if (cleaning || stopping) return;
  cleaning = true;
  try { await store.sweep(); removed += await cleanGraph(db, Date.now(), verifyRecord); lastCleanup = Date.now(); }
  catch { fail(); }
  finally { cleaning = false; }
}
await sweep();
const timer = setInterval(() => void sweep(), interval);
// Health reports no names, message text, IP addresses or graph contents.
const health = Bun.serve({ hostname: process.env.HEALTH_HOST || '127.0.0.1', port: healthPort, fetch(request) {
  if (new URL(request.url).pathname !== '/healthz') return new Response('Not found', { status: 404 });
  const ok = !stopping && Date.now() - lastCleanup < Math.max(30000, interval * 3);
  return Response.json({ ok, lastCleanup, removed, errors, records: { profiles: store.profiles.size, rooms: store.rooms.size, messages: store.messages.size, presence: store.presence.size } }, { status: ok ? 200 : 503 });
} });
console.log(`CsittChat peer ready; network=${network}; relay=${relay}; health=${healthPort}`);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  store.stop();
  health.stop();
  // Allow the SDK's debounced save to finish; SQLite WAL handles crash recovery.
  await Bun.sleep(500);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
