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

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    token    TEXT PRIMARY KEY,
    company  TEXT NOT NULL,
    chatId   TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    chatId    TEXT PRIMARY KEY,
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
`);

// Seed default tokens if the table is empty
const tokenCount = db.prepare("SELECT COUNT(*) AS n FROM tokens").get();
if (tokenCount.n === 0) {
  const ins = db.prepare("INSERT OR IGNORE INTO tokens (token, company, chatId) VALUES (?, ?, ?)");
  const seed = db.transaction((rows) => { rows.forEach((r) => ins.run(...r)); });
  seed([
    ["RABO-A7X2", "Rabobank N.V.",       "dS5kiwjV2VMSi2jJlxPewYC4U"],
    ["ING0-B3K9", "ING Groep N.V.",      "qXDY7Sz1d1XGc4BRpGeymuGWZ"],
    ["ABNM-C5R1", "ABN AMRO Bank N.V.",  "dOsW8EPTqpcsmmq4KBcqeE3cS"],
    ["PHLI-D8J4", "Philips N.V.",         "P048tdEMCBuwb17KBY66UxmV2"],
    ["SHLL-E2M7", "Shell plc",            "JB0okKxSoifhL16hr0XW6wBfE"],
    ["ASML-F6N3", "ASML Holding N.V.",   "QxBqArvo2BF5zFo5Gd2RwIL5I"],
    ["UNVR-G9P0", "Unilever N.V.",        "PkMPKEbYzM0F6kFAIImVfXLgB"],
    ["HEIN-H1Q5", "Heineken N.V.",        "LrvF8yLqqWhPShi0ap8dKgRsc"],
    ["WKLU-I4S8", "Wolters Kluwer N.V.", "puIjJM5XkZrRk9J28x5U60xq0"],
    ["NNGI-J7T2", "NN Group N.V.",        "vJBTtf6HlHh36GsWRSy1RMjEA"],
    ["PTNL-K0V6", "PostNL N.V.",          "a6edzXzjsUfwM3mMbIFHKH7Af"],
    ["NSNL-L3W9", "NS Groep N.V.",        "jjCC6XbfY7ylgWVmfIUHuVoxj"],
    ["KPNL-M5X1", "KPN N.V.",             "kjsdlHkbU8DhoFmQRXuYvLgGu"],
    ["CLBL-N8Y4", "Coolblue B.V.",        "9t7pkyGlWV9Z6Hi0gZcZCrJBw"],
    ["BOLC-O2Z7", "Bol.com B.V.",         "LcdM2htAXqAEE8rCaUbSLpJKa"],
  ]);
}

// ============================================================
// GAME CONFIGURATION
// ============================================================

const gameDeadline        = new Date(Date.now() + 4 * 60 * 60 * 1000);
const gameDurationSeconds = 4 * 60 * 60;

// Police/hacker accounts – add or change as needed
const hackerAccounts = {
  "politie1": "agent001",
  "politie2": "agent002",
  "politie3": "agent003",
  "darknet":  "darknet",
};

// ============================================================
// RUNTIME STATE  (rebuilt from DB on startup)
// ============================================================

let companieData = {};   // { [chatId]: { company, teamName, chat: [] } }
let hackerSockets = [];

// Restore all sessions from DB so chat history survives server restarts
(function loadFromDB() {
  const sessions = db.prepare("SELECT * FROM sessions").all();
  sessions.forEach((s) => {
    const msgs = db.prepare(
      "SELECT * FROM messages WHERE chatId = ? ORDER BY id"
    ).all(s.chatId);
    companieData[s.chatId] = {
      company:  s.company,
      teamName: s.teamName,
      chat:     msgs.map((m) => ({
        timestamp: m.timestamp,
        who:       m.who,
        chat:      m.chat,
        company:   m.company,
      })),
    };
  });
  console.log(`Restored ${sessions.length} session(s) from database`);
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

function isHacker(socket)               { return hackerSockets.some((s) => s.id === socket.id); }
function broadcastToHackers(topic, data){ hackerSockets.forEach((s) => s.emit(topic, data)); }
function getTimerData()                 { return { deadline: gameDeadline.getTime() / 1000, total: gameDurationSeconds }; }

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
  socket._data = { valid: false, company: "", chatId: "", teamName: "" };

  // ── COMPANY: validate token ──────────────────────────────
  socket.on("token-login", (data) => {
    const token    = String(data.token    || "").trim().toUpperCase();
    const teamName = String(data.teamName || "").trim();

    const entry = db.prepare("SELECT * FROM tokens WHERE token = ?").get(token);
    if (!entry) {
      socket.emit("token-invalid", { message: "Ongeldige toegangscode." });
      return;
    }

    const { company, chatId } = entry;
    const session = db.prepare("SELECT * FROM sessions WHERE chatId = ?").get(chatId);

    if (!session) {
      // First connection for this company – team name required
      if (!teamName) {
        socket.emit("token-needs-team", { company });
        return;
      }

      // Create session in DB
      db.prepare(
        "INSERT INTO sessions (chatId, company, teamName, createdAt) VALUES (?, ?, ?, ?)"
      ).run(chatId, company, teamName, getTimeStamp());

      companieData[chatId] = { company, teamName, chat: [] };

      const welcome = {
        timestamp: getTimeStamp(),
        who:       "darknet",
        chat:      "[ SYSTEEM MELDING ] Uw netwerk is gecompromitteerd door DarkNet Operators. Alle bestanden zijn versleuteld met AES-256 militaire encryptie. Om de decryptiesleutel te ontvangen dient u onze instructies op te volgen. Deel GEEN informatie met derden. Uw tijd is beperkt. Een negotiator neemt spoedig contact met u op.",
        company,
      };
      saveMessage(chatId, welcome);
      companieData[chatId].chat.push(welcome);

      socket._data = { valid: true, company, chatId, teamName };
      socket.join(chatId);

      socket.emit("token-valid", { company, chatId, teamName });
      socket.emit("timeleft", getTimerData());
      socket.emit("chat-message-darknet", welcome);
      broadcastToHackers("new-company", { chatId, company, teamName, chat: companieData[chatId].chat });

    } else {
      // Existing session – reconnect (team name already stored)
      const storedTeamName = session.teamName;

      if (!companieData[chatId]) {
        // Session in DB but not in memory (e.g. server restart) – already loaded at startup
        // Just in case:
        const msgs = db.prepare("SELECT * FROM messages WHERE chatId = ? ORDER BY id").all(chatId);
        companieData[chatId] = {
          company,
          teamName: storedTeamName,
          chat: msgs.map((m) => ({ timestamp: m.timestamp, who: m.who, chat: m.chat, company: m.company })),
        };
      }

      socket._data = { valid: true, company, chatId, teamName: storedTeamName };
      socket.join(chatId);

      socket.emit("token-valid", { company, chatId, teamName: storedTeamName });
      socket.emit("timeleft", getTimerData());
      companieData[chatId].chat.forEach((msg) => {
        socket.emit(msg.who === "darknet" ? "chat-message-darknet" : "chat-message-company", msg);
      });
    }

    console.log(`[+] Company: ${company} (${teamName || session?.teamName})`);
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

    if (!hackerAccounts[username] || hackerAccounts[username] !== password) {
      socket.emit("hacker-login-failed", { message: "Ongeldige inloggegevens." });
      return;
    }

    if (!isHacker(socket)) hackerSockets.push(socket);
    socket._data.isHacker = true;

    socket.emit("hacker-login-success", {
      username,
      companyData: companieData,
      timeleft:    getTimerData(),
    });

    console.log(`[+] Hacker logged in: ${username}`);
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

    console.log(`[-] Chat deleted: ${companieData[chatId].company}`);
    delete companieData[chatId];
    broadcastToHackers("chat-deleted", { chatId });
    // Note: session + messages stay in DB for audit trail
  });

  // ── ADMIN: get token list ────────────────────────────────
  socket.on("admin-get-tokens", () => {
    if (!isHacker(socket)) return;
    const tokens = db.prepare(
      "SELECT t.token, t.company, t.chatId, s.teamName " +
      "FROM tokens t LEFT JOIN sessions s ON t.chatId = s.chatId"
    ).all();
    const enriched = tokens.map((t) => ({
      ...t,
      active:       !!companieData[t.chatId],
      messageCount: companieData[t.chatId] ? companieData[t.chatId].chat.length : 0,
    }));
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

    const chatId = generateChatId();
    db.prepare("INSERT INTO tokens (token, company, chatId) VALUES (?, ?, ?)").run(token, company, chatId);
    console.log(`[+] Token created: ${token} → ${company}`);
    broadcastToHackers("admin-token-created", { token, company, chatId });
  });

  // ── ADMIN: delete token ──────────────────────────────────
  socket.on("admin-delete-token", (data) => {
    if (!isHacker(socket)) return;
    const token = String(data.token || "").trim().toUpperCase();
    const entry = db.prepare("SELECT * FROM tokens WHERE token = ?").get(token);
    if (!entry) return;

    db.prepare("DELETE FROM tokens WHERE token = ?").run(token);
    console.log(`[-] Token deleted: ${token}`);
    broadcastToHackers("admin-token-deleted", { token, chatId: entry.chatId });
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
  console.log(`\nDarkWebChat server running on port ${PORT}`);
  console.log(`Game deadline : ${gameDeadline.toUTCString()}\n`);
  console.log("Hacker accounts:", Object.keys(hackerAccounts).join(", "), "\n");
});
