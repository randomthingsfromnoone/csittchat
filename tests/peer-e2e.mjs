import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { testChatConfig } from './chat-config-plugin.ts';
import { createProfile, hex, signRecord } from '../src/auth-proof.ts';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = here;
const state = await mkdtemp('/tmp/csittchat-peer-test-');
const bun = process.env.TEST_BUN;
if (!bun) throw new Error('Set TEST_BUN to the Bun 1.4.2 executable.');
const suffix = String(process.pid);
const name = `csittchat-e2e-${suffix}`;
const network = name;
const relayPort = Number(process.env.TEST_RELAY_PORT || 18480);
const healthPort = Number(process.env.TEST_HEALTH_PORT || 18481);
const appPort = Number(process.env.TEST_APP_PORT || 18482);
const publicRelays = process.env.TEST_PUBLIC_RELAYS === '1';
const externalRelays = process.env.TEST_RELAY_URLS || '';
async function until(fn, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for peer state');
}
async function health() {
  return (await fetch(`http://127.0.0.1:${healthPort}/healthz`)).json();
}
let peer;
let peerExited;
async function startPeer() {
  const entry = resolve(state, 'start-peer.mjs');
  // Use an explicit test entry point, never runtime environment overrides.
  await writeFile(
    entry,
    `
    import { startPeer } from ${JSON.stringify(pathToFileURL(resolve(root, 'peer/server.ts')).href)};
    import { peerConfig } from ${JSON.stringify(pathToFileURL(resolve(root, 'peer/config.ts')).href)};
    await startPeer({ ...peerConfig, ...${JSON.stringify({
      network,
      relay: !publicRelays,
      relayUrls: publicRelays && externalRelays ? externalRelays.split(',') : [],
      dbPath: resolve(state, 'chat.sqlite'),
      port: relayPort,
      healthPort,
    })} });
  `,
  );
  peer = spawn(bun, [entry], { cwd: state, stdio: ['ignore', 'pipe', 'pipe'] });
  peer.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  peer.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  peerExited = new Promise((resolveExit, reject) => {
    peer.once('exit', resolveExit);
    peer.once('error', reject);
  });
  await Promise.race([
    until(async () => (await health()).ok),
    peerExited.then(() => {
      throw new Error('Peer exited during startup');
    }),
  ]);
}
async function stopPeer() {
  if (!peer || peer.exitCode !== null || peer.signalCode !== null) return;
  peer.kill('SIGTERM');
  const timer = setTimeout(() => peer.kill('SIGKILL'), 10000);
  try {
    await peerExited;
  } finally {
    clearTimeout(timer);
  }
}
let vite;
let browser;
const logs = [];
try {
  await startPeer();
  vite = await createServer({
    root,
    server: { host: '127.0.0.1', port: appPort, strictPort: true },
    plugins: [
      testChatConfig({
        network,
        relayUrls: publicRelays
          ? externalRelays
            ? externalRelays.split(',')
            : []
          : [`ws://127.0.0.1:${relayPort}`],
      }),
      {
        name: 'policy-probe-page',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/policy-probe.html') return next();
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><title>Policy probe</title>');
          });
        },
      },
    ],
  });
  await vite.listen();
  for (const path of [
    '/peer/server.ts',
    '/peer/server.ts?raw',
    '/peer/setup-systemd.sh',
    '/peer/config.ts',
    '/peer/shared/config.ts',
  ]) {
    const response = await fetch(`http://127.0.0.1:${appPort}${path}`);
    assert.equal(response.status, 403, `server file must not be served by Vite: ${path}`);
  }
  browser = await chromium.launch({ headless: true });
  async function join(words) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('console', (event) => logs.push(event.text()));
    page.on('websocket', (socket) => logs.push(`browser websocket: ${socket.url()}`));
    await page.goto(`http://127.0.0.1:${appPort}/`);
    if (words) {
      await page.getByRole('button', { name: 'Visszaállítás', exact: true }).click();
      await page.getByLabel('A 12 helyreállító szó').fill(words.join(' '));
      await page.getByRole('button', { name: 'Fiók visszaállítása' }).click();
    } else {
      await page.getByRole('button', { name: 'Új tartós fiók', exact: true }).click();
      await page.getByLabel('A beceneved').fill('P2P szerverteszt');
      words = await page.locator('.recovery-words li').allTextContents();
      await page.getByLabel('Elmentettem a 12 szót.').check();
      await page.getByRole('button', { name: 'Belépés →', exact: true }).click();
    }
    await expect(page.locator('.current-name')).toHaveText('P2P szerverteszt', { timeout: 30000 });
    await expect(page.getByRole('button', { name: '+ Új szoba', exact: true })).toBeEnabled();
    await page.getByRole('link', { name: 'Belépés a #main szobába' }).click();
    return { context, page, words };
  }
  const first = await join();
  await first.page
    .getByRole('textbox', { name: 'Üzenet', exact: true })
    .fill('Megmarad a szerver újraindítása után');
  await first.page.getByRole('button', { name: 'Küldés' }).click();
  await until(async () => (await health()).records.messages === 1);
  assert.equal((await health()).records.profiles, 1, 'persistent profile must reach the peer');
  assert.equal((await health()).records.presence, 1, 'server must not publish human presence');
  const expiry = await first.page.locator('.message-expiry').getAttribute('data-expires');
  await first.context.close();
  await new Promise((r) => setTimeout(r, 1000));
  console.log('PASS: browser message reached the server; all browsers closed.');
  await stopPeer();
  await startPeer();
  assert.equal((await health()).records.messages, 1, 'message must survive process restart');
  console.log('PASS: restarted Bun peer loaded the message from the same SQLite file.');
  assert.equal(
    (await health()).records.profiles,
    1,
    'persistent profile must survive process restart',
  );
  const second = await join(first.words);
  await expect(second.page.locator('.message-text')).toHaveText(
    'Megmarad a szerver újraindítása után',
    { timeout: 45000 },
  );
  await expect(second.page.locator('.message-expiry')).toHaveAttribute('data-expires', expiry);
  await expect(second.page.locator('.own-message')).toHaveCount(1);
  await second.context.close();
  console.log('PASS: a fresh browser retrieved unchanged history from the server alone.');
  const probeContext = await browser.newContext();
  const probe = await probeContext.newPage();
  probe.on('console', (event) => logs.push(`probe: ${event.text()}`));
  await probe.goto(`http://127.0.0.1:${appPort}/policy-probe.html`);
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const createdAt = Date.now() - 30 * 60 * 1000 + 20000;
  const profile = createProfile(secret, 'TTL probe', false, createdAt);
  const value = {
    kind: 'message',
    id: crypto.randomUUID(),
    roomId: 'main',
    authorId: profile.id,
    authorName: profile.name,
    text: 'Expires without browsers',
    createdAt,
    expiresAt: createdAt + 30 * 60 * 1000,
  };
  const signedRecord = signRecord(value, profile, secret);
  await probe.evaluate(
    async ({ network, relayPort, publicRelays, externalRelays, signedRecord }) => {
      const { gdb } = await import('/vendor/genosdb/index.js');
      const db = await gdb(network, {
        rtc: {
          cells: true,
          ...(publicRelays
            ? externalRelays
              ? { relayUrls: externalRelays.split(',') }
              : {}
            : { relayUrls: [`ws://127.0.0.1:${relayPort}`] }),
        },
      });
      const deadline = Date.now() + 30000;
      while (!Object.keys(db.room.getPeers()).length) {
        if (Date.now() > deadline) throw new Error('Probe did not connect to the peer');
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // The raw SDK probe has no ChatStore recovery. Wait for both mesh rooms
      // to settle before issuing the short-lived records as live writes.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const record = signedRecord;
      await db.put(record, `message:${record.id}`);
      const invalid = { ...record, id: crypto.randomUUID(), unexpected: true };
      await db.put(invalid, `message:${invalid.id}`);
    },
    { network, relayPort, publicRelays, externalRelays, signedRecord },
  );
  await until(async () => (await health()).records.messages === 2);
  await probeContext.close();
  // ChatStore removes expired valid records; cleanGraph counts the invalid removal.
  await until(async () => {
    const h = await health();
    return h.records.messages === 1 && h.removed >= 1;
  }, 30000);
  console.log('PASS: invalid records and expired messages were removed with all browsers closed.');
} finally {
  await browser?.close();
  await vite?.close();
  await stopPeer();
  await rm(state, { recursive: true, force: true });
  await mkdir(resolve(here, 'test-results'), { recursive: true });
  await writeFile(resolve(here, 'test-results/peer-e2e.log'), logs.join('\n'));
}
