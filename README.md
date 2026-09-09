# CsittChat

A temporary public chat with a Hungarian interface, built with React, TypeScript, Vite and GenosDB **0.34.0**. Rooms stay open until six hours after their latest message; messages expire after 30 minutes. Desktop keeps rooms beside the conversation and mobile switches between the room list and chat. Nicknames and optional permanent accounts also synchronize over GenosDB/WebRTC as signed profiles. Twelve recovery words restore a permanent account; an always-on peer can retain its public profile.

## Run

Use Node.js 24 or newer.

```sh
npm ci
npm run dev
```

Open the localhost URL shown by Vite. For another device, use an HTTPS host: a plain LAN HTTP URL is not a secure context for the browser APIs this app needs. Use a current Chromium or Firefox browser with JavaScript, WebRTC, and browser storage enabled.

```sh
npm test             # validation, TTL boundaries, replay handling, cleanup retries
npm run build        # typecheck and static production build
npm run preview      # serve dist locally
npx playwright install chromium
npm run test:e2e     # production build under /csittchat/, UI, refresh, accelerated TTL
TEST_P2P=1 npm run test:e2e  # also exercise real discovery and WebRTC in separate contexts
```

The browser suite uses its own network name so tests do not post in the public square. The P2P test is opt-in because public relays and network conditions are outside this repository's control. Browser test screenshots and traces on failure go to `test-results/`.

## Architecture and storage

Before login, every client opens `gdb('ephemeral-pub-v3', { rtc: { cells: true } })` to discover existing profiles. `db.put(value, id)` stores records locally; `db.map({ realtime: true }, callback)` receives the initial graph and later additions, updates, and removals. Entering a room also reads its newest 500 message records directly from the graph and maintains a separate realtime room subscription, independent of the global activity cache. Switching rooms cancels the old subscription and ignores late results; reconnect/focus and the reload button reread the available history. The UI distinguishes reading local history from waiting for remote history: a participant count does not prove that messages have synchronized. GenosDB persists through its browser storage worker (OPFS, with fallbacks including IndexedDB), synchronizes same-origin tabs through BroadcastChannel, and replicates between browsers over GenosRTC/WebRTC. Cellular Mesh is enabled consistently for every peer.

In testing with 0.34.0, the initial history handshake sometimes failed to complete even though later presence updates arrived. To recover, peers repeat ordinary `db.put(value, id)` writes 5 and 20 seconds after application-peer joins or resuming the page. Join bursts are debounced. Each pass reads up to 10,000 live profiles, 1,000 live rooms and the newest 500 live messages and up to 1,000 receipts across the database, checks they still exist and have not expired, and preserves their IDs, content, authors, and original TTLs. Any holder can forward history after the author leaves. This adds bounded traffic and does not guarantee recovery beyond those limits. The vendor code and wire protocol are unchanged. The reload button only rereads the local graph; it cannot request missing data from other browsers. Existing open clients should refresh after deploying this update so they can also perform recovery.

GenosRTC uses external discovery/signaling infrastructure, including Nostr relays, to arrange peer connections. **Those relays are not the message database.** The dependency may fetch its relay directory and contact STUN services; these are discovery/connectivity resources. Public profiles use the same P2P graph as conversations; there is no identity REST API or central name registry. WebRTC transport encryption does not make these public conversations private.

GenosDB stores five kinds of node, with explicit IDs `kind:uuid`:

| Kind | Stored value | Lifetime |
| --- | --- | --- |
| Profile | Key-derived ID, name, public key, permanence, claim/renewal times, signature | Permanent accounts do not expire; guest leases last 90 seconds, with profiles retained another 30 minutes for historical proofs |
| Room | ID, title, creator ID, creation, expiry, last activity time | 6 hours after the latest message (creation if empty) |
| Message | ID, room ID, author ID/name, text, creation, expiry, signed profile/signature | 30 minutes |
| Presence | Per-tab session ID, author ID/name, selected room, heartbeat, expiry, signed profile/signature | 90 seconds, renewed every 25 seconds |
| Receipt | Message and room ID, reader ID/name, seen time, expiry, signed profile/signature | Until the message expires |

`#main` is a built-in room and needs no persistent room node. On entry, choose a guest nickname, create a permanent account or restore one with its 12 recovery words. Guest names have renewable 90-second leases. Permanent names stay reserved offline. Clients normalize Unicode, case and whitespace and reject names already claimed in their known graph. Each browser tab keeps its login key in `sessionStorage`; a new session requires login again. Recovery words are generated in the browser and never sent to another participant. Ed25519 keys are derived from the BIP39 seed; the public key determines the account ID.

Name reservations converge when peers exchange profiles. Simultaneous claims use the earliest claimed creation time, then the account ID as a tie-breaker. A client that later discovers an earlier claim returns to login. **This is not an atomic global reservation:** disconnected peers may temporarily use the same name, and a modified peer can backdate a claim. An always-on peer improves availability but does not make it a trusted authority. Signatures prove ownership of an account key, not exclusive ownership of a human-readable name.

Permanent public profiles must survive on at least one reachable peer or in a backup. Recovery words alone cannot recover the nickname if all profile copies are lost. Restoration waits up to 22 seconds for a profile to arrive; local tab refresh can use its saved signed profile. Guest renewals keep the active claim time; returning after a lease gap starts a new claim. Older heartbeat replays cannot shorten a newer lease already observed by a peer.

React components live in `src/components`; `src/client.ts` owns connections, identity renewal, navigation, drafts and receipt delivery. Components subscribe through React’s `useSyncExternalStore`. The existing `ChatStore` continues to validate, cache and expire records.

Unread badges count other authors’ known unexpired messages, display at most `99+`, and also appear in the document title. Read message IDs and expiries are stored locally per identity/network and merged across tabs. A timestamp watermark is not used, so late-arriving history remains unread. Only messages intersecting the conversation viewport in a focused, visible tab without an open dialog are marked read. Own messages do not increase the badge. A signed receipt exposes the reader’s nickname in each message’s expandable “Látta” list; it expires with the message. This indicates display, not proof of human attention. Hidden tabs do not publish receipts. Storage denial falls back to memory. Counters cover the bounded history available to this browser, not every message in the network.

The public user list shows online guest names and permanent accounts (up to 1000 rows). Room participant counts still use unexpired signed presence records and can lag. The header reports direct peer connections, not message delivery.

All public rooms share one database/network. Room IDs select a view; **all peers can receive all public messages**, whether or not they joined a room. GenosDB supports separation through different database names, but separate per-room networks would add discovery and lifecycle complexity to this MVP. To intentionally isolate another deployment, set `VITE_CHAT_NETWORK` at build time; peers must use the same name to meet. The default makes deployments of this experiment share a square.

## Expiration and trust

Room expiry is exactly `lastActivityAt + 6 hours`. Activity starts at creation and advances to each new message’s creation time while the room is still open. A busy room can therefore live longer than six hours in total; an empty room closes six hours after creation. The activity timestamp is persisted separately, so deleting a message does not shorten the room lifetime. Messages still expire exactly at `createdAt + 30 minutes`. Replaying history or joining a room does not restart either timer. Concurrent room updates retain the greatest known activity timestamp and repair older storage values; failed renewal writes retry during cleanup. Already expired rooms cannot be renewed by messages. Device clocks determine visibility; clients reject creation times more than two minutes ahead and timestamps before 2025. Keep device clocks synchronized.

The UI filters expired records on every render and ticks once per second. Cleanup calls `db.remove(id)` in batches, retries failures, runs on startup, and resumes when the tab becomes visible. A storage query every 10 seconds also collects expired records outside the bounded UI cache. Messages in expired rooms are hidden even if their own TTL has not elapsed. Unknown-room messages remain hidden pending room discovery and are removed by their own TTL. Sleeping or closed browsers cannot run cleanup until they resume. Late stale replicas are filtered and queued for removal again. Cleanup rereads records before deletion to avoid removing a room renewed since the scan.

Update browsers and permanent peers together and use the same network name (default `ephemeral-pub-v3`). Earlier unsigned or centrally certified records and old tab identities are not migrated. Older peers reject the new records and can delete them as invalid. The permanent peer requires no separate identity service or signing authority. Room activity remains self-declared: a modified peer can forge an extension.

Removal deletes a node from the active local graph and replicates a deletion; it is **not secure erasure**. GenosDB can retain operation/deletion metadata (and removed values in its bounded sync operation log); browser storage and backups can also retain bytes. Another participant can save, screenshot, modify, replay, or record anything. The Hungarian UI explicitly says: “Az üzenetek a hivatalos alkalmazásban ideiglenesek, de más résztvevők elmenthetik vagy rögzíthetik őket.”

Incoming application records must have exact expected keys, valid UUIDs matching their node IDs, valid timestamps and TTL, and bounded strings: 2,000 characters / 8,000 UTF-8 bytes for messages, 100 for room titles, and 40 for names. All user text is rendered through React text children; no raw HTML interpolation is used. Message IDs are deduplicated and their contents are treated as immutable once observed in a session. Room titles, creators and creation times remain immutable; activity and expiry may advance. Messages, presence and receipts carry Ed25519 signatures and self-signed public profiles, checked before entering the application view. The profile binds the key-derived author ID, name and public key and must cover the record’s creation time. Clients also filter authors against known name claims. Room metadata and P2P graph deletion operations remain unauthenticated; a modified peer can still disrupt rooms or remove nodes.

Validation protects the application view **after GenosDB has decoded/stored incoming data**. It is not a transport firewall. UI caches are bounded (1,000 rooms, 5,000 messages for global activity, 500 messages for the open room, 2,000 presence records, 10,000 receipts, 10,000 profiles); a flood can still consume database/storage/network resources, and extra records may be omitted from the UI. This is a small public proof of concept, not an abuse-resistant service or moderation system.

Implementation references: [React external-store subscription](https://react.dev/reference/react/useSyncExternalStore), [BIP39 library](https://github.com/paulmillr/scure-bip39), [Ed25519 implementation](https://github.com/paulmillr/noble-curves).

## GenosDB API review and limitations

Reviewed the current official docs/examples and npm package on **2026-09-08**:

- [Factory and API reference](https://github.com/estebanrfp/gdb/blob/main/docs/genosdb-api-reference.md): async `gdb()`, `rtc` options, database-name network separation.
- [Cellular Mesh](https://github.com/estebanrfp/gdb/blob/main/docs/genosrtc-cells.md): `rtc: { cells: true }`; defaults rather than obsolete topology knobs from older articles.
- [PUT](https://github.com/estebanrfp/gdb/blob/main/docs/put-guide.md), [MAP](https://github.com/estebanrfp/gdb/blob/main/docs/map-guide.md), [REMOVE](https://github.com/estebanrfp/gdb/blob/main/docs/remove-guide.md): explicit IDs, `{ id, value, action }` callback and unsubscribe, replicated deletion. Older prose about automatic content-hash IDs differs from the current package; this app always supplies its own ID.
- [GenosRTC API](https://github.com/estebanrfp/gdb/blob/main/docs/genosrtc-api-reference.md) and [working chat example](https://github.com/estebanrfp/gdb/blob/main/examples/chat.html): reactive text rendering and room events.
- [Bundler configuration](https://github.com/estebanrfp/gdb/blob/main/docs/bundler-configuration.md): GenosDB resolves optional modules relative to `import.meta.url`.

The npm package is pinned and installed locally. Vite copies the unmodified core and GenosRTC files into `dist/vendor/genosdb/` with the vendor license. The app JavaScript and CSS are bundled normally. A single HTML file would require rewriting GenosDB's dynamic module loading; this small static folder preserves the documented module layout instead. No runtime CDN frontend libraries, fonts, images, stylesheets, widgets, analytics, or trackers are used. GenosDB's signaling/discovery and peer connections are the runtime network resources.

GenosDB is **proprietary freeware**, not an open-source dependency; its included license permits distributing the production builds in applications. See `node_modules/genosdb/LICENSE` and the copied build license.

Public signaling availability, restrictive NAT/firewalls, relay throttling, and browser background suspension can delay or prevent peer connections. The optional permanent peer in `peer/` can retain and forward unexpired history; it requires the same network and record format as the browser. Refresh preserves local data and GenosDB catches up with reachable peers; a new visitor cannot retrieve conversations when no peer holding them is reachable. A locally accepted message is not proof another browser received it. There is no guaranteed delivery or global participant count.

## Always-on Bun peer

The Git-tracked [`peer/`](peer/README.md) folder contains the standalone runtime and a systemd installer. The server needs Bun 1.4.2 and systemd; it does not need frontend dependencies or a frontend build. Clone/pull the repository, then run `sudo bash peer/setup-systemd.sh "$(command -v bun)"`. The installer copies the runtime to `/opt/csittchat-peer`, runs it as a dedicated service user, and keeps SQLite in `/var/lib/csittchat-peer`. Configuration is in `/etc/csittchat-peer.env` and survives upgrades. The health endpoint binds to localhost.

After changing the shared model/store/verifier, run `npm run peer:prepare` and commit the updated peer files and checksum manifest. `npm run peer:check` verifies these copies and runs in CI. The vendor runtime is the unmodified pinned production file with its license. Local configuration, databases, logs, test output and old local packaging are excluded from Git; the peer folder is also excluded from Vite HTTP serving and the static frontend build.

Run `TEST_BUN=/absolute/path/to/bun npm run test:peer` for the native Bun–Chromium persistence, mnemonic restoration and TTL test. It uses temporary state and a separate network, stops its processes and removes its database on completion. See the peer README before migrating an existing service or database.

## GitHub Pages

1. Push this repository to GitHub with a `main` branch.
2. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
3. Push to `main` or run **Deploy GitHub Pages** manually in the Actions tab.

The workflow installs the lockfile, runs unit tests, builds, uploads `dist/`, and deploys the Pages artifact. Change the workflow branch if your default branch is different. No secrets or backend configuration are required.

Vite uses `base: './'`, vendor URLs resolve relative to `index.html`, and room navigation uses URL fragments (`#room/<id>`). Both `https://owner.github.io/repository/` and a custom domain work without a routing fallback. To host manually, upload the entire `dist/` directory to any HTTPS static host, preserving its paths.

To verify deployment, open the same URL in two independent browsers/devices, choose different names, create a room in one, join it in the other, exchange messages both ways, and refresh. Same-origin tabs alone only demonstrate BroadcastChannel sync. Leave clients open to check the 30-minute message and 6-hour room TTLs, or use the accelerated browser tests locally. Actual Pages deployment requires a GitHub repository with Pages enabled.

The browser suite covers the required name modal, session persistence, room switching, safe text rendering, TTL cleanup, mobile layout, two-way WebRTC messaging, and a fresh browser retrieving existing `#main` history without another message being sent. It also checks that recovery does not duplicate messages or extend their expiry, and that another holder can forward history after the author leaves. Set `VITE_GDB_DEBUG=1` when running browser tests to include SDK diagnostics in the history test's local `sync.log` artifact; production diagnostics are off by default. GitHub Pages publishing and a test across physical devices on different networks have not been performed.
