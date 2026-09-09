import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.ts';
import { testChatConfig } from './tests/chat-config-plugin.ts';

const network = process.env.TEST_CHAT_NETWORK;
if (!network || !network.startsWith('ephemeral-pub-test-'))
  throw new Error('Browser tests require an isolated TEST_CHAT_NETWORK.');

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [testChatConfig({ network, debug: process.env.TEST_GDB_DEBUG === '1' })],
  }),
);
