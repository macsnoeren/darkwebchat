"use strict";

const express    = require("express");
const { createServer } = require("node:http");
const { Server } = require("socket.io");

const app    = express();
const server = createServer(app);
const io     = new Server(server);

process.env.TZ = "UTC";
app.use(express.static("www"));

// ============================================================
// GAME CONFIGURATION
// ============================================================

// Game deadline: 4 hours from server start (adjust as needed)
const gameDeadline        = new Date(Date.now() + 4 * 60 * 60 * 1000);
const gameDurationSeconds = 4 * 60 * 60;

// Police / hacker accounts – add or change as needed
const hackerAccounts = {
  "politie1": "agent001",
  "politie2": "agent002",
  "politie3": "agent003",
  "darknet":  "darknet",
};

// Access tokens – hand one token to each student group
// Format: TOKEN -> { company, chatId }
const accessTokens = {
  "RABO-A7X2": { company: "Rabobank N.V.",       chatId: "dS5kiwjV2VMSi2jJlxPewYC4U" },
  "ING0-B3K9": { company: "ING Groep N.V.",      chatId: "qXDY7Sz1d1XGc4BRpGeymuGWZ" },
  "ABNM-C5R1": { company: "ABN AMRO Bank N.V.",  chatId: "dOsW8EPTqpcsmmq4KBcqeE3cS" },
  "PHLI-D8J4": { company: "Philips N.V.",         chatId: "P048tdEMCBuwb17KBY66UxmV2" },
  "SHLL-E2M7": { company: "Shell plc",            chatId: "JB0okKxSoifhL16hr0XW6wBfE" },
  "ASML-F6N3": { company: "ASML Holding N.V.",   chatId: "QxBqArvo2BF5zFo5Gd2RwIL5I" },
  "UNVR-G9P0": { company: "Unilever N.V.",        chatId: "PkMPKEbYzM0F6kFAIImVfXLgB" },
  "HEIN-H1Q5": { company: "Heineken N.V.",        chatId: "LrvF8yLqqWhPShi0ap8dKgRsc" },
  "WKLU-I4S8": { company: "Wolters Kluwer N.V.", chatId: "puIjJM5XkZrRk9J28x5U60xq0" },
  "NNGI-J7T2": { company: "NN Group N.V.",        chatId: "vJBTtf6HlHh36GsWRSy1RMjEA" },
  "PTNL-K0V6": { company: "PostNL N.V.",          chatId: "a6edzXzjsUfwM3mMbIFHKH7Af" },
  "NSNL-L3W9": { company: "NS Groep N.V.",        chatId: "jjCC6XbfY7ylgWVmfIUHuVoxj" },
  "KPNL-M5X1": { company: "KPN N.V.",             chatId: "kjsdlHkbU8DhoFmQRXuYvLgGu" },
  "CLBL-N8Y4": { company: "Coolblue B.V.",        chatId: "9t7pkyGlWV9Z6Hi0gZcZCrJBw" },
  "BOLC-O2Z7": { company: "Bol.com B.V.",         chatId: "LcdM2htAXqAEE8rCaUbSLpJKa" },
};

// ============================================================
// SERVER STATE
// ============================================================

let companieData = {};   // { [chatId]: { company, chat: [] } }
let hackerSockets = [];  // Active police/hacker socket connections

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

function isHacker(socket) {
  return hackerSockets.some((s) => s.id === socket.id);
}

function broadcastToHackers(topic, data) {
  hackerSockets.forEach((s) => s.emit(topic, data));
}

function getTimerData() {
  return { deadline: gameDeadline.getTime() / 1000, total: gameDurationSeconds };
}

// ============================================================
// SOCKET HANDLERS
// ============================================================

io.on("connection", (socket) => {
  socket._data = { valid: false, company: "", chatId: "" };

  // ── COMPANY: validate token and enter chat ─────────────────
  socket.on("token-login", (data) => {
    const token = String(data.token || "").trim().toUpperCase();
    const entry = accessTokens[token];

    if (!entry) {
      socket.emit("token-invalid", { message: "Ongeldige toegangscode." });
      return;
    }

    const { company, chatId } = entry;
    socket._data = { valid: true, company, chatId };
    socket.join(chatId);

    if (companieData[chatId]) {
      // Restore existing session – replay full history
      socket.emit("token-valid", { company, chatId });
      socket.emit("timeleft", getTimerData());
      companieData[chatId].chat.forEach((msg) => {
        socket.emit(msg.who === "darknet" ? "chat-message-darknet" : "chat-message-company", msg);
      });
    } else {
      // New session
      companieData[chatId] = { company, chat: [] };

      const welcome = {
        timestamp: getTimeStamp(),
        who:       "darknet",
        chat:      "[ SYSTEEM MELDING ] Uw netwerk is gecompromitteerd door DarkNet Operators. Alle bestanden op uw servers zijn versleuteld met AES-256 militaire encryptie. Om de decryptiesleutel te ontvangen, dient u onze instructies op te volgen. Deel GEEN informatie met derden. Uw tijd is beperkt. Een negotiator neemt spoedig contact met u op.",
        company,
      };

      companieData[chatId].chat.push(welcome);
      socket.emit("token-valid", { company, chatId });
      socket.emit("timeleft", getTimerData());
      socket.emit("chat-message-darknet", welcome);
      broadcastToHackers("new-company", { chatId, company, chat: companieData[chatId].chat });
    }

    console.log(`[+] Company connected: ${company}`);
  });

  // ── COMPANY: send message ──────────────────────────────────
  socket.on("chat-message-company", (data) => {
    if (!socket._data.valid) return;
    const { chatId, company } = socket._data;
    if (!companieData[chatId]) return;

    const text = escape(String(data.msg || "").trim());
    if (!text) return;

    const msg = { timestamp: getTimeStamp(), who: "company", chat: text, company };
    companieData[chatId].chat.push(msg);
    io.to(chatId).emit("chat-message-company", msg);
    broadcastToHackers("update-chat", { chatId, msg });
  });

  // ── HACKER: login ──────────────────────────────────────────
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

  // ── HACKER: send message to company ───────────────────────
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

    companieData[chatId].chat.push(msg);
    io.to(chatId).emit("chat-message-darknet", msg);
    broadcastToHackers("update-chat", { chatId, msg });
  });

  // ── HACKER: delete a company chat ─────────────────────────
  socket.on("delete-chat", (data) => {
    if (!isHacker(socket)) return;
    const chatId = String(data.chatId || "");
    if (!companieData[chatId]) return;

    console.log(`[-] Chat deleted: ${companieData[chatId].company}`);
    delete companieData[chatId];
    broadcastToHackers("chat-deleted", { chatId });
  });

  // ── DISCONNECT ─────────────────────────────────────────────
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
  console.log("Access tokens:");
  Object.entries(accessTokens).forEach(([t, { company }]) =>
    console.log(`  ${t}  →  ${company}`)
  );
  console.log("\nHacker accounts:", Object.keys(hackerAccounts).join(", "), "\n");
});
