# CsittChat

A small experiment in temporary public conversation, with a compact Hungarian black-and-white interface. Desktop keeps rooms beside the conversation; mobile switches between the room list and chat. The message list scrolls independently so the composer stays on screen. One public square, a permanent `#main` room, and public rooms anyone can create. No accounts, application server, or central message database. Built with TypeScript, vanilla DOM APIs, Vite, and GenosDB **0.34.0**.

## Run

Use Node.js 24 (22.12+ also supported by the build tools).

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

After a display name is chosen, every client opens `gdb('ephemeral-pub-v1', { rtc: { cells: true } })`. `db.put(value, id)` stores records locally; `db.map({ realtime: true }, callback)` receives the initial graph and later additions, updates, and removals. Entering a room also reads its newest 500 message records directly from the graph and maintains a separate realtime room subscription, independent of the global activity cache. Switching rooms cancels the old subscription and ignores late results; reconnect/focus and the reload button reread the available history. The UI distinguishes reading local history from waiting for remote history: a participant count does not prove that messages have synchronized. GenosDB persists through its browser storage worker (OPFS, with fallbacks including IndexedDB), synchronizes same-origin tabs through BroadcastChannel, and replicates between browsers over GenosRTC/WebRTC. Cellular Mesh is enabled consistently for every peer.

In testing with 0.34.0, the initial history handshake sometimes failed to complete even though later presence updates arrived. To recover, peers repeat ordinary `db.put(value, id)` writes 5 and 20 seconds after application-peer joins or resuming the page. Join bursts are debounced. Each pass reads up to 1,000 live rooms and the newest 500 live messages across the database, checks they still exist and have not expired, and preserves their IDs, content, authors, and original TTLs. Any holder can forward history after the author leaves. This adds bounded traffic and does not guarantee recovery beyond those limits. The vendor code and wire protocol are unchanged. The reload button only rereads the local graph; it cannot request missing data from other browsers. Existing open clients should refresh after deploying this update so they can also perform recovery.

GenosRTC uses external discovery/signaling infrastructure, including Nostr relays, to arrange peer connections. **Those relays are not the message database.** The dependency may fetch its relay directory and contact STUN services; these are discovery/connectivity resources. There is no application REST API, WebSocket chat server, or hosted database. WebRTC transport encryption does not make these public conversations private.

GenosDB stores three kinds of node, with explicit IDs `kind:uuid`:

| Kind | Stored value | Lifetime |
| --- | --- | --- |
| Room | ID, title, creator ID, creation, expiry, initial activity time | 6 hours |
| Message | ID, room ID, author ID/name, text, creation, expiry | 30 minutes |
| Presence | Per-tab session ID, local author ID, selected room, heartbeat time, expiry | 90 seconds, renewed every 25 seconds |

`#main` is a built-in room and needs no persistent room node. On first entry, a modal asks for a display name. The name and a random identity are saved in `sessionStorage` for that browser tab, survive refresh, and cannot be edited through the UI. A fresh tab/session asks again; browser session restoration or tab duplication can restore the existing session. The old `localStorage` identity is retired. Each page load has a fresh presence session ID. Participants are estimated from unexpired presence records, deduplicated by local author ID. Counts include this browser and can lag or be spoofed. The header reports direct GenosRTC application-channel connections, which are not a global census or a message-delivery acknowledgement.

All public rooms share one database/network. Room IDs select a view; **all peers can receive all public messages**, whether or not they joined a room. GenosDB supports separation through different database names, but separate per-room networks would add discovery and lifecycle complexity to this MVP. To intentionally isolate another deployment, set `VITE_CHAT_NETWORK` at build time; peers must use the same name to meet. The default makes deployments of this experiment share a square.

## Expiration and trust

Room expiry is exactly `createdAt + 6 hours`; messages are exactly `createdAt + 30 minutes`. Activity does not extend either TTL. `lastActivityAt` starts at creation; the displayed recent activity is derived from known unexpired messages to avoid concurrent metadata writes. Device clocks determine visibility; clients reject creation times more than two minutes ahead and timestamps before 2025. Keep device clocks synchronized.

The UI filters expired records on every render and ticks once per second. Cleanup calls `db.remove(id)` in batches, retries failures, runs on startup, and resumes when the tab becomes visible. A storage query every 10 seconds also collects expired records outside the bounded UI cache. Messages in expired rooms are hidden even if their own TTL has not elapsed. Unknown-room messages remain hidden pending room discovery and are removed by their own TTL. Sleeping or closed browsers cannot run cleanup until they resume. Late stale replicas are filtered and queued for removal again.

Removal deletes a node from the active local graph and replicates a deletion; it is **not secure erasure**. GenosDB can retain operation/deletion metadata (and removed values in its bounded sync operation log); browser storage and backups can also retain bytes. Another participant can save, screenshot, modify, replay, or record anything. The Hungarian UI explicitly says: “Az üzenetek a hivatalos alkalmazásban ideiglenesek, de más résztvevők elmenthetik vagy rögzíthetik őket.”

Incoming application records must have exact expected keys, valid UUIDs matching their node IDs, valid timestamps and TTL, and bounded strings: 2,000 characters / 8,000 UTF-8 bytes for messages, 100 for room titles, and 40 for names. All text uses DOM text nodes/textContent, never HTML interpolation. Message and room IDs are deduplicated and treated as immutable once observed in a session. This is practical replay resistance, not authenticated authorship: names and IDs are self-declared, and a modified peer can overwrite or remove graph nodes. Changed IDs after refresh are not cryptographically authenticated.

Validation protects the application view **after GenosDB has decoded/stored incoming data**. It is not a transport firewall. UI caches are bounded (1,000 rooms, 5,000 messages for global activity, 500 messages for the open room, 2,000 presence records); a flood can still consume database/storage/network resources, and extra records may be omitted from the UI. This is a small public proof of concept, not an abuse-resistant service or moderation system.

## GenosDB API review and limitations

Reviewed the current official docs/examples and npm package on **2026-09-08**:

- [Factory and API reference](https://github.com/estebanrfp/gdb/blob/main/docs/genosdb-api-reference.md): async `gdb()`, `rtc` options, database-name network separation.
- [Cellular Mesh](https://github.com/estebanrfp/gdb/blob/main/docs/genosrtc-cells.md): `rtc: { cells: true }`; defaults rather than obsolete topology knobs from older articles.
- [PUT](https://github.com/estebanrfp/gdb/blob/main/docs/put-guide.md), [MAP](https://github.com/estebanrfp/gdb/blob/main/docs/map-guide.md), [REMOVE](https://github.com/estebanrfp/gdb/blob/main/docs/remove-guide.md): explicit IDs, `{ id, value, action }` callback and unsubscribe, replicated deletion. Older prose about automatic content-hash IDs differs from the current package; this app always supplies its own ID.
- [GenosRTC API](https://github.com/estebanrfp/gdb/blob/main/docs/genosrtc-api-reference.md) and [working chat example](https://github.com/estebanrfp/gdb/blob/main/examples/chat.html): reactive text rendering and room events.
- [Bundler configuration](https://github.com/estebanrfp/gdb/blob/main/docs/bundler-configuration.md): GenosDB resolves optional modules relative to `import.meta.url`.

The npm package is pinned and installed locally. Vite copies the unmodified core and GenosRTC files into `dist/vendor/genosdb/` with the vendor license. The app JavaScript and CSS are bundled normally. A single HTML file would require rewriting GenosDB's dynamic module loading; this small static folder preserves the documented module layout instead. No runtime CDN frontend libraries, fonts, images, stylesheets, widgets, analytics, or trackers are used. GenosDB's signaling/discovery connections are the only intended third-party runtime resources.

GenosDB is **proprietary freeware**, not an open-source dependency; its included license permits distributing the production builds in applications. See `node_modules/genosdb/LICENSE` and the copied build license.

Public signaling availability, restrictive NAT/firewalls, relay throttling, and browser background suspension can delay or prevent peer connections. No custom NAT traversal or fallback server is included. Refresh preserves local data and GenosDB catches up with reachable peers; a new visitor cannot retrieve conversations when no peer holding them is reachable. A locally accepted message is not proof another browser received it. There is no guaranteed delivery or global participant count.

## GitHub Pages

1. Push this repository to GitHub with a `main` branch.
2. In **Settings → Pages → Build and deployment**, choose **GitHub Actions**.
3. Push to `main` or run **Deploy GitHub Pages** manually in the Actions tab.

The workflow installs the lockfile, runs unit tests, builds, uploads `dist/`, and deploys the Pages artifact. Change the workflow branch if your default branch is different. No secrets or backend configuration are required.

Vite uses `base: './'`, vendor URLs resolve relative to `index.html`, and room navigation uses URL fragments (`#room/<id>`). Both `https://owner.github.io/repository/` and a custom domain work without a routing fallback. To host manually, upload the entire `dist/` directory to any HTTPS static host, preserving its paths.

To verify deployment, open the same URL in two independent browsers/devices, choose different names, create a room in one, join it in the other, exchange messages both ways, and refresh. Same-origin tabs alone only demonstrate BroadcastChannel sync. Leave clients open to check the 30-minute message and 6-hour room TTLs, or use the accelerated browser tests locally. Actual Pages deployment requires a GitHub repository with Pages enabled.

The browser suite covers the required name modal, session persistence, room switching, safe text rendering, TTL cleanup, mobile layout, two-way WebRTC messaging, and a fresh browser retrieving existing `#main` history without another message being sent. It also checks that recovery does not duplicate messages or extend their expiry, and that another holder can forward history after the author leaves. Set `VITE_GDB_DEBUG=1` when running browser tests to include SDK diagnostics in the history test's local `sync.log` artifact; production diagnostics are off by default. GitHub Pages publishing and a test across physical devices on different networks have not been performed.
