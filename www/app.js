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

// Detect which page we are on
var isLandingPage = !!document.getElementById("token-input");
var isChatPage    = !!document.getElementById("chat-messages");

// ================================================================
// LANDING PAGE  –  token validation
// ================================================================

if (isLandingPage) {
  var socket      = io();
  var connecting  = false;

  window.connectToken = function () {
    if (connecting) return;
    var token    = document.getElementById("token-input").value.trim().toUpperCase();
    var errorEl  = document.getElementById("token-error");
    var btn      = document.getElementById("connect-btn");

    if (!token) {
      errorEl.textContent = "Voer uw toegangscode in.";
      return;
    }

    errorEl.textContent  = "";
    connecting           = true;
    btn.disabled         = true;
    btn.textContent      = "VERBINDEN...";

    socket.emit("token-login", { token: token });
  };

  socket.on("token-valid", function () {
    var token = document.getElementById("token-input").value.trim().toUpperCase();
    window.location.href = "chat.html?token=" + encodeURIComponent(token);
  });

  socket.on("token-invalid", function (data) {
    var errorEl             = document.getElementById("token-error");
    var btn                 = document.getElementById("connect-btn");
    errorEl.textContent     = "\u2717 Ongeldige code. Controleer uw toegangscode en probeer opnieuw.";
    btn.disabled            = false;
    btn.textContent         = "VERBINDING MAKEN \u2192";
    connecting              = false;
  });
}

// ================================================================
// CHAT PAGE  –  real-time chat
// ================================================================

if (isChatPage) {
  var token = getParam("token");
  if (!token) {
    window.location.href = "index.html";
  }

  var socket        = io();
  var timeleft      = null;
  var timerInterval = null;

  // Authenticate with token after socket connects
  socket.on("connect", function () {
    socket.emit("token-login", { token: token });
  });

  // Token accepted – show UI
  socket.on("token-valid", function (data) {
    var nameEl   = document.getElementById("company-name");
    var statusEl = document.getElementById("company-status");
    if (nameEl)   nameEl.textContent   = data.company;
    if (statusEl) statusEl.textContent = "NETWERK GEËNCRYPTEERD \u2502 ONDERHANDELING ACTIEF";

    var overlay = document.getElementById("connecting-overlay");
    if (overlay) overlay.style.display = "none";
  });

  // Token rejected – go back to landing
  socket.on("token-invalid", function () {
    window.location.href = "index.html";
  });

  // ── Timer ──────────────────────────────────────────────────
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
    var pad = function(n) { return String(n).padStart(2, "0"); };
    var el  = document.getElementById("timer-value");
    if (el) {
      el.textContent = d > 0
        ? d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s)
        : pad(h) + ":" + pad(m) + ":" + pad(s);
      el.style.color = remaining < 1800 ? "#ff0000" : remaining < 3600 ? "#ff6600" : "var(--red)";
    }
    if (remaining === 0 && timerInterval) clearInterval(timerInterval);
  }

  // ── Incoming messages ──────────────────────────────────────
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

  // ── Send message ───────────────────────────────────────────
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
