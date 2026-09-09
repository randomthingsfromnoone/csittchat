import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

async function setTime(page: Page, now: number) {
  await page.clock.setFixedTime(now);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

async function ready(page: Page, name = 'Vendég') {
  await page.goto('./');
  await enterName(page, name);
  await expect(page.getByRole('button', { name: '+ Új szoba', exact: true })).toBeEnabled();
}
async function enterName(page: Page, name = 'Vendég') {
  const dialog = page.getByRole('dialog', { name: 'Hogy szólíthatunk?' });
  if (await dialog.isVisible()) {
    await dialog.getByLabel('A beceneved').fill(name);
    await dialog.getByRole('button', { name: 'Belépés' }).click();
  }
}
async function createRoom(page: Page, title: string) {
  await page.getByRole('button', { name: '+ Új szoba', exact: true }).click();
  await page.getByLabel('A szoba neve', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Szoba létrehozása' }).click();
  await expect(page.getByRole('heading', { name: title, exact: true }).last()).toBeVisible();
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Üzenet', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Küldés' }).click();
  await expect(page.locator('.message-text').filter({ hasText: text })).toBeVisible();
}

test('create, send hostile-looking text safely, persist and expire records', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await ready(page, 'Alice <b>');
  await createRoom(page, 'A room <img src=x onerror=alert(1)>');
  const url = page.url();
  await send(page, 'Hello <script>alert(1)</script> & everyone');
  await expect(page.locator('.messages script, .messages img, .room-header img')).toHaveCount(0);
  await page.waitForTimeout(1000); // GenosDB persistence is debounced.
  await page.reload();
  await expect(page.locator('.current-name')).toHaveText('Alice <b>');
  await expect(page.getByRole('dialog', { name: 'Hogy szólíthatunk?' })).not.toBeVisible();
  await expect(page.locator('.message-text')).toHaveText('Hello <script>alert(1)</script> & everyone');
  const start = Date.now();
  await setTime(page, start + 31 * 60 * 1000);
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.locator('.empty-conversation')).toBeVisible();
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeEnabled();
  await expect(page.locator('.message')).toHaveCount(0);
  await setTime(page, start + 7 * 60 * 60 * 1000);
  await expect(page.getByRole('heading', { name: 'A szoba nem érhető el' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeDisabled();
  await page.getByRole('link', { name: 'Vissza a közös térre' }).click();
  await expect(page.locator('.room-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Belépés a #main szobába' })).toBeVisible();
  expect(url).toContain('#room/');
  expect(errors).toEqual([]);
});

test('mobile layout, empty room and unavailable deep link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Belépés a #main szobába' }).click();
  await expect(page.locator('.empty-conversation')).toBeVisible();
  await send(page, 'A small-screen thought');
  const sendBox = await page.getByRole('button', { name: 'Küldés' }).boundingBox();
  expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('./#room/11111111-1111-4111-8111-111111111111');
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'A szoba nem érhető el' })).toBeVisible();
});

test('a new message restarts six hours and the renewal survives message expiry and reload', async ({ page }) => {
  await ready(page, 'Aktív vendég');
  await createRoom(page, 'Hosszabbodó szoba');
  const start = Date.now();
  await setTime(page, start + 5 * 60 * 60 * 1000);
  await expect(page.locator('.room-header .muted')).toContainText('Még 1 óra');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeEnabled();
  await send(page, 'Maradjunk még!');
  await expect(page.locator('.room-header .muted')).toContainText('Még 6 óra');
  await page.waitForTimeout(1000);
  await setTime(page, start + 7 * 60 * 60 * 1000);
  await expect(page.locator('.message')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeEnabled();
  await expect(page.locator('.room-header .muted')).toContainText('Még 4 óra');
  await setTime(page, start + 11 * 60 * 60 * 1000 - 1000);
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeEnabled();
  await setTime(page, start + 11 * 60 * 60 * 1000);
  await expect(page.getByRole('heading', { name: 'A szoba nem érhető el' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeDisabled();
});

test('independent contexts discover rooms and exchange messages over real WebRTC', async ({ browser }) => {
  test.skip(process.env.TEST_P2P !== '1', 'Opt in with TEST_P2P=1; requires reachable public discovery relays and WebRTC.');
  test.setTimeout(150000);
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const alice = await a.newPage(); const bob = await b.newPage();
    await Promise.all([ready(alice, 'Alice'), ready(bob, 'Bob')]);
    await createRoom(alice, 'Independent browser room');
    await expect(bob.getByRole('heading', { name: 'Independent browser room', exact: true })).toBeVisible({ timeout: 90000 });
    await bob.locator('.room-card').filter({ hasText: 'Independent browser room' }).getByRole('link', { name: 'Belépés a szobába' }).click();
    await send(alice, 'Hello from Alice');
    await expect(bob.locator('.message-text')).toContainText(['Hello from Alice']);
    await send(bob, 'Hello from Bob');
    await expect(alice.locator('.message-text')).toContainText(['Hello from Alice', 'Hello from Bob']);
    await bob.waitForTimeout(1000);
    await bob.reload();
    await expect(bob.locator('.message-text')).toContainText(['Hello from Alice', 'Hello from Bob']);
    await bob.close();
    await send(alice, 'A thought while Bob was away');
    const returningBob = await b.newPage();
    await returningBob.goto(alice.url());
    await enterName(returningBob, 'Visszatérő Bob');
    await expect(returningBob.locator('.message-text')).toContainText(
      ['Hello from Alice', 'Hello from Bob', 'A thought while Bob was away'], { timeout: 30000 },
    );
  } finally { await a.close(); await b.close(); }
});

test('late joiner loads existing main history before any new messages are sent', async ({ browser }, testInfo) => {
  test.skip(process.env.TEST_P2P !== '1', 'Requires public discovery and WebRTC.');
  test.setTimeout(120000);
  const a = await browser.newContext();
  const b = await browser.newContext();
  const log: string[] = [];
  let c: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    const alice = await a.newPage();
    alice.on('console', message => log.push(`alice ${message.type()} ${message.text()}`));
    await ready(alice);
    await alice.getByRole('link', { name: 'Belépés a #main szobába' }).click();
    await send(alice, 'History written before the other browser joins');
    const originalId = await alice.locator('.message').getAttribute('data-message-id');
    const originalExpiry = await alice.locator('.message-expiry').getAttribute('data-expires');
    await alice.waitForTimeout(1000);
    const bob = await b.newPage();
    bob.on('console', message => log.push(`bob ${message.type()} ${message.text()}`));
    await ready(bob, 'Bob');
    await bob.getByRole('link', { name: 'Belépés a #main szobába' }).click();
    await expect(bob.locator('.message-text')).toContainText(['History written before the other browser joins'], { timeout: 90000 });
    await bob.waitForTimeout(21000); // Both delayed recovery attempts can run.
    await expect(bob.locator('.message')).toHaveCount(1);
    await expect(bob.locator('.message')).toHaveAttribute('data-message-id', originalId!);
    await expect(bob.locator('.message-expiry')).toHaveAttribute('data-expires', originalExpiry!);
    await alice.close();
    c = await browser.newContext();
    const charlie = await c.newPage();
    charlie.on('console', message => log.push(`charlie ${message.type()} ${message.text()}`));
    await ready(charlie, 'Új látogató');
    await charlie.getByRole('link', { name: 'Belépés a #main szobába' }).click();
    await expect(charlie.locator('.message-text')).toContainText(['History written before the other browser joins'], { timeout: 30000 });
    await expect(charlie.locator('.message-expiry')).toHaveAttribute('data-expires', originalExpiry!);
  } finally {
    const logPath = testInfo.outputPath('sync.log');
    await writeFile(logPath, log.join('\n'));
    await testInfo.attach('sync-log', { path: logPath, contentType: 'text/plain' });
    await a.close(); await b.close(); await c?.close();
  }
});

test('name is chosen once, survives reload and resets in a fresh tab', async ({ page, context }) => {
  await page.goto('./');
  const prompt = page.getByRole('dialog', { name: 'Hogy szólíthatunk?' });
  await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Belépés' }).click();
  await expect(prompt).toBeVisible();
  await enterName(page, 'Árvíztűrő');
  await expect(page.locator('.current-name')).toHaveText('Árvíztűrő');
  await expect(page.getByLabel('A beceneved')).not.toBeVisible();
  await page.reload();
  await expect(prompt).not.toBeVisible();
  await expect(page.locator('.current-name')).toHaveText('Árvíztűrő');
  const second = await context.newPage();
  await second.goto('./');
  await expect(second.getByRole('dialog', { name: 'Hogy szólíthatunk?' })).toBeVisible();
  await enterName(second, 'Másik név');
  await expect(second.locator('.current-name')).toHaveText('Másik név');
  await expect(page.locator('.current-name')).toHaveText('Árvíztűrő');
});

test('switching rooms and reloading retains main history', async ({ page }) => {
  await ready(page, 'Előzményteszt');
  await page.getByRole('link', { name: 'Belépés a #main szobába' }).click();
  await send(page, 'A mainben maradó üzenet');
  await page.getByRole('link', { name: 'Vissza a közös térre' }).click();
  await createRoom(page, 'Másik beszélgetés');
  await expect(page.locator('.message-text')).toHaveCount(0);
  await page.getByRole('link', { name: 'Vissza a közös térre' }).click();
  await page.getByRole('link', { name: 'Belépés a #main szobába' }).click();
  await expect(page.locator('.message-text')).toHaveText('A mainben maradó üzenet');
  await page.getByRole('button', { name: 'Újratöltés' }).click();
  await expect(page.locator('.message-text')).toHaveText('A mainben maradó üzenet');
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator('.message-text')).toHaveText('A mainben maradó üzenet');
});

test('reserved names cannot be taken and a persistent account restores with its twelve words', async ({ page, context }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Új tartós fiók', exact: true }).click();
  await page.getByLabel('A beceneved', { exact: true }).fill('Tartós Teszt');
  const words = await page.locator('.recovery-words li').allTextContents();
  expect(words).toHaveLength(12);
  await expect(page.getByRole('button', { name: 'Belépés →', exact: true })).toBeDisabled();
  await page.getByLabel('Elmentettem a 12 szót.').check();
  await page.getByRole('button', { name: 'Belépés →', exact: true }).click();
  await expect(page.locator('.current-name')).toHaveText('Tartós Teszt');
  const other = await context.newPage();
  await other.goto('./');
  await other.getByLabel('A beceneved', { exact: true }).fill('  tartós teszt  ');
  await other.getByRole('button', { name: 'Belépés →', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText('foglalt');
  await other.getByRole('button', { name: 'Visszaállítás', exact: true }).click();
  await other.getByLabel('A 12 helyreállító szó').fill(words.join(' '));
  await other.getByRole('button', { name: 'Fiók visszaállítása' }).click();
  await expect(other.locator('.current-name')).toHaveText('Tartós Teszt');
  await other.getByRole('button', { name: 'Felhasználók', exact: true }).click();
  await expect(other.getByRole('dialog', { name: 'Felhasználók', exact: true }).getByText('Tartós Teszt', { exact: true })).toBeVisible();
  await page.locator('.current-name').click();
  await page.getByRole('button', { name: 'Kijelentkezés' }).click();
  await expect(page.getByRole('dialog', { name: 'Hogy szólíthatunk?' })).toBeVisible();
});

test('unread badges stay local and opening a conversation shares a named read receipt', async ({ page, context }) => {
  await ready(page, 'Számláló Alice');
  await createRoom(page, 'Olvasatlan teszt');
  const bob = await context.newPage();
  await ready(bob, 'Számláló Bob');
  const card = bob.locator('.room-card').filter({ hasText: 'Olvasatlan teszt' });
  await expect(card).toBeVisible();
  await page.bringToFront();
  await send(page, 'Ezt még csak Alice látja.');
  await expect(card.locator('.unread-badge')).toHaveText('1');
  await expect(page.locator('.unread-badge')).toHaveCount(0);
  await bob.bringToFront();
  await card.getByRole('link', { name: 'Belépés a szobába', exact: true }).click();
  await expect(bob.locator('.message-text')).toHaveText('Ezt még csak Alice látja.');
  await expect(card.locator('.unread-badge')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Látta: 1', exact: true })).toBeVisible();
  await page.bringToFront();
  await page.getByRole('button', { name: 'Látta: 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Látta', exact: true }).getByText('Számláló Bob', { exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Látta', exact: true }).getByRole('button', { name: 'Bezárás' }).click();
  // Headless Chromium can report every target as focused; simulate a hidden tab explicitly.
  await bob.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(800); // Respect the existing 750 ms send limit.
  await send(page, 'Háttérben még olvasatlan.');
  await expect(card.locator('.unread-badge')).toHaveText('1');
  await bob.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden'); Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'));
  });
  await bob.bringToFront();
  await expect(card.locator('.unread-badge')).toHaveCount(0);
  await bob.reload();
  await expect(bob.locator('.message-text')).toHaveCount(2);
  await expect(card.locator('.unread-badge')).toHaveCount(0);
});

test('registration and restoration never call a central identity API', async ({ page }) => {
  const identityRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('identity-api')) identityRequests.push(request.url()); });
  await ready(page, 'P2P vendég');
  await page.reload();
  await expect(page.locator('.current-name')).toHaveText('P2P vendég');
  expect(identityRequests).toEqual([]);
});
