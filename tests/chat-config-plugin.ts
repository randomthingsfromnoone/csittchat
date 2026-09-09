import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { chatConfig } from '../src/config.ts';

// Only test runners install this plugin. Production builds use src/config.ts as-is.
export function testChatConfig(overrides: Partial<typeof chatConfig>): Plugin {
  const configPath = resolve(import.meta.dirname, '../src/config.ts');
  return {
    name: 'isolated-chat-test-config',
    enforce: 'pre',
    load(id) {
      if (id.split('?')[0] !== configPath) return;
      return `export const chatConfig = ${JSON.stringify({ ...chatConfig, ...overrides })};`;
    },
  };
}
