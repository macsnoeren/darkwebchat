/* app.js – Company side (landing page + chat page) */
"use strict";

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key) || "";
}

function escapeHtml(str) {
  var d = document.createElement("div");
  d.textContent = String(str);
  return d.innerHTML;
}

var isLandingPage = !!document.getElementById("token-input");
var isChatPage    = !!document.getElementById("chat-messages");

// ================================================================
// LANDING PAGE  –  twee-staps toegang (token → teamnaam)
// ================================================================

if (isLandingPage) {
  var socket        = io();
  var connecting    = false;
  var tokenAccepted = false;

  function terminalPrint(text, cssColor) {
    var el = document.getElementById("terminal-dynamic");
    if (!el) return;
    var line = document.createElement("div");
    line.style.color      = cssColor || "var(--green)";
    line.style.fontSize   = "12px";
    line.style.lineHeight = "1.9";
    line.textContent      = text;
    el.appendChild(line);
  }

  window.submitStep = function () {
    if (connecting) return;
    var errorEl = document.getElementById("token-error");
    errorEl.textContent = "";

    if (!tokenAccepted) {
      // Stap 1: token valideren
      var token = document.getElementById("token-input").value.trim().toUpperCase();
      if (!token || token.length < 9) {
        errorEl.textContent = "Voer een geldige toegangscode in (bijv. RABO-A7X2).";
        return;
      }
      connecting = true;
      document.getElementById("connect-btn").disabled    = true;
      document.getElementById("connect-btn").textContent = "VERBINDEN...";
      socket.emit("token-login", { token: token });

    } else {
      // Stap 2: teamnaam insturen
      var teamName = document.getElementById("team-input").value.trim();
      if (!teamName) {
        errorEl.textContent = "Voer uw teamnaam in.";
        return;
      }
      connecting = true;
      document.getElementById("connect-btn").disabled    = true;
      document.getElementById("connect-btn").textContent = "VERBINDEN...";
      var token2 = document.getElementById("token-input").value.trim().toUpperCase();
      socket.emit("token-login", { token: token2, teamName: teamName });
    }
  };

  // Server: token geldig + teamnaam bekend → chatId ontvangen, doorsturen
  socket.on("token-valid", function (data) {
    var token = document.getElementById("token-input").value.trim().toUpperCase();
    terminalPrint("> Toegang verleend. Verbinding beveiligd.", "var(--green)");
    setTimeout(function () {
      window.location.href =
        "chat.html?token=" + encodeURIComponent(token) +
        "&chatId=" + encodeURIComponent(data.chatId);
    }, 600);
  });

  // Server: token geldig, maar teamnaam nog niet ingevuld
  socket.on("token-needs-team", function (data) {
    connecting    = false;
    tokenAccepted = true;

    var tokenInput    = document.getElementById("token-input");
    tokenInput.readOnly    = true;
    tokenInput.style.color = "var(--green)";

    terminalPrint("> Toegangscode geaccepteerd. Organisatie: " + data.company, "var(--green)");
    terminalPrint("> Identificeer uw team om de verbinding te voltooien.", "var(--text-dim)");

    document.getElementById("step-team").style.display = "flex";
    document.getElementById("team-input").focus();

    document.getElementById("connect-btn").disabled    = false;
    document.getElementById("connect-btn").textContent = "TEAM BEVESTIGEN \u2192";
  });

  // Server: token ongeldig
  socket.on("token-invalid", function () {
    connecting = false;
    document.getElementById("token-error").textContent =
      "\u2717 Ongeldige code. Controleer uw toegangscode en probeer opnieuw.";
    document.getElementById("connect-btn").disabled    = false;
    document.getElementById("connect-btn").textContent = "VERBINDING MAKEN \u2192";
  });
}

// ================================================================
// CHAT PAGE  –  real-time chat
// ================================================================

if (isChatPage) {
  var token  = getParam("token");
  var chatId = getParam("chatId");

  if (!token || !chatId) {
    window.location.href = "index.html";
  }

  var socket        = io();
  var timeleft      = null;
  var timerInterval = null;

  // Herverbinding: stuur zowel token als chatId mee
  socket.on("connect", function () {
    socket.emit("token-login", { token: token, chatId: chatId });
  });

  socket.on("token-valid", function (data) {
    var nameEl   = document.getElementById("company-name");
    var statusEl = document.getElementById("company-status");
    if (nameEl)   nameEl.textContent   = data.company + (data.teamName ? " \u2502 Team: " + data.teamName : "");
    if (statusEl) statusEl.textContent = "NETWERK GE\u00CBNCRYPTEERD \u2502 ONDERHANDELING ACTIEF";

    var overlay = document.getElementById("connecting-overlay");
    if (overlay) overlay.style.display = "none";
  });

  socket.on("token-needs-team", function () {
    window.location.href = "index.html?token=" + encodeURIComponent(token);
  });

  socket.on("token-invalid", function () {
    window.location.href = "index.html";
  });

  // ── Timer ─────────────────────────────────────────────────
  socket.on("timeleft", function (data) {
    timeleft = data;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  });

  function updateTimer() {
    if (!timeleft) return;
    var remaining = Math.max(0, Math.floor(timeleft.deadline - Date.now() / 1000));
    var d   = Math.floor(remaining / 86400);
    var h   = Math.floor((remaining % 86400) / 3600);
    var m   = Math.floor((remaining % 3600) / 60);
    var s   = remaining % 60;
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var el  = document.getElementById("timer-value");
    if (el) {
      el.textContent = d > 0
        ? d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s)
        : pad(h) + ":" + pad(m) + ":" + pad(s);
      el.style.color = remaining < 1800 ? "#ff0000" : remaining < 3600 ? "#ff6600" : "var(--red)";
    }
    if (remaining === 0 && timerInterval) clearInterval(timerInterval);
  }

  // ── Berichten ontvangen ────────────────────────────────────
  socket.on("chat-message-darknet", function (msg) {
    appendMessage("darknet", "DarkNet Operator", msg.timestamp, msg.chat);
  });

  socket.on("chat-message-company", function (msg) {
    appendMessage("company", msg.company || "U", msg.timestamp, msg.chat);
  });

  function appendMessage(who, sender, timestamp, text) {
    var container = document.getElementById("chat-messages");
    if (!container) return;
    var div = document.createElement("div");
    div.className = "message " + who;
    div.innerHTML =
      '<div class="message-header">' +
        '<span class="message-sender">' + escapeHtml(sender) + '</span>' +
        '<span class="message-time">' + escapeHtml(timestamp) + '</span>' +
      '</div>' +
      '<div class="message-bubble">' + escapeHtml(text) + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ── Bericht versturen ──────────────────────────────────────
  var chatForm  = document.getElementById("chat-form");
  var chatInput = document.getElementById("chat-input");

  if (chatForm) {
    chatForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = chatInput.value.trim();
      if (!msg) return;
      socket.emit("chat-message-company", { msg: msg });
      chatInput.value = "";
    });
  }
}
