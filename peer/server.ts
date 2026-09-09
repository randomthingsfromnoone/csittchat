import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { peerConfig } from './config.ts';
import { ChatStore } from './shared/store.ts';
import { cleanGraph } from './policy.ts';
import { verifyRecord } from './shared/verify.mjs';

export async function startPeer(config = peerConfig) {
  const { network, relay, port, healthPort, healthHost, cleanupIntervalMs: interval } = config;
  const dbPath = resolve(config.dbPath);
  if (
    ![port, healthPort].every((p) => Number.isInteger(p) && p > 0 && p < 65536) ||
    port === healthPort
  )
    throw new Error('Invalid peer ports');
  if (!Number.isInteger(interval) || interval < 100 || interval > 60000)
    throw new Error('Invalid cleanup interval');
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  // The unmodified SDK takes relay options through process.env. Set them from our
  // code configuration before loading it; external environment values cannot override them.
  process.env.GDB_RELAY = relay ? '1' : '0';
  process.env.GDB_RELAY_URLS = config.relayUrls.join(',');
  process.env.GDB_ROOM = network;
  process.env.GDB_DB_PATH = dbPath;
  process.env.GDB_CELLS = '1';
  process.env.PORT = String(port);
  process.env.DEBUG = config.debug ? '1' : '';
  const { gdbServer } = await import('./vendor/genossrv.min.js');

  const db = await gdbServer(
    network,
    {
      rtc: { cells: true },
      room: true,
      saveDelay: 100,
      oplogSize: 1000,
    },
    dbPath,
  );
  let errors = 0;
  let cleaning = false;
  let stopping = false;
  let lastCleanup = 0;
  let removed = 0;
  const fail = () => {
    errors++;
    console.error('CsittChat: database operation failed; retrying.');
  };
  const store = new ChatStore(db, () => {}, fail, verifyRecord);
  await cleanGraph(db, Date.now(), verifyRecord);
  await store.start();
  db.room?.on('peer:join', () => store.scheduleHistoryRecovery());
  if (db.room && Object.keys(db.room.getPeers()).length) store.scheduleHistoryRecovery();

  async function sweep() {
    if (cleaning || stopping) return;
    cleaning = true;
    try {
      await store.sweep();
      removed += await cleanGraph(db, Date.now(), verifyRecord);
      lastCleanup = Date.now();
    } catch {
      fail();
    } finally {
      cleaning = false;
    }
  }
  await sweep();
  const timer = setInterval(() => void sweep(), interval);
  // Health reports no names, message text, IP addresses or graph contents.
  const health = Bun.serve({
    hostname: healthHost,
    port: healthPort,
    fetch(request) {
      if (new URL(request.url).pathname !== '/healthz')
        return new Response('Not found', { status: 404 });
      const ok = !stopping && Date.now() - lastCleanup < Math.max(30000, interval * 3);
      return Response.json(
        {
          ok,
          lastCleanup,
          removed,
          errors,
          records: {
            profiles: store.profiles.size,
            rooms: store.rooms.size,
            messages: store.messages.size,
            presence: store.presence.size,
          },
        },
        { status: ok ? 200 : 503 },
      );
    },
  });
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
}

if (import.meta.main) await startPeer();
