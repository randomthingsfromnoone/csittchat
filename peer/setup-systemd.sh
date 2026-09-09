#!/usr/bin/env bash
set -euo pipefail

# --check validates the generated unit without installing or starting anything.
csittchat_check=false
csittchat_start=true
if [[ ${1:-} == --check ]]; then
  csittchat_check=true
  shift
elif [[ ${1:-} == --no-start ]]; then
  csittchat_start=false
  shift
fi
csittchat_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
csittchat_bun=${1:-$(command -v bun || true)}
if [[ $# -gt 1 || "$csittchat_bun" != /* || ! -x "$csittchat_bun" ]]; then
  echo 'Használat: sudo bash peer/setup-systemd.sh /teljes/útvonal/bun' >&2
  echo 'Ellenőrzés telepítés nélkül: bash peer/setup-systemd.sh --check /teljes/útvonal/bun' >&2
  exit 1
fi
csittchat_bun=$(readlink -f -- "$csittchat_bun")
if [[ $("$csittchat_bun" --version) != 1.4.2 ]]; then
  echo 'Ehhez a kiadáshoz Bun 1.4.2 szükséges.' >&2
  exit 1
fi
csittchat_files=(server.ts policy.ts shared/model.ts shared/store.ts shared/verify.mjs vendor/genossrv.min.js vendor/LICENSE manifest.json)
for csittchat_file in "${csittchat_files[@]}"; do
  test -f "$csittchat_source/$csittchat_file" || { echo "Hiányzó fájl: $csittchat_file" >&2; exit 1; }
done
# Check distributed runtime files before changing the installed service.
"$csittchat_bun" -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const root = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  for (const file of ["server.ts", "policy.ts", "shared/model.ts", "shared/store.ts", "shared/verify.mjs", "vendor/genossrv.min.js", "vendor/LICENSE"]) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex");
    if (actual !== manifest.sha256[file]) throw new Error(`Eltérő ellenőrzőösszeg: ${file}`);
  }
' "$csittchat_source"
csittchat_tmp=$(mktemp -d)
trap 'rm -rf -- "$csittchat_tmp"' EXIT
cat > "$csittchat_tmp/csittchat-peer.service" <<'UNIT'
# Managed by CsittChat peer/setup-systemd.sh
[Unit]
Description=CsittChat always-on P2P peer
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=csittchat-peer
Group=csittchat-peer
WorkingDirectory=/var/lib/csittchat-peer
ExecStart=/opt/csittchat-peer/bin/bun /opt/csittchat-peer/app/server.ts
EnvironmentFile=/etc/csittchat-peer.env
Environment=NODE_ENV=production
StateDirectory=csittchat-peer
StateDirectoryMode=0700
UMask=0077
Restart=always
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictSUIDSGID=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
if "$csittchat_check"; then
  # systemd-analyze requires an existing executable, even without starting it.
  # Substitute only that path when the production installation does not exist yet.
  csittchat_exec=${csittchat_bun//\\/\\\\}
  csittchat_exec=${csittchat_exec//\"/\\\"}
  csittchat_exec=${csittchat_exec//%/%%}
  CSITTCHAT_EXEC="$csittchat_exec" "$csittchat_bun" -e '
    const fs = require("node:fs"); const file = process.argv[1];
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("ExecStart=/opt/csittchat-peer/bin/bun", `ExecStart="${process.env.CSITTCHAT_EXEC}"`));
  ' "$csittchat_tmp/csittchat-peer.service"
  systemd-analyze verify "$csittchat_tmp/csittchat-peer.service"
  echo 'A fájlok és a systemd unit ellenőrzése sikeres. Telepítés nem történt.'
  exit 0
fi
if [[ $EUID -ne 0 ]]; then
  echo 'A telepítést sudo-val vagy rootként futtasd.' >&2
  exit 1
fi
csittchat_existing=$(systemctl cat csittchat-peer.service 2>/dev/null || true)
if [[ -n "$csittchat_existing" && "$csittchat_existing" != *'# Managed by CsittChat peer/setup-systemd.sh'* ]]; then
  echo 'Korábbi, más telepítésű csittchat-peer.service található. Előbb kövesd a README adatköltöztetési lépéseit.' >&2
  exit 1
fi
if ! getent passwd csittchat-peer >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/csittchat-peer --no-create-home --shell /usr/sbin/nologin csittchat-peer
fi
# Validate everything before stopping the running peer. Data/configuration stay in place.
install -d -m 0755 /opt/csittchat-peer/bin /opt/csittchat-peer/app
install -m 0755 "$csittchat_bun" /opt/csittchat-peer/bin/bun.next
mkdir "$csittchat_tmp/check"
sed 's|ExecStart=/opt/csittchat-peer/bin/bun |ExecStart=/opt/csittchat-peer/bin/bun.next |' \
  "$csittchat_tmp/csittchat-peer.service" > "$csittchat_tmp/check/csittchat-peer.service"
systemd-analyze verify "$csittchat_tmp/check/csittchat-peer.service"
systemctl stop csittchat-peer.service 2>/dev/null || {
  if [[ -n "$csittchat_existing" ]]; then
    echo 'A futó peer leállítása nem sikerült; a kódot nem cseréltük le.' >&2
    exit 1
  fi
}
if [[ -e /opt/csittchat-peer/bin/bun.next ]]; then
  mv /opt/csittchat-peer/bin/bun.next /opt/csittchat-peer/bin/bun
fi
for csittchat_file in "${csittchat_files[@]}"; do
  install -D -m 0644 "$csittchat_source/$csittchat_file" "/opt/csittchat-peer/app/$csittchat_file"
done
if [[ ! -e /etc/csittchat-peer.env ]]; then
  install -m 0600 /dev/null /etc/csittchat-peer.env
  cat > /etc/csittchat-peer.env <<'CONFIG'
GDB_ROOM=ephemeral-pub-v3
GDB_RELAY=0
GDB_RELAY_URLS=
GDB_DB_PATH=/var/lib/csittchat-peer/chat.sqlite
PORT=8080
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8081
CLEANUP_INTERVAL_MS=1000
CONFIG
fi
install -m 0644 "$csittchat_tmp/csittchat-peer.service" /etc/systemd/system/csittchat-peer.service
systemctl daemon-reload
systemctl enable csittchat-peer.service
if "$csittchat_start"; then
  systemctl restart csittchat-peer.service
  systemctl --no-pager --full status csittchat-peer.service
else
  echo 'Telepítve, de leállítva. Indítás: sudo systemctl start csittchat-peer'
fi
