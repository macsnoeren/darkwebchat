"use strict";

const express      = require("express");
const { createServer } = require("node:http");
const { Server }   = require("socket.io");
const Database     = require("better-sqlite3");
const path         = require("node:path");

const app    = express();
const server = createServer(app);
const io     = new Server(server);

process.env.TZ = "UTC";
app.use(express.static("www"));

// ============================================================
// DATABASE SETUP
// ============================================================

const db = new Database(path.join(__dirname, "game.db"));

// Migration: als de tokens tabel nog een chatId kolom heeft (oud schema), migreren
const pragmaTokens = db.prepare("PRAGMA table_info(tokens)").all();
if (pragmaTokens.some(c => c.name === "chatId")) {
  console.log("Oud schema gedetecteerd – database migreren...");
  db.exec(`
    CREATE TABLE tokens_new (token TEXT PRIMARY KEY, company TEXT NOT NULL);
    INSERT INTO tokens_new SELECT token, company FROM tokens;
    DROP TABLE tokens;
    ALTER TABLE tokens_new RENAME TO tokens;
  `);
  // Voeg token-kolom toe aan sessions als die er nog niet is
  const pragmaSessions = db.prepare("PRAGMA table_info(sessions)").all();
  if (!pragmaSessions.some(c => c.name === "token")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN token TEXT NOT NULL DEFAULT ''`);
  }
  console.log("Migratie voltooid.");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    token    TEXT PRIMARY KEY,
    company  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    chatId    TEXT PRIMARY KEY,
    token     TEXT NOT NULL,
    company   TEXT NOT NULL,
    teamName  TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId    TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    who       TEXT NOT NULL,
    chat      TEXT NOT NULL,
    company   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL
  );
`);

// Seed default tokens als de tabel leeg is
const tokenCount = db.prepare("SELECT COUNT(*) AS n FROM tokens").get();
if (tokenCount.n === 0) {
  const ins  = db.prepare("INSERT OR IGNORE INTO tokens (token, company) VALUES (?, ?)");
  const seed = db.transaction((rows) => { rows.forEach((r) => ins.run(...r)); });
  seed([
    ["RABO-A7X2", "Rabo-Banko International"],
    ["ING0-B3K9", "INGA-Global Services"],
    ["ABNM-C5R1", "ABN-AMRE Finance"],
    ["PHLI-D8J4", "Philps Electro-Tech"],
    ["SHLL-E2M7", "Shill Petroleum"],
    ["ASML-F6N3", "AS-ML Litho Systems"],
    ["UNVR-G9P0", "Unilyver Consumer Goods"],
    ["HEIN-H1Q5", "Heyneken Breweries"],
    ["WKLU-I4S8", "Wolters-Kleuwer Ltd."],
    ["NNGI-J7T2", "N-N Insurances"],
    ["PTNL-K0V6", "P0st-NL Logistics"],
    ["NSNL-L3W9", "N-S Railways"],
    ["KPNL-M5X1", "K-P-N Telecom"],
    ["CLBL-N8Y4", "Cool-Blue Retail"],
    ["BOLC-O2Z7", "Bol-Webshop"],
  ]);
}

const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get();
if (userCount.n === 0) {
  console.log("Geen operators gevonden – setup vereist via /setup.html");
}

// ============================================================
// GAME CONFIGURATION
// ============================================================

const gameDeadline        = new Date(Date.now() + 4 * 60 * 60 * 1000);
const gameDurationSeconds = 4 * 60 * 60;

// ============================================================
// RUNTIME STATE  (rebuilt from DB on startup)
// ============================================================

let companieData   = {};  // { [chatId]: { company, token, teamName, chat: [] } }
let hackerSockets  = [];
let hackerSessions = {};  // { sessionToken: username }

(function loadFromDB() {
  const sessions = db.prepare("SELECT * FROM sessions").all();
  sessions.forEach((s) => {
    const msgs = db.prepare(
      "SELECT * FROM messages WHERE chatId = ? ORDER BY id"
    ).all(s.chatId);
    companieData[s.chatId] = {
      company:  s.company,
      token:    s.token,
      teamName: s.teamName,
      chat:     msgs.map((m) => ({
        timestamp: m.timestamp,
        who:       m.who,
        chat:      m.chat,
        company:   m.company,
      })),
    };
  });
  console.log(`${sessions.length} sessie(s) hersteld vanuit de database`);
})();

// ============================================================
// UTILITIES
// ============================================================

function getTimeStamp() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function escape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isHacker(socket)                { return hackerSockets.some((s) => s.id === socket.id); }
function broadcastToHackers(topic, data) { hackerSockets.forEach((s) => s.emit(topic, data)); }
function getTimerData()                  { return { deadline: gameDeadline.getTime() / 1000, total: gameDurationSeconds }; }

function generateChatId() {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 25 }, () => c[Math.floor(Math.random() * c.length)]).join("");
}

function saveMessage(chatId, msg) {
  db.prepare(
    "INSERT INTO messages (chatId, timestamp, who, chat, company) VALUES (?, ?, ?, ?, ?)"
  ).run(chatId, msg.timestamp, msg.who, msg.chat, msg.company);
}

// ============================================================
// SOCKET HANDLERS
// ============================================================

io.on("connection", (socket) => {
  socket._data = { valid: false, company: "", chatId: "", teamName: "", token: "" };

  // ── COMPANY: validate token ──────────────────────────────
  //
  // Drie gevallen:
  //   1. { token }               → vraag teamnaam (eerste keer op landing page)
  //   2. { token, teamName }     → maak nieuwe sessie of reconnect op bestaande (zelfde team)
  //   3. { token, chatId }       → herverbind chat-pagina met bestaande sessie
  //
  socket.on("token-login", (data) => {
    const token    = String(data.token    || "").trim().toUpperCase();
    const teamName = String(data.teamName || "").trim();
    const chatId   = String(data.chatId   || "").trim();

    const entry = db.prepare("SELECT * FROM tokens WHERE token = ?").get(token);
    if (!entry) {
      socket.emit("token-invalid");
      return;
    }

    const { company } = entry;

    // ── Geval 3: herverbinding vanuit chat-pagina via chatId ──
    if (chatId) {
      const session = db.prepare(
        "SELECT * FROM sessions WHERE chatId = ? AND token = ?"
      ).get(chatId, token);

      if (!session) {
        socket.emit("token-invalid");
        return;
      }

      if (!companieData[chatId]) {
        const msgs = db.prepare("SELECT * FROM messages WHERE chatId = ? ORDER BY id").all(chatId);
        companieData[chatId] = {
          company,
          token,
          teamName: session.teamName,
          chat: msgs.map((m) => ({ timestamp: m.timestamp, who: m.who, chat: m.chat, company: m.company })),
        };
      }

      socket._data = { valid: true, company, chatId, teamName: session.teamName, token };
      socket.join(chatId);

      socket.emit("token-valid", { company, chatId, teamName: session.teamName });
      socket.emit("timeleft", getTimerData());
      companieData[chatId].chat.forEach((msg) => {
        socket.emit(msg.who === "darknet" ? "chat-message-darknet" : "chat-message-company", msg);
      });
      console.log(`[~] Herverbonden: ${company} / Team: ${session.teamName}`);
      return;
    }

    // ── Geval 1: geen teamnaam → vraag het op ────────────────
    if (!teamName) {
      socket.emit("token-needs-team", { company });
      return;
    }

    // ── Geval 2: token + teamnaam → nieuwe of bestaande sessie
    const existingSession = db.prepare(
      "SELECT * FROM sessions WHERE token = ? AND teamName = ?"
    ).get(token, teamName);

    if (existingSession) {
      // Zelfde team herverbindt (bijv. pagina herladen vóór chat-pagina geladen is)
      const eid = existingSession.chatId;
      if (!companieData[eid]) {
        const msgs = db.prepare("SELECT * FROM messages WHERE chatId = ? ORDER BY id").all(eid);
        companieData[eid] = {
          company, token, teamName,
          chat: msgs.map((m) => ({ timestamp: m.timestamp, who: m.who, chat: m.chat, company: m.company })),
        };
      }
      socket._data = { valid: true, company, chatId: eid, teamName, token };
      socket.join(eid);

      socket.emit("token-valid", { company, chatId: eid, teamName });
      socket.emit("timeleft", getTimerData());
      companieData[eid].chat.forEach((msg) => {
        socket.emit(msg.who === "darknet" ? "chat-message-darknet" : "chat-message-company", msg);
      });
      console.log(`[~] Herverbonden (landing): ${company} / Team: ${teamName}`);
      return;
    }

    // Nieuw team met deze code
    const newChatId = generateChatId();
    db.prepare(
      "INSERT INTO sessions (chatId, token, company, teamName, createdAt) VALUES (?, ?, ?, ?, ?)"
    ).run(newChatId, token, company, teamName, getTimeStamp());

    companieData[newChatId] = { company, token, teamName, chat: [] };

    const welcome = {
      timestamp: getTimeStamp(),
      who:       "darknet",
      chat:      "[ SYSTEEM MELDING ] Uw netwerk is gecompromitteerd door DarkNet Operators. Alle bestanden zijn versleuteld met AES-256 militaire encryptie. Om de decryptiesleutel te ontvangen dient u onze instructies op te volgen. Deel GEEN informatie met derden. Uw tijd is beperkt. Een negotiator neemt spoedig contact met u op.",
      company,
    };
    saveMessage(newChatId, welcome);
    companieData[newChatId].chat.push(welcome);

    socket._data = { valid: true, company, chatId: newChatId, teamName, token };
    socket.join(newChatId);

    socket.emit("token-valid", { company, chatId: newChatId, teamName });
    socket.emit("timeleft", getTimerData());
    socket.emit("chat-message-darknet", welcome);
    broadcastToHackers("new-company", {
      chatId: newChatId, company, token, teamName, chat: companieData[newChatId].chat,
    });

    console.log(`[+] Nieuwe sessie: ${company} / Team: ${teamName} (token: ${token})`);
  });

  // ── COMPANY: send message ────────────────────────────────
  socket.on("chat-message-company", (data) => {
    if (!socket._data.valid) return;
    const { chatId, company, teamName } = socket._data;
    if (!companieData[chatId]) return;

    const text = escape(String(data.msg || "").trim());
    if (!text) return;

    const msg = { timestamp: getTimeStamp(), who: "company", chat: text, company, teamName };
    saveMessage(chatId, msg);
    companieData[chatId].chat.push(msg);
    io.to(chatId).emit("chat-message-company", msg);
    broadcastToHackers("update-chat", { chatId, msg });
  });

  // ── HACKER: login ────────────────────────────────────────
  socket.on("hacker-login", (data) => {
    const username = String(data.username || "").trim();
    const password = String(data.password || "").trim();

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user || user.password !== password) {
      socket.emit("hacker-login-failed", { message: "Ongeldige inloggegevens." });
      return;
    }

    const sessionToken = generateChatId();
    hackerSessions[sessionToken] = username;

    socket.emit("hacker-login-success", { sessionToken });
    console.log(`[+] Operator ingelogd: ${username}`);
  });

  // ── HACKER: session auth (dashboard reconnect) ───────────
  socket.on("hacker-session-auth", (data) => {
    const sessionToken = String(data.sessionToken || "");
    const username     = hackerSessions[sessionToken];

    if (!username) {
      socket.emit("hacker-login-failed", { message: "Sessie ongeldig of verlopen." });
      return;
    }

    if (!isHacker(socket)) hackerSockets.push(socket);
    socket._data.isHacker = true;
    socket._data.username = username;

    socket.emit("hacker-login-success", {
      username,
      companyData: companieData,
      timeleft:    getTimerData(),
    });

    console.log(`[~] Operator sessie hersteld: ${username}`);
  });

  // ── HACKER: send message ─────────────────────────────────
  socket.on("chat-message-darknet", (data) => {
    if (!isHacker(socket)) return;
    const chatId = String(data.chatId || "");
    if (!companieData[chatId]) return;

    const text = escape(String(data.msg || "").trim());
    if (!text) return;

    const msg = {
      timestamp: getTimeStamp(),
      who:       "darknet",
      chat:      text,
      company:   companieData[chatId].company,
    };
    saveMessage(chatId, msg);
    companieData[chatId].chat.push(msg);
    io.to(chatId).emit("chat-message-darknet", msg);
    broadcastToHackers("update-chat", { chatId, msg });
  });

  // ── HACKER: delete chat ──────────────────────────────────
  socket.on("delete-chat", (data) => {
    if (!isHacker(socket)) return;
    const chatId = String(data.chatId || "");
    if (!companieData[chatId]) return;

    console.log(`[-] Chat verwijderd: ${companieData[chatId].company} / ${companieData[chatId].teamName}`);
    delete companieData[chatId];
    broadcastToHackers("chat-deleted", { chatId });
  });

  // ── ADMIN: get token list ────────────────────────────────
  socket.on("admin-get-tokens", () => {
    if (!isHacker(socket)) return;

    const tokens = db.prepare("SELECT * FROM tokens ORDER BY token").all();
    const enriched = tokens.map((t) => {
      const sessions = db.prepare(
        "SELECT chatId, teamName FROM sessions WHERE token = ? ORDER BY createdAt"
      ).all(t.token);

      const teams = sessions.map((s) => ({
        chatId:       s.chatId,
        teamName:     s.teamName,
        active:       !!companieData[s.chatId],
        messageCount: companieData[s.chatId] ? companieData[s.chatId].chat.length : 0,
      }));

      return {
        token:       t.token,
        company:     t.company,
        teams,
        activeCount: teams.filter((t) => t.active).length,
      };
    });

    socket.emit("admin-tokens-data", enriched);
  });

  // ── ADMIN: create token ──────────────────────────────────
  socket.on("admin-create-token", (data) => {
    if (!isHacker(socket)) return;
    const token   = String(data.token   || "").trim().toUpperCase();
    const company = String(data.company || "").trim();

    if (!token || !company) return;
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(token)) {
      socket.emit("admin-error", { message: "Token formaat ongeldig. Gebruik bijv. XXXX-XXXX." });
      return;
    }
    if (db.prepare("SELECT token FROM tokens WHERE token = ?").get(token)) {
      socket.emit("admin-error", { message: "Token bestaat al." });
      return;
    }

    db.prepare("INSERT INTO tokens (token, company) VALUES (?, ?)").run(token, company);
    console.log(`[+] Token aangemaakt: ${token} → ${company}`);
    broadcastToHackers("admin-token-created", { token, company });
  });

  // ── ADMIN: delete token ──────────────────────────────────
  socket.on("admin-delete-token", (data) => {
    if (!isHacker(socket)) return;
    const token = String(data.token || "").trim().toUpperCase();
    const entry = db.prepare("SELECT * FROM tokens WHERE token = ?").get(token);
    if (!entry) return;

    // Verwijder alle gekoppelde sessies en berichten
    const sessions = db.prepare("SELECT chatId FROM sessions WHERE token = ?").all(token);
    sessions.forEach((s) => {
      delete companieData[s.chatId];
      db.prepare("DELETE FROM messages WHERE chatId = ?").run(s.chatId);
    });
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    db.prepare("DELETE FROM tokens WHERE token = ?").run(token);

    console.log(`[-] Token verwijderd: ${token} (${sessions.length} sessie(s) gewist)`);
    broadcastToHackers("admin-token-deleted", { token });
  });

  // ── ADMIN: get users ─────────────────────────────────────
  socket.on("admin-get-users", () => {
    if (!isHacker(socket)) return;
    const users = db.prepare("SELECT username FROM users ORDER BY username").all();
    socket.emit("admin-users-data", users);
  });

  // ── ADMIN: create user ───────────────────────────────────
  socket.on("admin-create-user", (data) => {
    if (!isHacker(socket)) return;
    const username = String(data.username || "").trim();
    const password = String(data.password || "").trim();

    if (!username || !password) return;
    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
      socket.emit("admin-error", { message: "Gebruikersnaam ongeldig (2-20 tekens, a-z 0-9 _ -)." });
      return;
    }
    if (db.prepare("SELECT username FROM users WHERE username = ?").get(username)) {
      socket.emit("admin-error", { message: "Gebruikersnaam bestaat al." });
      return;
    }

    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, password);
    console.log(`[+] Gebruiker aangemaakt: ${username}`);
    broadcastToHackers("admin-user-created", { username });
  });

  // ── ADMIN: reset user password ───────────────────────────
  socket.on("admin-create-user-reset", (data) => {
    if (!isHacker(socket)) return;
    const username = String(data.username || "").trim();
    const password = String(data.password || "").trim();

    if (!username || !password) return;
    if (!db.prepare("SELECT username FROM users WHERE username = ?").get(username)) {
      socket.emit("admin-error", { message: "Gebruiker niet gevonden." });
      return;
    }

    db.prepare("UPDATE users SET password = ? WHERE username = ?").run(password, username);
    console.log(`[~] Wachtwoord gereset: ${username}`);
    socket.emit("admin-user-created", { username });
  });

  // ── ADMIN: delete user ───────────────────────────────────
  socket.on("admin-delete-user", (data) => {
    if (!isHacker(socket)) return;
    const username = String(data.username || "").trim();

    const count = db.prepare("SELECT COUNT(*) AS n FROM users").get();
    if (count.n <= 1) {
      socket.emit("admin-error", { message: "Kan de laatste gebruiker niet verwijderen." });
      return;
    }

    db.prepare("DELETE FROM users WHERE username = ?").run(username);
    console.log(`[-] Gebruiker verwijderd: ${username}`);
    broadcastToHackers("admin-user-deleted", { username });
  });

  // ── SETUP: check first-run ───────────────────────────────
  socket.on("check-setup", () => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    socket.emit("setup-status", { needsSetup: n === 0 });
  });

  // ── SETUP: create first operator ─────────────────────────
  socket.on("operator-setup", (data) => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    if (n > 0) {
      socket.emit("setup-error", { message: "Setup is al voltooid." });
      return;
    }
    const username = String(data.username || "").trim();
    const password = String(data.password || "").trim();

    if (!username || !password) {
      socket.emit("setup-error", { message: "Vul beide velden in." });
      return;
    }
    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
      socket.emit("setup-error", { message: "Gebruikersnaam ongeldig (2-20 tekens, a-z 0-9 _ -)." });
      return;
    }
    if (password.length < 6) {
      socket.emit("setup-error", { message: "Wachtwoord moet minimaal 6 tekens zijn." });
      return;
    }

    db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(username, password);
    console.log(`[+] Eerste operator aangemaakt: ${username}`);
    socket.emit("setup-done", { username });
  });

  // ── DISCONNECT ───────────────────────────────────────────
  socket.on("disconnect", () => {
    hackerSockets = hackerSockets.filter((s) => s.id !== socket.id);
  });
});

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nDarkWebChat draait op poort ${PORT}`);
  console.log(`Game deadline: ${gameDeadline.toUTCString()}\n`);
});
