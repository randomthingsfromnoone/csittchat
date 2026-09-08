import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173/csittchat/', headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort --base /csittchat/',
    url: 'http://127.0.0.1:4173/csittchat/',
    env: { VITE_CHAT_NETWORK: `ephemeral-pub-test-${process.pid}`, VITE_GDB_DEBUG: process.env.VITE_GDB_DEBUG || '0' },
    reuseExistingServer: false,
  },
});
