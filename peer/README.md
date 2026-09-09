# CsittChat – állandó Bun peer

Ez a mappa önállóan futtatható. A futtatáshoz Bun **1.4.2** és Linux/systemd
kell; Node.js, npm és a React-felület buildje nem szükséges a szerveren.
A GenosDB 0.34.0 változatlan szerverfájlja és licence a `vendor/` mappában van.

## Telepítés

Telepítsd a Bun 1.4.2-t a célgépre, majd a repó gyökeréből:

```sh
bun --version
bash peer/setup-systemd.sh --check "$(command -v bun)"
sudo bash peer/setup-systemd.sh "$(command -v bun)"
curl --fail http://127.0.0.1:8081/healthz
sudo journalctl -u csittchat-peer -n 50 --no-pager
```

A `--check` csak a fájlok ellenőrzőösszegét és a generált systemd unitot
ellenőrzi, nem telepít és nem indít szolgáltatást. A normál telepítés elindítja
a peert, és beállítja a gépindításkori automatikus indulást. A telepítő a megadott
Bun binárist is átmásolja, így a szolgáltatásnak nem kell hozzáférnie a belépett
felhasználó saját könyvtárához. Külön, belépésre nem használható
`csittchat-peer` felhasználóval fut.

| Hely | Tartalom |
| --- | --- |
| `/opt/csittchat-peer/app` | Futó szerverkód és mellékelt függőség |
| `/opt/csittchat-peer/bin/bun` | Bun futtatókörnyezet |
| `/var/lib/csittchat-peer` | SQLite-adatbázis és kapcsolódó állományok |
| systemd journal | Működési napló |

## Beállítások a kódban

A beállítások nyilvánosak, nincs köztük jelszó vagy API-kulcs. Nem kell `.env`
fájl vagy GitHub Actions változó. A közös hálózati értékek a projekt
`src/config.ts` fájljában vannak; a peer ezek ellenőrzött másolatát kapja a
`shared/config.ts` fájlban:

```ts
export const chatConfig = {
  network: 'ephemeral-pub-v3',
  relayUrls: [] as string[],
  debug: false,
};
```

A `peer/config.ts` a szerver további beállításait tartalmazza:

```ts
export const peerConfig = {
  ...chatConfig,
  dbPath: '/var/lib/csittchat-peer/chat.sqlite',
  relay: false,
  port: 8080,
  healthHost: '127.0.0.1',
  healthPort: 8081,
  cleanupIntervalMs: 1000,
};
```

Az üres relaylista a közös nyilvános relayeken keresztül keres peereket. Saját
relayekhez a `chatConfig.relayUrls` listát módosítsd, majd frissítsd a klienst és
a peert együtt. A folyamatosan futó peer nem indít saját relayt, az állapotvégpont
csak localhoston figyel. A WebRTC elérhetősége a hálózattól is függ.

A konfigurációt fejlesztői gépen módosítsd, utána futtasd az `npm run peer:prepare`
parancsot, és commitold a frissített fájlokat. Új frontend build és a peer
újratelepítése szükséges az érvényesítéshez. Az adatbázis maradjon
`/var/lib/csittchat-peer` alatt: a systemd más rendszerkönyvtárak írását tiltja.
A `--no-start` kapcsoló telepít és engedélyezi a gépindításkori indulást, de
leállítva hagyja a szolgáltatást az adatköltöztetéshez.

A korábbi `/etc/csittchat-peer.env` fájlt az új unit már nem tölti be; a telepítő
nem törli. Ha abban egyedi beállításaid voltak, előbb vezesd át azokat a kódbeli
konfigurációba. A mellékelt értékek az előző systemd-telepítő alapértékeivel
megegyeznek. Az SDK a relaybeállításokat belül környezeti változókon keresztül
fogadja; ezeket a program tölti ki a kódból, nem külső konfigurációból.

## Frissítés Gitből

A klónozott repóban:

```sh
git pull --ff-only
sudo bash peer/setup-systemd.sh /opt/csittchat-peer/bin/bun
curl --fail http://127.0.0.1:8081/healthz
```

A telepítő ellenőrzi, majd leállítja és lecseréli a futó kódot, végül újraindítja
a szolgáltatást. Az adatbázist megtartja; a konfiguráció a frissített kódból érkezik. A puszta `git pull`
a futó példányt még nem frissíti. Protokollváltáskor a klienst és a peert együtt
kell frissíteni; a jelenlegi formátum v3.

## Korábbi systemd-telepítés átköltöztetése

Ha már létezik más telepítővel létrehozott `csittchat-peer.service`, az új
telepítő megáll. A régi adatbázist nem keresi meg és nem helyezi át automatikusan.

1. Nézd meg a régi beállításokat: `sudo systemctl cat csittchat-peer`.
   Jegyezd fel a hálózat nevét és a `GDB_DB_PATH` helyét. A korábbi telepítőben
   ez `/root/csittchat-peer/data-bun/chat.sqlite` volt.
2. Állítsd le: `sudo systemctl stop csittchat-peer`. Készíts mentést a teljes
   régi adatkönyvtárról, a SQLite `-wal` és `-shm` állományaival együtt, ha vannak.
3. Mentsd el a régi unitot, majd vedd ki az aktív helyéről:
   `sudo mv /etc/systemd/system/csittchat-peer.service /etc/systemd/system/csittchat-peer.service.before-bun`.
   Ha vannak régi drop-in beállítások, azokat is helyezd biztonságos mentésbe.
   Ezután `sudo systemctl daemon-reload`.
4. Futtasd az új telepítőt `--no-start` kapcsolóval és a Bun teljes útvonalával.
5. Hozd létre a célkönyvtárat:
   `sudo install -d -m 0700 -o csittchat-peer -g csittchat-peer /var/lib/csittchat-peer`.
   Másold ide a leállított régi adatkönyvtár tartalmát, és állítsd a tulajdonost:
   `sudo chown -R csittchat-peer:csittchat-peer /var/lib/csittchat-peer`.
6. Ellenőrizd a kódbeli konfiguráció hálózatnevét és adatbázisútvonalát,
   majd `sudo systemctl start csittchat-peer`.

Régi, v3 előtti rekordokhoz ez nem ad formátumkonverziót. Az eredeti mentést
őrizd meg; a jelenlegi ellenőrző az eltérő formátumú rekordokat törölheti.

## Megőrzés és ellenőrzés

Az üzenetek 30 percig, a szobák az utolsó üzenet után 6 óráig élnek. A tartós
profilok nem járnak le. A 12 helyreállító szó a kulcsot állítja vissza; a névhez
az aláírt profil egy példánya is kell. Az adatkönyvtárat ezért mentsd rendszeresen,
a legegyszerűbb konzisztens másolathoz a peert előbb állítsd le.

A `healthz` számlálói mutatják az ismert profilokat és üzeneteket, de nem jelentenek
külön kézbesítési visszaigazolást. Próbáld ki: üzenetküldés, átvétel ellenőrzése,
minden böngésző bezárása, peer újraindítása, majd visszaállítás friss böngészőben.
A peer nem küld emberi jelenlétjelzést.

A névfoglalás P2P: kapcsolatkimaradás alatt átmeneti névütközés lehet. Az aláírás
a kulcs birtoklását igazolja, nem globálisan kizárólagos becenevet. Módosított
peer visszadátumozhat foglalást; a szobametaadatok és gráftörlések sem hitelesítettek.

## A mappa karbantartása fejlesztői gépen

A `shared/` másolatai és a változatlan vendor fájl az alábbi parancsokkal
frissíthetők, telepített npm-függőségekkel:

```sh
npm run peer:prepare
npm run peer:check
```

Commitold a frissített fájlokat és a `manifest.json` fájlt együtt. A CI ellenőrzi
az egyezést. A manifest eltérést észlel, nem helyettesíti a Git-forrás hitelességének
ellenőrzését. Helyi konfiguráció, adatbázis, kulcs, napló és tesztkimenet nem kerül
a publikus csomagba. A frontend buildje nem tartalmazza ezt a mappát.
