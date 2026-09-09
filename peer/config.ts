import { chatConfig } from './shared/config.ts';

// Public runtime settings. The systemd service can write to this data directory.
export const peerConfig = {
  ...chatConfig,
  dbPath: '/var/lib/csittchat-peer/chat.sqlite',
  relay: false,
  port: 8080,
  healthHost: '127.0.0.1',
  healthPort: 8081,
  cleanupIntervalMs: 1000,
};
