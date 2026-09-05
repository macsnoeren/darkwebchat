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
app.use(express.static(path.join(__dirname, "www")));
app.use(express.json());

// ============================================================
// DATABASE SETUP
// ============================================================

// Waar de database landt. In een container hoort dit een gemount volume te
// zijn: staat het bestand in de image-laag, dan neemt elke update alle tokens,
// operators en gespreksgeschiedenis mee het graf in.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "game.db");
const db = new Database(DB_FILE);

// Migration: voeg auto_reply kolom toe aan sessions als die nog niet bestaat
const pragmaSessions0 = db.prepare("PRAGMA table_info(sessions)").all();
if (pragmaSessions0.length > 0 && !pragmaSessions0.some(c => c.name === "auto_reply")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN auto_reply INTEGER NOT NULL DEFAULT 0`);
  console.log("Migratie: auto_reply kolom toegevoegd aan sessions.");
}

// Migration: oude tokens-tabel had chatId kolom
const pragmaTokens = db.prepare("PRAGMA table_info(tokens)").all();
if (pragmaTokens.some(c => c.name === "chatId")) {
  console.log("Oud schema gedetecteerd – database migreren...");
  db.exec(`
    CREATE TABLE tokens_new (token TEXT PRIMARY KEY, company TEXT NOT NULL);
    INSERT INTO tokens_new SELECT token, company FROM tokens;
    DROP TABLE tokens;
    ALTER TABLE tokens_new RENAME TO tokens;
  `);
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
    chatId     TEXT PRIMARY KEY,
    token      TEXT NOT NULL,
    company    TEXT NOT NULL,
    teamName   TEXT NOT NULL DEFAULT '',
    createdAt  TEXT NOT NULL,
    auto_reply INTEGER NOT NULL DEFAULT 0
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

  CREATE TABLE IF NOT EXISTS api_keys (
    key_value  TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- message_id is het bericht waar deze suggestie een antwoord op is. Zonder
  -- dat verband weet niets in dit bestand of de AI al gekeken heeft naar wat er
  -- nu als laatste in de chat staat: een suggestie is geen bericht, dus het
  -- gesprek ziet er na een suggestie precies zo uit als ervoor. Zie get_pending.
  CREATE TABLE IF NOT EXISTS ai_suggestions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId     TEXT NOT NULL,
    agent_id   TEXT NOT NULL,
    message    TEXT NOT NULL,
    level_up   INTEGER NOT NULL DEFAULT 0,
    timestamp  TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    message_id INTEGER NOT NULL DEFAULT 0
  );

  -- Het geheugen van de onderhandeling: vraagprijs, of er een akkoord ligt, en
  -- een samenvatting van wat er gezegd is. De agent stuurt het hele gesprek dus
  -- niet elke beurt opnieuw door een model heen.
  CREATE TABLE IF NOT EXISTS negotiation_state (
    chatId     TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updatedAt  TEXT NOT NULL
  );
`);

// Migration: suggesties dragen sinds deze versie de voorgestelde staat en een
// waarschuwing met zich mee.
const pragmaSuggestions = db.prepare("PRAGMA table_info(ai_suggestions)").all();
if (pragmaSuggestions.length > 0 && !pragmaSuggestions.some((c) => c.name === "state_json")) {
  db.exec(`ALTER TABLE ai_suggestions ADD COLUMN state_json TEXT`);
  db.exec(`ALTER TABLE ai_suggestions ADD COLUMN warning TEXT NOT NULL DEFAULT ''`);
  console.log("Migratie: state_json en warning toegevoegd aan ai_suggestions.");
}

// Migration: een suggestie weet sinds deze versie welk bericht hij beantwoordt.
// Bestaande rijen houden 0 en tellen dus nergens als antwoord mee: elke chat die
// nu openstaat krijgt na deze migratie nog één suggestie, en komt daarna tot
// rust. Dat is de goede kant om het mis te hebben — een keer te veel gekeken is
// hersteld met één klik, een keer te weinig is een gemist antwoord.
if (pragmaSuggestions.length > 0 && !pragmaSuggestions.some((c) => c.name === "message_id")) {
  db.exec(`ALTER TABLE ai_suggestions ADD COLUMN message_id INTEGER NOT NULL DEFAULT 0`);
  console.log("Migratie: message_id toegevoegd aan ai_suggestions.");
}

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

// GAME_DURATION_HOURS bepaalt hoe lang de oefening duurt.
// GAME_DEADLINE is een absoluut ISO-tijdstip (bijv. "2026-10-30T16:00:00Z").
// Zonder GAME_DEADLINE telt de klok vanaf het opstarten van dit proces af, en
// dan verspringt de deadline dus bij elke herstart van de container.
const gameDurationHours = Number(process.env.GAME_DURATION_HOURS || 4);
if (!Number.isFinite(gameDurationHours) || gameDurationHours <= 0) {
  console.error(`GAME_DURATION_HOURS is geen positief getal: "${process.env.GAME_DURATION_HOURS}"`);
  process.exit(1);
}

const gameDurationSeconds = Math.round(gameDurationHours * 3600);
const gameDeadline        = process.env.GAME_DEADLINE
  ? new Date(process.env.GAME_DEADLINE)
  : new Date(Date.now() + gameDurationSeconds * 1000);

if (Number.isNaN(gameDeadline.getTime())) {
  console.error(`GAME_DEADLINE is geen geldige datum: "${process.env.GAME_DEADLINE}"`);
  process.exit(1);
}

// ============================================================
// RUNTIME STATE
// ============================================================

let companieData   = {};
let hackerSockets  = [];
let hackerSessions = {};  // { sessionToken: username }
let claims         = {};  // { chatId: { agentId, claimedAt } }  – in-memory, expires 5 min
let activeAgents   = {};  // { agentId: { lastSeen, keyName } }

const CLAIM_TTL_MS = 5 * 60 * 1000;

function claimExpired(claim) {
  return Date.now() - claim.claimedAt > CLAIM_TTL_MS;
}

(function loadFromDB() {
  const sessions = db.prepare("SELECT * FROM sessions").all();
  sessions.forEach((s) => {
    const msgs = db.prepare(
      "SELECT * FROM messages WHERE chatId = ? ORDER BY id"
    ).all(s.chatId);
    companieData[s.chatId] = {
      company:    s.company,
      token:      s.token,
      teamName:   s.teamName,
      auto_reply: !!s.auto_reply,
      chat:       msgs.map((m) => ({
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

function generateApiKey() {
  const hex = "abcdef0123456789";
  const rand = Array.from({ length: 32 }, () => hex[Math.floor(Math.random() * hex.length)]).join("");
  return "dk_" + rand;
}

function buildAgentList() {
  const TIMEOUT_MS = 90 * 1000; // 3× poll interval
  const now = Date.now();
  return Object.entries(activeAgents)
    .filter(([, a]) => now - a.lastSeen < TIMEOUT_MS)
    .map(([id, a]) => ({ id, keyName: a.keyName, lastSeen: a.lastSeen }));
}

function saveMessage(chatId, msg) {
  db.prepare(
    "INSERT INTO messages (chatId, timestamp, who, chat, company) VALUES (?, ?, ?, ?, ?)"
  ).run(chatId, msg.timestamp, msg.who, msg.chat, msg.company);
}

// Het id van het laatste bericht in een chat. De berichten in companieData
// dragen dat niet: die zijn er om getoond te worden, en het id bestaat alleen in
// de database. Daarom hier gevraagd en niet uit het geheugen gelezen.
function lastMessageId(chatId) {
  const row = db.prepare("SELECT MAX(id) AS id FROM messages WHERE chatId = ?").get(chatId);
  return (row && row.id) || 0;
}

// De chats waarvan het laatste bericht al een suggestie heeft gekregen.
//
// De status doet er met opzet niet toe. Een suggestie die de operator negeert is
// er een die hij zelf afhandelt, en een tweede laten maken is dan precies wat
// hij niet vroeg — dat was de lus: de AI schrijft geen bericht, dus het gesprek
// zag er na elke suggestie weer even onbeantwoord uit als ervoor, en om de 30
// seconden werd er een nieuwe gemaakt. Stuurt het bedrijf wél weer iets, dan is
// er een nieuw laatste bericht en hoort deze chat er vanzelf weer bij.
function chatsAnsweredByAI() {
  const rows = db.prepare(`
    SELECT DISTINCT s.chatId
    FROM ai_suggestions s
    WHERE s.message_id > 0
      AND s.message_id = (SELECT MAX(m.id) FROM messages m WHERE m.chatId = s.chatId)
  `).all();
  return new Set(rows.map((r) => r.chatId));
}

function resolveOtherSuggestions(chatId) {
  const pending = db.prepare("SELECT id FROM ai_suggestions WHERE chatId = ? AND status = 'pending'").all(chatId);
  if (pending.length > 0) {
    db.prepare("UPDATE ai_suggestions SET status = 'obsolete' WHERE chatId = ? AND status = 'pending'").run(chatId);
    pending.forEach((s) => {
      broadcastToHackers("admin-suggestion-resolved", { id: s.id, status: "obsolete" });
    });
  }
}

function validateApiKey(req) {
  const key = req.headers["x-api-token"] || req.query.token || "";
  return !!db.prepare("SELECT key_value FROM api_keys WHERE key_value = ?").get(key);
}

// De onderhandelingsstaat hoort bij het bericht dat daadwerkelijk verstuurd is.
// Er draaien meerdere modellen per chat en elk stuurt een eigen suggestie mét
// een eigen samenvatting; die van een weggeklikte suggestie mag het geheugen
// niet worden. Vandaar dat promoveren pas gebeurt bij gebruiken of auto-sturen.
function promoteState(chatId, stateJson) {
  if (!stateJson) return;
  db.prepare(
    "INSERT INTO negotiation_state (chatId, state_json, updatedAt) VALUES (?, ?, ?) " +
    "ON CONFLICT(chatId) DO UPDATE SET state_json = excluded.state_json, updatedAt = excluded.updatedAt"
  ).run(chatId, stateJson, getTimeStamp());
}

function loadState(chatId) {
  const row = db.prepare("SELECT state_json FROM negotiation_state WHERE chatId = ?").get(chatId);
  if (!row) return null;
  try {
    return JSON.parse(row.state_json);
  } catch {
    return null;
  }
}

// De berichten los, naast het platte transcript. Dat transcript heeft geen
// betrouwbare scheiding tussen afzender en inhoud: typt een bedrijf zelf
// "[21:10] DarkNet Operator: …", dan staat dat er als een bericht van de
// hacker. Als losse velden is die verwarring onmogelijk.
function chatMessages(chatId) {
  const data = companieData[chatId];
  if (!data) return [];
  return data.chat.map((m) => ({
    who:       m.who === "darknet" ? "darknet" : "company",
    timestamp: m.timestamp,
    text:      m.chat,
  }));
}

function formatChatHistory(chatId) {
  const data = companieData[chatId];
  if (!data) return "";
  return data.chat.map((m) => {
    const sender = m.who === "darknet"
      ? "DarkNet Operator"
      : `${m.company}${data.teamName ? " (Team: " + data.teamName + ")" : ""}`;
    return `[${m.timestamp}] ${sender}: ${m.chat}`;
  }).join("\n");
}

// ============================================================
// REST API  –  /api
// ============================================================

app.get("/api", (req, res) => {
  if (!validateApiKey(req)) {
    return res.status(401).json({ error: "Authenticatie mislukt. Controleer je API_KEY." });
  }

  const action = req.query.action || "";

  if (action === "get_pending") {
    // Alleen chats waarvan het laatste bericht van het bedrijf is, waar de AI
    // nog niet naar dat bericht heeft gekeken, en die niet actief geclaimd zijn
    // door een andere agent.
    const answered = chatsAnsweredByAI();
    const tasks = Object.entries(companieData)
      .filter(([chatId, data]) => {
        const claim = claims[chatId];
        const lastMsg = data.chat[data.chat.length - 1];
        const lastIsCompany = lastMsg && lastMsg.who === "company";
        return lastIsCompany && !answered.has(chatId) && (!claim || claimExpired(claim));
      })
      .map(([chatId, data]) => ({
        team_id:      chatId,
        team_name:    data.teamName || data.company,
        company:      data.company,
        chat_history: formatChatHistory(chatId),
        messages:     chatMessages(chatId),
        state:        loadState(chatId),
        // De tijdsdruk komt uit de klok van de oefening in plaats van uit iets
        // dat het model verzint, zodat "voor 23:00" ook echt klopt.
        deadline:     gameDeadline.toISOString(),
      }));

    return res.json(tasks);
  }

  return res.status(400).json({ error: "Onbekende actie." });
});

app.post("/api", (req, res) => {
  if (!validateApiKey(req)) {
    return res.status(401).json({ error: "Authenticatie mislukt. Controleer je API_KEY." });
  }

  const action   = req.query.action || "";
  const body     = req.body || {};
  const agentId  = String(body.agent_id || "unknown");

  if (action === "claim_task") {
    const chatId = String(body.team_id || "");
    if (!companieData[chatId]) {
      return res.status(404).json({ error: "Chat niet gevonden." });
    }
    const existing = claims[chatId];
    if (existing && !claimExpired(existing) && existing.agentId !== agentId) {
      return res.status(409).json({ error: "Al geclaimd door een andere agent." });
    }
    claims[chatId] = { agentId, claimedAt: Date.now() };
    return res.json({ ok: true });
  }

  if (action === "send_suggestion") {
    const chatId  = String(body.team_id || "");
    const message = String(body.message  || "").trim();
    const levelUp = body.level_up ? 1 : 0;

    if (!companieData[chatId]) {
      return res.status(404).json({ error: "Chat niet gevonden." });
    }
    if (!message) {
      return res.status(400).json({ error: "Bericht is leeg." });
    }

    const ts = getTimeStamp();
    const cleanMessage = message.replace(/^[\s\S]*?🤖[^\n]*\n+/, "").trim() || message.trim();

    // Het bericht waar deze suggestie een antwoord op is, vastgelegd vóór er
    // iets geschreven wordt: bij auto-reply komt het antwoord er hieronder als
    // bericht bij, en dan zou MAX(id) het antwoord zelf aanwijzen in plaats van
    // de vraag.
    const answersMessageId = lastMessageId(chatId);

    // De agent stelt een bijgewerkte staat voor. Opslaan doen we hem hier nog
    // niet — dat gebeurt pas als dit bericht ook echt verstuurd wordt.
    const stateJson = body.state ? JSON.stringify(body.state) : null;
    const warning   = String(body.warning || "").slice(0, 300);

    // Claim vrijgeven na suggestie
    delete claims[chatId];

    // Auto-reply: stuur direct als bericht zonder tussenkomst operator
    if (companieData[chatId].auto_reply) {
      const text = escape(cleanMessage);
      const msg  = { timestamp: ts, who: "darknet", chat: text, company: companieData[chatId].company };
      saveMessage(chatId, msg);
      companieData[chatId].chat.push(msg);
      io.to(chatId).emit("chat-message-darknet", msg);
      broadcastToHackers("update-chat", { chatId, msg });
      resolveOtherSuggestions(chatId);
      promoteState(chatId, stateJson);
      db.prepare(
        "INSERT INTO ai_suggestions (chatId, agent_id, message, level_up, timestamp, status, state_json, warning, message_id) VALUES (?, ?, ?, ?, ?, 'auto-sent', ?, ?, ?)"
      ).run(chatId, agentId, cleanMessage, levelUp, ts, stateJson, warning, answersMessageId);
      if (warning) console.log(`[AI] ${warning} (chat ${chatId})`);
      console.log(`[AI] Auto-reply verstuurd voor chat ${chatId} via ${agentId}`);
      return res.json({ ok: true, auto_sent: true });
    }

    // Handmatige modus: sla op als suggestie voor de operator
    const result = db.prepare(
      "INSERT INTO ai_suggestions (chatId, agent_id, message, level_up, timestamp, status, state_json, warning, message_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)"
    ).run(chatId, agentId, cleanMessage, levelUp, ts, stateJson, warning, answersMessageId);

    const suggestion = {
      id:        result.lastInsertRowid,
      chatId,
      agentId,
      message:   cleanMessage,
      levelUp:   !!levelUp,
      timestamp: ts,
      company:   companieData[chatId].company,
      teamName:  companieData[chatId].teamName,
      warning,
    };

    broadcastToHackers("admin-ai-suggestion", suggestion);
    if (warning) console.log(`[AI] ${warning} (chat ${chatId})`);
    console.log(`[AI] Suggestie ontvangen van ${agentId} voor chat ${chatId}`);

    return res.json({ ok: true, id: result.lastInsertRowid });
  }

  if (action === "heartbeat") {
    const keyName = (db.prepare("SELECT name FROM api_keys WHERE key_value = ?")
      .get(req.headers["x-api-token"] || req.query.token || "") || {}).name || "onbekend";
    const isNew = !activeAgents[agentId];
    activeAgents[agentId] = { lastSeen: Date.now(), keyName };
    if (isNew) broadcastToHackers("admin-agents-changed", buildAgentList());
    return res.json({ ok: true });
  }

  if (action === "unregister_agent") {
    delete activeAgents[agentId];
    broadcastToHackers("admin-agents-changed", buildAgentList());
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: "Onbekende actie." });
});

// ============================================================
// SOCKET HANDLERS
// ============================================================

io.on("connection", (socket) => {
  socket._data = { valid: false, company: "", chatId: "", teamName: "", token: "" };

  // ── COMPANY: validate token ──────────────────────────────
  socket.on("token-login", (data) => {
    const token    = String(data.token    || "").trim().toUpperCase();
    const teamName = String(data.teamName || "").trim();
    const chatId   = String(data.chatId   || "").trim();

    const entry = db.prepare("SELECT * FROM tokens WHERE token = ?").get(token);
    if (!entry) { socket.emit("token-invalid"); return; }

    const { company } = entry;

    // Geval 3: herverbinding vanuit chat-pagina via chatId
    if (chatId) {
      const session = db.prepare("SELECT * FROM sessions WHERE chatId = ? AND token = ?").get(chatId, token);
      if (!session) { socket.emit("token-invalid"); return; }

      if (!companieData[chatId]) {
        const msgs = db.prepare("SELECT * FROM messages WHERE chatId = ? ORDER BY id").all(chatId);
        companieData[chatId] = {
          company, token, teamName: session.teamName,
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

    // Geval 1: geen teamnaam → vraag het op
    if (!teamName) { socket.emit("token-needs-team", { company }); return; }

    // Geval 2: token + teamnaam → bestaande of nieuwe sessie
    const existingSession = db.prepare("SELECT * FROM sessions WHERE token = ? AND teamName = ?").get(token, teamName);

    if (existingSession) {
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

    const newChatId = generateChatId();
    db.prepare("INSERT INTO sessions (chatId, token, company, teamName, createdAt) VALUES (?, ?, ?, ?, ?)").run(newChatId, token, company, teamName, getTimeStamp());
    companieData[newChatId] = { company, token, teamName, auto_reply: false, chat: [] };

    const welcome = {
      timestamp: getTimeStamp(), who: "darknet", company,
      chat: "[ SYSTEEM MELDING ] Uw netwerk is gecompromitteerd door DarkNet Operators. Alle bestanden zijn versleuteld met AES-256 militaire encryptie. Om de decryptiesleutel te ontvangen dient u onze instructies op te volgen. Deel GEEN informatie met derden. Uw tijd is beperkt. Een negotiator neemt spoedig contact met u op.",
    };
    saveMessage(newChatId, welcome);
    companieData[newChatId].chat.push(welcome);

    socket._data = { valid: true, company, chatId: newChatId, teamName, token };
    socket.join(newChatId);
    socket.emit("token-valid", { company, chatId: newChatId, teamName });
    socket.emit("timeleft", getTimerData());
    socket.emit("chat-message-darknet", welcome);
    broadcastToHackers("new-company", { chatId: newChatId, company, token, teamName, chat: companieData[newChatId].chat });
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

  // ── HACKER: session auth ─────────────────────────────────
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
    socket.emit("hacker-login-success", { username, companyData: companieData, timeleft: getTimerData() });
    socket.emit("admin-agents-changed", buildAgentList());
    console.log(`[~] Operator sessie hersteld: ${username}`);

    // Stuur openstaande suggesties mee
    const pending = db.prepare(
      "SELECT * FROM ai_suggestions WHERE status = 'pending' ORDER BY id"
    ).all();
    if (pending.length > 0) {
      pending.forEach((s) => {
        const cd = companieData[s.chatId];
        socket.emit("admin-ai-suggestion", {
          id:        s.id,
          chatId:    s.chatId,
          agentId:   s.agent_id,
          message:   s.message,
          levelUp:   !!s.level_up,
          timestamp: s.timestamp,
          company:   cd ? cd.company  : "?",
          teamName:  cd ? cd.teamName : "?",
          warning:   s.warning || "",
        });
      });
    }
  });

  // ── HACKER: send message ─────────────────────────────────
  socket.on("chat-message-darknet", (data) => {
    if (!isHacker(socket)) return;
    const chatId = String(data.chatId || "");
    if (!companieData[chatId]) return;

    const text = escape(String(data.msg || "").trim());
    if (!text) return;

    const msg = { timestamp: getTimeStamp(), who: "darknet", chat: text, company: companieData[chatId].company };
    saveMessage(chatId, msg);
    companieData[chatId].chat.push(msg);
    io.to(chatId).emit("chat-message-darknet", msg);
    broadcastToHackers("update-chat", { chatId, msg });
    resolveOtherSuggestions(chatId);
  });

  // ── HACKER: delete chat ──────────────────────────────────
  socket.on("delete-chat", (data) => {
    if (!isHacker(socket)) return;
    const chatId = String(data.chatId || "");
    if (!companieData[chatId]) return;
    console.log(`[-] Chat verwijderd: ${companieData[chatId].company} / ${companieData[chatId].teamName}`);
    delete companieData[chatId];
    broadcastToHackers("chat-deleted", { chatId });
    resolveOtherSuggestions(chatId);
  });

  // ── HACKER: gebruik AI-suggestie als bericht ─────────────
  socket.on("admin-use-suggestion", (data) => {
    if (!isHacker(socket)) return;
    const id     = Number(data.id);
    const chatId = String(data.chatId || "");
    if (!companieData[chatId]) return;

    const suggestion = db.prepare("SELECT * FROM ai_suggestions WHERE id = ? AND status = 'pending'").get(id);
    if (!suggestion) return;

    // Strip old-format model-header lines (bijv. "🤖 **AI Advies (model)** - Score: ...")
    // zodat alleen het eigenlijke bericht wordt overgenomen.
    const cleanMessage = suggestion.message
      .replace(/^[\s\S]*?🤖[^\n]*\n+/, "")  // verwijder alles t/m de 🤖-regel
      .trim();

    const text = escape(cleanMessage || suggestion.message.trim());
    const msg  = { timestamp: getTimeStamp(), who: "darknet", chat: text, company: companieData[chatId].company };
    saveMessage(chatId, msg);
    companieData[chatId].chat.push(msg);
    io.to(chatId).emit("chat-message-darknet", msg);
    broadcastToHackers("update-chat", { chatId, msg });

    // Dit bericht ís nu het gesprek, dus de samenvatting die eraan hangt wordt
    // het geheugen. De samenvattingen van de suggesties die de operator naast
    // zich neerlegt verdwijnen met die suggesties.
    promoteState(chatId, suggestion.state_json);

    db.prepare("UPDATE ai_suggestions SET status = 'used' WHERE id = ?").run(id);
    broadcastToHackers("admin-suggestion-resolved", { id, status: "used" });
    resolveOtherSuggestions(chatId);
    console.log(`[AI] Suggestie #${id} gebruikt door operator`);
  });

  // ── HACKER: negeer AI-suggestie ──────────────────────────
  socket.on("admin-dismiss-suggestion", (data) => {
    if (!isHacker(socket)) return;
    const id = Number(data.id);
    db.prepare("UPDATE ai_suggestions SET status = 'dismissed' WHERE id = ?").run(id);
    broadcastToHackers("admin-suggestion-resolved", { id, status: "dismissed" });
    console.log(`[AI] Suggestie #${id} genegeerd`);
  });

  // ── ADMIN: get token list ────────────────────────────────
  socket.on("admin-get-tokens", () => {
    if (!isHacker(socket)) return;
    const tokens = db.prepare("SELECT * FROM tokens ORDER BY token").all();
    const enriched = tokens.map((t) => {
      const sessions = db.prepare("SELECT chatId, teamName FROM sessions WHERE token = ? ORDER BY createdAt").all(t.token);
      const teams = sessions.map((s) => ({
        chatId:       s.chatId,
        teamName:     s.teamName,
        active:       !!companieData[s.chatId],
        messageCount: companieData[s.chatId] ? companieData[s.chatId].chat.length : 0,
      }));
      return { token: t.token, company: t.company, teams, activeCount: teams.filter((t) => t.active).length };
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
    broadcastToHackers("admin-token-created", { token, company });
  });

  // ── ADMIN: delete token ──────────────────────────────────
  socket.on("admin-delete-token", (data) => {
    if (!isHacker(socket)) return;
    const token = String(data.token || "").trim().toUpperCase();
    const entry = db.prepare("SELECT * FROM tokens WHERE token = ?").get(token);
    if (!entry) return;
    const sessions = db.prepare("SELECT chatId FROM sessions WHERE token = ?").all(token);
    sessions.forEach((s) => {
      delete companieData[s.chatId];
      db.prepare("DELETE FROM messages WHERE chatId = ?").run(s.chatId);
    });
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    db.prepare("DELETE FROM tokens WHERE token = ?").run(token);
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
    broadcastToHackers("admin-user-deleted", { username });
  });

  // ── ADMIN: get active AI agents ──────────────────────────
  socket.on("admin-get-agents", () => {
    if (!isHacker(socket)) return;
    socket.emit("admin-agents-changed", buildAgentList());
  });

  // ── ADMIN: get API-keys ──────────────────────────────────
  socket.on("admin-get-api-keys", () => {
    if (!isHacker(socket)) return;
    const keys = db.prepare("SELECT key_value, name, created_at FROM api_keys ORDER BY created_at DESC").all();
    socket.emit("admin-api-keys-data", keys);
  });

  // ── ADMIN: create API-key ────────────────────────────────
  socket.on("admin-create-api-key", (data) => {
    if (!isHacker(socket)) return;
    const name = String(data.name || "").trim();
    if (!name) {
      socket.emit("admin-error", { message: "Geef de API-sleutel een naam." });
      return;
    }
    const key = generateApiKey();
    db.prepare("INSERT INTO api_keys (key_value, name, created_at) VALUES (?, ?, ?)").run(key, name, getTimeStamp());
    console.log(`[+] API-sleutel aangemaakt: ${name}`);
    // Stuur de volledige key eenmalig terug zodat de operator hem kan kopiëren
    socket.emit("admin-api-key-created", { key, name });
    broadcastToHackers("admin-api-keys-changed");
  });

  // ── ADMIN: delete API-key ────────────────────────────────
  socket.on("admin-delete-api-key", (data) => {
    if (!isHacker(socket)) return;
    const key = String(data.key || "").trim();
    db.prepare("DELETE FROM api_keys WHERE key_value = ?").run(key);
    console.log(`[-] API-sleutel verwijderd`);
    broadcastToHackers("admin-api-keys-changed");
  });

  // ── ADMIN: get auto-reply status per team ───────────────
  socket.on("admin-get-auto-reply", () => {
    if (!isHacker(socket)) return;
    const list = Object.entries(companieData).map(([chatId, d]) => ({
      chatId,
      company:    d.company,
      teamName:   d.teamName,
      auto_reply: !!d.auto_reply,
    }));
    socket.emit("admin-auto-reply-data", list);
  });

  // ── ADMIN: toggle auto-reply voor één team ───────────────
  socket.on("admin-set-auto-reply", (data) => {
    if (!isHacker(socket)) return;
    const chatId  = String(data.chatId  || "");
    const enabled = !!data.enabled;
    if (!companieData[chatId]) return;

    companieData[chatId].auto_reply = enabled;
    db.prepare("UPDATE sessions SET auto_reply = ? WHERE chatId = ?").run(enabled ? 1 : 0, chatId);
    console.log(`[AI] Auto-reply ${enabled ? "AAN" : "UIT"} voor chat ${chatId}`);
    broadcastToHackers("admin-auto-reply-changed", { chatId, enabled });
  });

  // ── SETUP: check first-run ───────────────────────────────
  socket.on("check-setup", () => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    socket.emit("setup-status", { needsSetup: n === 0 });
  });

  // ── SETUP: create first operator ─────────────────────────
  socket.on("operator-setup", (data) => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    if (n > 0) { socket.emit("setup-error", { message: "Setup is al voltooid." }); return; }
    const username = String(data.username || "").trim();
    const password = String(data.password || "").trim();
    if (!username || !password) { socket.emit("setup-error", { message: "Vul beide velden in." }); return; }
    if (!/^[a-zA-Z0-9_-]{2,20}$/.test(username)) { socket.emit("setup-error", { message: "Gebruikersnaam ongeldig." }); return; }
    if (password.length < 6) { socket.emit("setup-error", { message: "Wachtwoord minimaal 6 tekens." }); return; }
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
  console.log(`Game deadline  : ${gameDeadline.toUTCString()}`);
  console.log(`REST API       : http://localhost:${PORT}/api`);
  console.log(`Database       : ${DB_FILE}\n`);
});
