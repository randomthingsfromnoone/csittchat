import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: '+ Új szoba', exact: true })).toBeEnabled();
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
  await ready(page);
  await page.getByLabel('A beceneved').fill('Alice <b>');
  await page.getByRole('button', { name: 'Név mentése' }).click();
  await createRoom(page, 'A room <img src=x onerror=alert(1)>');
  const url = page.url();
  await send(page, 'Hello <script>alert(1)</script> & everyone');
  await expect(page.locator('.messages script, .messages img, .room-header img')).toHaveCount(0);
  await page.waitForTimeout(1000); // GenosDB persistence is debounced.
  await page.reload();
  await expect(page.getByLabel('A beceneved')).toHaveValue('Alice <b>');
  await expect(page.locator('.message-text')).toHaveText('Hello <script>alert(1)</script> & everyone');
  const start = Date.now();
  await page.clock.setFixedTime(start + 31 * 60 * 1000);
  await expect(page.locator('.message')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Valahol minden beszélgetés elkezdődik.' })).toBeVisible();
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeEnabled();
  await expect(page.locator('.message')).toHaveCount(0);
  await page.clock.setFixedTime(start + 7 * 60 * 60 * 1000);
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
  await expect(page.getByRole('heading', { name: 'Valahol minden beszélgetés elkezdődik.' })).toBeVisible();
  await send(page, 'A small-screen thought');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('./#room/11111111-1111-4111-8111-111111111111');
  await expect(page.getByRole('button', { name: 'Küldés' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'A szoba nem érhető el' })).toBeVisible();
});

test('independent contexts discover rooms and exchange messages over real WebRTC', async ({ browser }) => {
  test.skip(process.env.TEST_P2P !== '1', 'Opt in with TEST_P2P=1; requires reachable public discovery relays and WebRTC.');
  test.setTimeout(150000);
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const alice = await a.newPage(); const bob = await b.newPage();
    await Promise.all([ready(alice), ready(bob)]);
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
    await expect(returningBob.locator('.message-text')).toContainText(
      ['Hello from Alice', 'Hello from Bob', 'A thought while Bob was away'], { timeout: 30000 },
    );
  } finally { await a.close(); await b.close(); }
});
