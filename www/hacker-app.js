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

  socket.on("hacker-login-success", function (data) {
    // Redirect with session token only – credentials never appear in the URL
    window.location.href = "hacker-chat.html?s=" + encodeURIComponent(data.sessionToken);
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
  var sessionToken = getParam("s");

  if (!sessionToken) {
    window.location.href = "hacker-login.html";
  }

  var companyData    = {};
  var selectedChatId = null;
  var unreadCounts   = {};
  var timeleft       = null;
  var timerInterval  = null;
  var activeTab      = "chats";

  // ── Connect + authenticate via session token ─────────────
  socket.on("connect", function () {
    socket.emit("hacker-session-auth", { sessionToken: sessionToken });
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
    if (agentEl) agentEl.textContent = "Agent: " + data.username;

    startTimer(timeleft);
    updateSidebar();
    socket.emit("admin-get-tokens");
    socket.emit("admin-get-users");

    var overlay = document.getElementById("connecting-overlay");
    if (overlay) overlay.style.display = "none";
  });

  // ── Nieuwe company verbonden ─────────────────────────────
  socket.on("new-company", function (data) {
    companyData[data.chatId] = { company: data.company, teamName: data.teamName || "", chat: data.chat || [] };
    unreadCounts[data.chatId] = 1;
    updateSidebar();
    playBeep();
    socket.emit("admin-get-tokens");
  });

  // ── Binnenkomend bericht ─────────────────────────────────
  socket.on("update-chat", function (data) {
    var chatId = data.chatId;
    var msg    = data.msg;
    if (!companyData[chatId]) return;

    companyData[chatId].chat.push(msg);

    if (msg.who === "company" && chatId !== selectedChatId) {
      unreadCounts[chatId] = (unreadCounts[chatId] || 0) + 1;
      playBeep();
    }

    updateSidebar();

    if (chatId === selectedChatId) {
      appendChatMessage(msg);
    }
  });

  // ── Chat verwijderd (door andere operator) ───────────────
  socket.on("chat-deleted", function (data) {
    delete companyData[data.chatId];
    delete unreadCounts[data.chatId];
    if (selectedChatId === data.chatId) {
      selectedChatId = null;
      showEmptyChat();
    }
    updateSidebar();
    socket.emit("admin-get-tokens");
  });

  // ================================================================
  // ADMIN: TOKEN BEHEER
  // ================================================================

  socket.on("admin-tokens-data", function (tokens) {
    renderTokensTable(tokens);
    renderTokensSidebar(tokens);
  });

  socket.on("admin-token-created", function () {
    socket.emit("admin-get-tokens");
    showAdminMsg("token-admin-error", true, "\u2713 Token aangemaakt.");
    document.getElementById("new-token").value   = "";
    document.getElementById("new-company").value = "";
  });

  socket.on("admin-token-deleted", function () {
    socket.emit("admin-get-tokens");
  });

  socket.on("admin-error", function (data) {
    // Show error in whichever panel is active
    var id = activeTab === "users" ? "user-admin-error" : "token-admin-error";
    showAdminMsg(id, false, "\u2717 " + data.message);
  });

  // Token aanmaken
  window.createToken = function () {
    var token   = (document.getElementById("new-token").value || "").trim().toUpperCase();
    var company = (document.getElementById("new-company").value || "").trim();
    showAdminMsg("token-admin-error", false, "");

    token = token.replace(/[^A-Z0-9]/g, "");
    if (token.length > 4) token = token.slice(0, 4) + "-" + token.slice(4, 8);
    document.getElementById("new-token").value = token;

    if (!token || !company) {
      showAdminMsg("token-admin-error", false, "Vul zowel token als bedrijfsnaam in.");
      return;
    }
    socket.emit("admin-create-token", { token: token, company: company });
  };

  // Token verwijderen
  window.deleteToken = function (token) {
    if (!confirm("Token " + token + " verwijderen?")) return;
    socket.emit("admin-delete-token", { token: token });
  };

  // Vernieuwen
  window.refreshTokens = function () {
    socket.emit("admin-get-tokens");
  };

  // Auto-format nieuwe token input
  setTimeout(function () {
    var inp = document.getElementById("new-token");
    if (inp) {
      inp.addEventListener("input", function () {
        var v = this.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (v.length > 4) v = v.slice(0, 4) + "-" + v.slice(4, 8);
        this.value = v;
      });
    }
  }, 100);

  // Render tokentabel in het hoofdpaneel
  function renderTokensTable(tokens) {
    var tbody = document.getElementById("tokens-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!tokens || tokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-dim);text-align:center;padding:20px;">Geen tokens gevonden</td></tr>';
      return;
    }

    tokens.forEach(function (t) {
      var tr = document.createElement("tr");
      tr.className = t.active ? "token-row-active" : "";
      tr.innerHTML =
        '<td class="td-token">' + escapeHtml(t.token) + '</td>' +
        '<td>' + escapeHtml(t.company) + '</td>' +
        '<td>' + (t.teamName ? escapeHtml(t.teamName) : '<span style="color:var(--text-dim)">—</span>') + '</td>' +
        '<td>' + (t.active
          ? '<span class="badge-active">ACTIEF</span>'
          : '<span class="badge-inactive">WACHT</span>') + '</td>' +
        '<td style="text-align:center">' + (t.active ? t.messageCount : '—') + '</td>' +
        '<td><button class="token-del-btn" onclick="deleteToken(\'' + escapeHtml(t.token) + '\')">\u2715</button></td>';
      tbody.appendChild(tr);
    });
  }

  // Render compacte tokenlijst in de zijbalk (tokens tab)
  function renderTokensSidebar(tokens) {
    var list = document.getElementById("tokens-list");
    if (!list) return;
    list.innerHTML = "";

    if (!tokens || tokens.length === 0) {
      list.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px;">Geen tokens</div>';
      return;
    }

    tokens.forEach(function (t) {
      var item = document.createElement("div");
      item.className = "token-list-item " + (t.active ? "token-active" : "");
      item.innerHTML =
        '<div class="token-code">' + escapeHtml(t.token) + '</div>' +
        '<div class="token-meta">' + escapeHtml(t.company) + '</div>' +
        (t.teamName ? '<div class="token-team">' + escapeHtml(t.teamName) + '</div>' : '') +
        '<button class="token-del-btn-sm" onclick="deleteToken(\'' + escapeHtml(t.token) + '\')">\u2715</button>';
      list.appendChild(item);
    });
  }

  // ================================================================
  // ADMIN: GEBRUIKERS BEHEER
  // ================================================================

  socket.on("admin-users-data", function (users) {
    renderUsersTable(users);
    renderUsersSidebar(users);
  });

  socket.on("admin-user-created", function () {
    socket.emit("admin-get-users");
    showAdminMsg("user-admin-error", true, "\u2713 Operator aangemaakt.");
    document.getElementById("new-username").value      = "";
    document.getElementById("new-user-password").value = "";
  });

  socket.on("admin-user-deleted", function () {
    socket.emit("admin-get-users");
  });

  // Gebruiker aanmaken
  window.createUser = function () {
    var username = (document.getElementById("new-username").value || "").trim();
    var password = (document.getElementById("new-user-password").value || "").trim();
    showAdminMsg("user-admin-error", false, "");

    if (!username || !password) {
      showAdminMsg("user-admin-error", false, "Vul gebruikersnaam en wachtwoord in.");
      return;
    }
    socket.emit("admin-create-user", { username: username, password: password });
  };

  // Gebruiker verwijderen
  window.deleteUser = function (username) {
    if (!confirm("Operator '" + username + "' verwijderen?")) return;
    socket.emit("admin-delete-user", { username: username });
  };

  // Vernieuwen
  window.refreshUsers = function () {
    socket.emit("admin-get-users");
  };

  // Render gebruikerstabel in het hoofdpaneel
  function renderUsersTable(users) {
    var tbody = document.getElementById("users-table-body");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!users || users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-dim);text-align:center;padding:20px;">Geen gebruikers gevonden</td></tr>';
      return;
    }

    users.forEach(function (u) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="td-token">' + escapeHtml(u.username) + '</td>' +
        '<td><button class="ctrl-btn" onclick="promptResetPassword(\'' + escapeHtml(u.username) + '\')">RESET</button></td>' +
        '<td><button class="token-del-btn" onclick="deleteUser(\'' + escapeHtml(u.username) + '\')">\u2715</button></td>';
      tbody.appendChild(tr);
    });
  }

  // Render compacte gebruikerslijst in de zijbalk
  function renderUsersSidebar(users) {
    var list = document.getElementById("users-list");
    if (!list) return;
    list.innerHTML = "";

    if (!users || users.length === 0) {
      list.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px;">Geen operators</div>';
      return;
    }

    users.forEach(function (u) {
      var item = document.createElement("div");
      item.className = "token-list-item";
      item.innerHTML =
        '<div class="token-code" style="color:var(--cyan)">' + escapeHtml(u.username) + '</div>' +
        '<button class="token-del-btn-sm" onclick="deleteUser(\'' + escapeHtml(u.username) + '\')">\u2715</button>';
      list.appendChild(item);
    });
  }

  // Wachtwoord resetten via prompt
  window.promptResetPassword = function (username) {
    var newPass = prompt("Nieuw wachtwoord voor '" + username + "':");
    if (!newPass || !newPass.trim()) return;
    socket.emit("admin-create-user-reset", { username: username, password: newPass.trim() });
  };

  // ================================================================
  // TAB SWITCHING
  // ================================================================

  window.switchTab = function (tab) {
    activeTab = tab;

    document.getElementById("tab-chats").classList.toggle("active",  tab === "chats");
    document.getElementById("tab-tokens").classList.toggle("active", tab === "tokens");
    document.getElementById("tab-users").classList.toggle("active",  tab === "users");

    document.getElementById("sidebar-stats").style.display  = tab === "chats"  ? "flex"  : "none";
    document.getElementById("companies-list").style.display = tab === "chats"  ? "block" : "none";
    document.getElementById("tokens-panel").style.display   = tab === "tokens" ? "flex"  : "none";
    document.getElementById("users-panel").style.display    = tab === "users"  ? "flex"  : "none";

    document.getElementById("view-chat").style.display      = tab === "chats"  ? "flex"  : "none";
    document.getElementById("view-tokens").style.display    = tab === "tokens" ? "flex"  : "none";
    document.getElementById("view-users").style.display     = tab === "users"  ? "flex"  : "none";

    if (tab === "tokens") socket.emit("admin-get-tokens");
    if (tab === "users")  socket.emit("admin-get-users");
  };

  // ================================================================
  // TIMER
  // ================================================================

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
    var pad = function (n) { return String(n).padStart(2, "0"); };
    var el  = document.getElementById("hacker-timer");
    if (el) {
      el.textContent = d > 0
        ? d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s)
        : pad(h) + ":" + pad(m) + ":" + pad(s);
    }
  }

  // ================================================================
  // BEDRIJF SELECTEREN
  // ================================================================

  window.selectCompany = function (chatId) {
    selectedChatId       = chatId;
    unreadCounts[chatId] = 0;
    updateSidebar();
    renderChat(chatId);

    var targetEl   = document.getElementById("hacker-chat-target");
    var subtitleEl = document.getElementById("hacker-chat-subtitle");
    var data       = companyData[chatId] || {};
    if (targetEl)   targetEl.textContent   = data.company || chatId;
    if (subtitleEl) subtitleEl.textContent =
      (data.teamName ? "Team: " + data.teamName + " \u2502 " : "") +
      (data.chat ? data.chat.length : 0) + " berichten";

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
    chat.forEach(function (msg) { appendChatMessage(msg); });
  }

  function appendChatMessage(msg) {
    var container = document.getElementById("hacker-messages");
    if (!container) return;
    var div = document.createElement("div");
    div.className = "message " + msg.who;
    var sender = msg.who === "darknet" ? "DarkNet Operator" : (msg.company || "Bedrijf");
    div.innerHTML =
      '<div class="message-header">' +
        '<span class="message-sender">' + escapeHtml(sender) + '</span>' +
        '<span class="message-time">' + escapeHtml(msg.timestamp) + '</span>' +
      '</div>' +
      '<div class="message-bubble">' + escapeHtml(msg.chat) + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function showEmptyChat() {
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
    var list     = document.getElementById("companies-list");
    var ids      = Object.keys(companyData);
    var countEl  = document.getElementById("active-count");
    var unreadEl = document.getElementById("unread-count");

    if (countEl)  countEl.textContent  = ids.length;
    if (unreadEl) unreadEl.textContent = Object.values(unreadCounts).reduce(function (a, b) { return a + b; }, 0);

    if (!list) return;
    list.innerHTML = "";

    if (ids.length === 0) {
      list.innerHTML = '<div style="padding:14px;color:var(--text-dim);font-size:11px;">Geen actieve doelwitten</div>';
      return;
    }

    ids.forEach(function (chatId) {
      var data     = companyData[chatId] || {};
      var unread   = unreadCounts[chatId] || 0;
      var isActive = chatId === selectedChatId;
      var hasNew   = unread > 0;

      var item = document.createElement("div");
      item.className = "company-list-item" + (isActive ? " active" : "") + (hasNew ? " has-new" : "");
      item.onclick   = function () { selectCompany(chatId); };
      item.innerHTML =
        '<div class="company-list-name">' + escapeHtml(data.company || chatId) + '</div>' +
        '<div class="company-list-meta">' +
          '<span>' + (data.teamName ? escapeHtml(data.teamName) : "\u2014") + '</span>' +
          (unread > 0 ? '<span class="company-list-unread">+' + unread + ' nieuw</span>' : '<span>' + (data.chat ? data.chat.length : 0) + ' bericht(en)</span>') +
        '</div>';
      list.appendChild(item);
    });
  }

  // ── Bericht versturen ────────────────────────────────────
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

  // ── Chat verwijderen ─────────────────────────────────────
  window.deleteChat = function () {
    if (!selectedChatId) return;
    var company = (companyData[selectedChatId] || {}).company || selectedChatId;
    if (!confirm("Chat met " + company + " definitief verwijderen?")) return;
    socket.emit("delete-chat", { chatId: selectedChatId });
  };

  // ── Laatste bericht kopiëren ─────────────────────────────
  window.copyLastMessage = function () {
    if (!selectedChatId) return;
    var chat = (companyData[selectedChatId] || {}).chat || [];
    if (!chat.length) return;
    navigator.clipboard.writeText(chat[chat.length - 1].chat).catch(function () {});
  };

  // ── Notificatiebeep ──────────────────────────────────────
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
    } catch (e) { /* AudioContext niet beschikbaar */ }
  }

  // ── Admin feedback helper ────────────────────────────────
  function showAdminMsg(elId, isSuccess, text) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.style.color = isSuccess ? "var(--green)" : "var(--red)";
    el.textContent = text;
    if (text) setTimeout(function () { el.textContent = ""; }, 3000);
  }

  // Begin toestand
  showEmptyChat();
}
