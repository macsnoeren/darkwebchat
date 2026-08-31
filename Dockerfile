# DarkWebChat — productie-image.
#
# Twee stages, en dat is niet voor de netheid: better-sqlite3 is een native
# module. Bouwen vraagt python3, make en g++, en die horen niet thuis in een
# image die als onion service aan het Tor-netwerk hangt. De builder houdt de
# compiler, de runtime krijgt alleen het resultaat.

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
# node:22 is de LTS-lijn. Bewust niet node:25: better-sqlite3 levert prebuilds
# per Node ABI, en op een current release die nog geen prebuild heeft valt de
# installatie terug op compileren vanaf source — of hij faalt. Een oefening die
# moet draaien is de verkeerde plek om daar achter te komen.
FROM node:22-bookworm-slim AS deps

# node-gyp heeft deze nodig als er voor deze ABI geen prebuild blijkt te zijn.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Alleen de manifesten, zodat deze laag in de cache blijft zolang de
# dependencies niet wijzigen.
COPY package.json package-lock.json ./

# 'npm ci', niet 'npm install': ci installeert exact wat package-lock.json
# zegt en weigert als de lockfile niet klopt. 'npm install' zou de lockfile
# stilletjes bijwerken, en dan bouwt dezelfde commit vandaag iets anders dan
# morgen. Het vorige 'npm install && npm update' deed precies dat.
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/game.db

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json index.js ./
COPY --chown=node:node www ./www

# /data is het mountpoint van het volume met game.db. Aanmaken en toewijzen
# vóór de USER-switch, anders kan het proces er straks niet in schrijven.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Draaien als non-root. Het is de container die het publieke internet ziet;
# root erin is een cadeau aan wie een bug in de chat vindt.
USER node

EXPOSE 3000

# 'node index.js' in exec-vorm, niet 'npm start'. npm ertussen betekent een
# extra proces dat SIGTERM niet doorgeeft, waarna docker elke herstart tien
# seconden zit te wachten tot hij het opgeeft en SIGKILL stuurt.
CMD ["node", "index.js"]
