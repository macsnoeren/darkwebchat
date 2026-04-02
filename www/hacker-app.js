/* hacker-app.js – Police / operator side (login + dashboard) */
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
var isLoginPage = !!document.getElementById("hacker-login-form");
var isDashboard = !!document.getElementById("companies-list");

// ================================================================
// LOGIN PAGE
// ================================================================

if (isLoginPage) {
  var socket = io();

  document.getElementById("hacker-login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var username = document.getElementById("hacker-username").value.trim();
    var password = document.getElementById("hacker-password").value;
    document.getElementById("login-error").textContent = "";
    socket.emit("hacker-login", { username: username, password: password });
  });

  socket.on("hacker-login-success", function () {
    var username = document.getElementById("hacker-username").value.trim();
    var password = document.getElementById("hacker-password").value;
    window.location.href = "hacker-chat.html?u=" +
      encodeURIComponent(username) + "&p=" + encodeURIComponent(password);
  });

  socket.on("hacker-login-failed", function (data) {
    document.getElementById("login-error").textContent =
      "\u2717 " + (data.message || "Login mislukt.");
  });
}

// ================================================================
// DASHBOARD
// ================================================================

if (isDashboard) {
  var socket       = io();
  var username     = getParam("u");
  var password     = getParam("p");

  if (!username || !password) {
    window.location.href = "hacker-login.html";
  }

  var companyData    = {};   // { [chatId]: { company, chat: [] } }
  var selectedChatId = null;
  var unreadCounts   = {};   // { [chatId]: number }
  var timeleft       = null;
  var timerInterval  = null;

  // ── Connect + authenticate ───────────────────────────────
  socket.on("connect", function () {
    socket.emit("hacker-login", { username: username, password: password });
  });

  socket.on("hacker-login-failed", function () {
    window.location.href = "hacker-login.html";
  });

  socket.on("hacker-login-success", function (data) {
    companyData = data.companyData || {};
    timeleft    = data.timeleft;

    Object.keys(companyData).forEach(function (id) {
      if (!(id in unreadCounts)) unreadCounts[id] = 0;
    });

    var agentEl = document.getElementById("sidebar-agent");
    if (agentEl) agentEl.textContent = "Agent: " + username;

    startTimer(timeleft);
    updateSidebar();

    var overlay = document.getElementById("connecting-overlay");
    if (overlay) overlay.style.display = "none";
  });

  // ── New company connected ────────────────────────────────
  socket.on("new-company", function (data) {
    companyData[data.chatId] = { company: data.company, chat: data.chat || [] };
    unreadCounts[data.chatId] = 1;
    updateSidebar();
    playBeep();
  });

  // ── Incoming message (company or darknet from another operator) ──
  socket.on("update-chat", function (data) {
    var chatId = data.chatId;
    var msg    = data.msg;
    if (!companyData[chatId]) return;

    companyData[chatId].chat.push(msg);

    // Count unread only for company messages when this chat isn't selected
    if (msg.who === "company" && chatId !== selectedChatId) {
      unreadCounts[chatId] = (unreadCounts[chatId] || 0) + 1;
      playBeep();
    }

    updateSidebar();

    if (chatId === selectedChatId) {
      appendMessage(msg);
    }
  });

  // ── Chat deleted (by another operator) ──────────────────
  socket.on("chat-deleted", function (data) {
    delete companyData[data.chatId];
    delete unreadCounts[data.chatId];
    if (selectedChatId === data.chatId) {
      selectedChatId = null;
      showEmptyState();
    }
    updateSidebar();
  });

  // ── Timer ────────────────────────────────────────────────
  function startTimer(tl) {
    timeleft = tl;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  }

  function updateTimer() {
    if (!timeleft) return;
    var remaining = Math.max(0, Math.floor(timeleft.deadline - Date.now() / 1000));
    var d   = Math.floor(remaining / 86400);
    var h   = Math.floor((remaining % 86400) / 3600);
    var m   = Math.floor((remaining % 3600) / 60);
    var s   = remaining % 60;
    var pad = function(n) { return String(n).padStart(2, "0"); };
    var el  = document.getElementById("hacker-timer");
    if (el) {
      el.textContent = d > 0
        ? d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s)
        : pad(h) + ":" + pad(m) + ":" + pad(s);
    }
  }

  // ── Select company ───────────────────────────────────────
  window.selectCompany = function (chatId) {
    selectedChatId       = chatId;
    unreadCounts[chatId] = 0;
    updateSidebar();
    renderChat(chatId);

    var targetEl   = document.getElementById("hacker-chat-target");
    var subtitleEl = document.getElementById("hacker-chat-subtitle");
    if (targetEl)   targetEl.textContent   = companyData[chatId].company;
    if (subtitleEl) subtitleEl.textContent =
      companyData[chatId].chat.length + " berichten \u2502 ChatID: " + chatId;

    var form    = document.getElementById("hacker-form");
    var sendBtn = document.getElementById("hacker-send-btn");
    if (form)    form.style.display = "flex";
    if (sendBtn) sendBtn.disabled   = false;
  };

  function renderChat(chatId) {
    var container = document.getElementById("hacker-messages");
    if (!container) return;
    container.innerHTML = "";
    var chat = (companyData[chatId] || {}).chat || [];
    chat.forEach(function(msg) { appendMessage(msg); });
  }

  function appendMessage(msg) {
    var container = document.getElementById("hacker-messages");
    if (!container) return;

    var div    = document.createElement("div");
    div.className = "message " + msg.who;
    var sender = msg.who === "darknet" ? "DarkNet Operator" : msg.company;
    div.innerHTML =
      '<div class="message-header">' +
        '<span class="message-sender">' + escapeHtml(sender) + '</span>' +
        '<span class="message-time">' + escapeHtml(msg.timestamp) + '</span>' +
      '</div>' +
      '<div class="message-bubble">' + escapeHtml(msg.chat) + '</div>';

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function showEmptyState() {
    var container  = document.getElementById("hacker-messages");
    var targetEl   = document.getElementById("hacker-chat-target");
    var subtitleEl = document.getElementById("hacker-chat-subtitle");
    var form       = document.getElementById("hacker-form");
    var sendBtn    = document.getElementById("hacker-send-btn");

    if (container)  container.innerHTML = '<div class="empty-state"><div>[ DARKNET OPERATORS ]</div><div style="font-size:10px;margin-top:8px;">Selecteer een organisatie om de onderhandeling te starten</div></div>';
    if (targetEl)   targetEl.textContent   = "Selecteer een doelwit";
    if (subtitleEl) subtitleEl.textContent = "Kies een organisatie uit de lijst";
    if (form)       form.style.display     = "none";
    if (sendBtn)    sendBtn.disabled       = true;
  }

  function updateSidebar() {
    var list   = document.getElementById("companies-list");
    var ids    = Object.keys(companyData);
    var countEl  = document.getElementById("active-count");
    var unreadEl = document.getElementById("unread-count");

    if (countEl)  countEl.textContent  = ids.length;
    if (unreadEl) unreadEl.textContent = Object.values(unreadCounts).reduce(function(a,b){return a+b;}, 0);

    if (!list) return;
    list.innerHTML = "";

    if (ids.length === 0) {
      list.innerHTML = '<div style="padding:14px;color:var(--text-dim);font-size:11px;">Geen actieve doelwitten</div>';
      return;
    }

    ids.forEach(function (chatId) {
      var company = companyData[chatId].company;
      var msgs    = companyData[chatId].chat.length;
      var unread  = unreadCounts[chatId] || 0;
      var isActive = chatId === selectedChatId;
      var hasNew   = unread > 0;

      var item      = document.createElement("div");
      item.className = "company-list-item" +
        (isActive ? " active" : "") + (hasNew ? " has-new" : "");
      item.onclick  = function() { selectCompany(chatId); };
      item.innerHTML =
        '<div class="company-list-name">' + escapeHtml(company) + '</div>' +
        '<div class="company-list-meta">' +
          '<span>' + msgs + ' berichten</span>' +
          (unread > 0 ? '<span class="company-list-unread">+' + unread + ' nieuw</span>' : '') +
        '</div>';
      list.appendChild(item);
    });
  }

  // ── Send message ─────────────────────────────────────────
  var hackerForm  = document.getElementById("hacker-form");
  var hackerInput = document.getElementById("hacker-input");

  if (hackerForm) {
    hackerForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!selectedChatId) return;
      var msg = hackerInput.value.trim();
      if (!msg) return;
      socket.emit("chat-message-darknet", { chatId: selectedChatId, msg: msg });
      hackerInput.value = "";
    });
  }

  // ── Delete chat ──────────────────────────────────────────
  window.deleteChat = function () {
    if (!selectedChatId) return;
    var company = (companyData[selectedChatId] || {}).company || selectedChatId;
    if (!confirm("Chat met " + company + " definitief verwijderen?")) return;
    socket.emit("delete-chat", { chatId: selectedChatId });
  };

  // ── Copy last message ────────────────────────────────────
  window.copyLastMessage = function () {
    if (!selectedChatId) return;
    var chat = (companyData[selectedChatId] || {}).chat || [];
    if (!chat.length) return;
    var last = chat[chat.length - 1];
    navigator.clipboard.writeText(last.chat).catch(function() {});
  };

  // ── Notification beep ────────────────────────────────────
  function playBeep() {
    try {
      var ctx  = new AudioContext();
      var osc  = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) { /* AudioContext unavailable */ }
  }

  // Initial state
  showEmptyState();
}
