// Public settings shared with the always-on peer. Never put credentials here.
export const chatConfig = {
  network: 'ephemeral-pub-v3',
  relayUrls: [] as string[], // Empty uses GenosDB's public discovery relays.
  debug: false,
};
