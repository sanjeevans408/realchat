(() => {
  "use strict";

  const els = {
    authView: document.getElementById("authView"),
    chatView: document.getElementById("chatView"),
    authForm: document.getElementById("authForm"),
    authTabs: document.querySelectorAll(".auth-tab"),
    authError: document.getElementById("authError"),
    authSubmit: document.getElementById("authSubmit"),
    usernameInput: document.getElementById("usernameInput"),
    passwordInput: document.getElementById("passwordInput"),

    thread: document.getElementById("thread"),
    input: document.getElementById("input"),
    sendBtn: document.getElementById("sendBtn"),
    presenceLabel: document.getElementById("presenceLabel"),
    typingStrip: document.getElementById("typingStrip"),
    logoutBtn: document.getElementById("logoutBtn"),
    peopleBtn: document.getElementById("peopleBtn"),

    sheetBackdrop: document.getElementById("sheetBackdrop"),
    peopleSheet: document.getElementById("peopleSheet"),
    peopleList: document.getElementById("peopleList"),
    onlineCount: document.getElementById("onlineCount"),

    msgTemplate: document.getElementById("msgTemplate"),
    systemMsgTemplate: document.getElementById("systemMsgTemplate"),
    personTemplate: document.getElementById("personTemplate"),
  };

  const AVATAR_GRADIENTS = [
    ["#ff7a59", "#ff4d94"],
    ["#2dd4bf", "#3b82f6"],
    ["#a78bfa", "#ec4899"],
    ["#fbbf24", "#f97316"],
    ["#34d399", "#22d3ee"],
    ["#f472b6", "#a855f7"],
  ];

  let authMode = "login";
  let currentUser = null;
  let socket = null;
  let typingTimeout = null;
  let othersTyping = new Set();

  init();

  async function init() {
    bindAuthEvents();
    bindChatEvents();

    try {
      const res = await fetch("/api/me");
      const data = await res.json();
      if (data.username) {
        enterChat(data.username);
      }
    } catch {
      /* stay on auth view */
    }
  }

  // -------------------------------------------------------------------
  // Auth view
  // -------------------------------------------------------------------
  function bindAuthEvents() {
    els.authTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        authMode = tab.dataset.mode;
        els.authTabs.forEach((t) => t.classList.toggle("is-active", t === tab));
        els.authSubmit.textContent = authMode === "login" ? "Log in" : "Create account";
        els.authError.textContent = "";
      });
    });

    els.authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      els.authError.textContent = "";
      els.authSubmit.disabled = true;

      const username = els.usernameInput.value.trim();
      const password = els.passwordInput.value;
      const endpoint = authMode === "login" ? "/api/login" : "/api/register";

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Something went wrong.");
        enterChat(data.username);
      } catch (err) {
        els.authError.textContent = err.message;
      } finally {
        els.authSubmit.disabled = false;
      }
    });
  }

  function enterChat(username) {
    currentUser = username;
    els.authView.classList.add("hidden");
    els.chatView.classList.remove("hidden");
    connectSocket();
  }

  // -------------------------------------------------------------------
  // Socket.IO
  // -------------------------------------------------------------------
  function connectSocket() {
    socket = io({ withCredentials: true });

    socket.on("connect", () => {
      socket.emit("join");
      setPresence(true, "online");
    });

    socket.on("disconnect", () => setPresence(false, "reconnecting…"));

    socket.on("auth_error", () => {
      window.location.reload();
    });

    socket.on("history", ({ messages }) => {
      els.thread.innerHTML = "";
      messages.forEach(renderMessage);
      scrollToBottom(false);
    });

    socket.on("new_message", (msg) => {
      renderMessage(msg);
      scrollToBottom();
    });

    socket.on("system_message", (msg) => {
      renderSystemMessage(msg.text);
      scrollToBottom();
    });

    socket.on("presence", ({ online_users, count }) => {
      setPresence(true, `${count} online`);
      renderPeopleList(online_users);
    });

    socket.on("typing", ({ username }) => {
      if (username === currentUser) return;
      othersTyping.add(username);
      renderTypingStrip();
    });

    socket.on("stop_typing", ({ username }) => {
      othersTyping.delete(username);
      renderTypingStrip();
    });
  }

  function setPresence(live, text) {
    els.presenceLabel.classList.toggle("is-live", live);
    els.presenceLabel.innerHTML = `<i class="dot"></i> ${escapeHtml(text)}`;
  }

  // -------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------
  function bindChatEvents() {
    els.input.addEventListener("input", () => {
      autoresize();
      els.sendBtn.disabled = els.input.value.trim().length === 0;
      notifyTyping();
    });

    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    els.sendBtn.addEventListener("click", sendMessage);

    els.logoutBtn.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      if (socket) socket.disconnect();
      window.location.reload();
    });

    els.peopleBtn.addEventListener("click", () => togglePeopleSheet(true));
    els.sheetBackdrop.addEventListener("click", () => togglePeopleSheet(false));
  }

  function sendMessage() {
    const text = els.input.value.trim();
    if (!text || !socket) return;
    socket.emit("send_message", { text });
    socket.emit("stop_typing");
    clearTimeout(typingTimeout);
    els.input.value = "";
    autoresize();
    els.sendBtn.disabled = true;
  }

  function notifyTyping() {
    if (!socket) return;
    socket.emit("typing");
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => socket.emit("stop_typing"), 1200);
  }

  function autoresize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 120) + "px";
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------
  function renderMessage(msg) {
    const isOwn = msg.sender === currentUser;
    const node = els.msgTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("own", isOwn);

    const avatar = node.querySelector(".msg__avatar");
    avatar.textContent = initials(msg.sender);
    avatar.style.background = avatarGradient(msg.sender);

    node.querySelector(".msg__name").textContent = msg.sender;
    node.querySelector(".msg__bubble").innerHTML = escapeHtml(msg.text);
    node.querySelector(".msg__time").textContent = formatTime(msg.created_at);

    els.thread.appendChild(node);
  }

  function renderSystemMessage(text) {
    const node = els.systemMsgTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector("span").textContent = text;
    els.thread.appendChild(node);
  }

  function renderTypingStrip() {
    if (othersTyping.size === 0) {
      els.typingStrip.classList.add("hidden");
      els.typingStrip.innerHTML = "";
      return;
    }
    const names = Array.from(othersTyping);
    const label =
      names.length === 1
        ? `${names[0]} is typing`
        : `${names.slice(0, 2).join(", ")}${names.length > 2 ? " and others" : ""} are typing`;

    els.typingStrip.innerHTML = `${escapeHtml(label)} <span class="dots"><span></span><span></span><span></span></span>`;
    els.typingStrip.classList.remove("hidden");
  }

  function renderPeopleList(usernames) {
    els.onlineCount.textContent = usernames.length;
    els.peopleList.innerHTML = "";
    usernames.forEach((name) => {
      const node = els.personTemplate.content.firstElementChild.cloneNode(true);
      const avatar = node.querySelector(".person__avatar");
      avatar.textContent = initials(name);
      avatar.style.background = avatarGradient(name);
      node.querySelector(".person__name").textContent =
        name === currentUser ? `${name} (you)` : name;
      els.peopleList.appendChild(node);
    });
  }

  function togglePeopleSheet(show) {
    els.sheetBackdrop.classList.toggle("hidden", !show);
    els.peopleSheet.classList.toggle("hidden", !show);
    requestAnimationFrame(() => {
      els.sheetBackdrop.classList.toggle("is-visible", show);
      els.peopleSheet.classList.toggle("is-visible", show);
    });
  }

  function scrollToBottom(smooth = true) {
    requestAnimationFrame(() => {
      els.thread.scrollTo({ top: els.thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    });
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function initials(name) {
    return name.slice(0, 2).toUpperCase();
  }

  function avatarGradient(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const [a, b] = AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
    return `linear-gradient(135deg, ${a}, ${b})`;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
})();
