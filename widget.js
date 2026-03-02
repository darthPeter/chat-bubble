(function () {
  "use strict";

  // ── Read config from <script> data attributes ──────────────────────
  const scriptTag = document.currentScript;
  const CFG = {
    webhook: scriptTag.getAttribute("data-webhook") || "",
    color: scriptTag.getAttribute("data-color") || "",
    title: scriptTag.getAttribute("data-title") || "Chat",
    logo: scriptTag.getAttribute("data-logo") || "",
    clientKey: scriptTag.getAttribute("data-client-key") || "",
    theme: scriptTag.getAttribute("data-theme") || "",
  };

  // ── Compute base URL for loading theme files ─────────────────────
  const baseURL = scriptTag.src
    ? scriptTag.src.substring(0, scriptTag.src.lastIndexOf("/"))
    : ".";

  // ── Twilio SDK loader ──────────────────────────────────────────────
  const TWILIO_SDK_URL =
    "https://media.twiliocdn.com/sdk/js/conversations/v2.1/twilio-conversations.min.js";

  function loadTwilioSDK() {
    return new Promise((resolve, reject) => {
      if (window.Twilio && window.Twilio.Conversations) {
        return resolve(window.Twilio.Conversations);
      }
      const s = document.createElement("script");
      s.src = TWILIO_SDK_URL;
      s.onload = () => resolve(window.Twilio.Conversations);
      s.onerror = () => reject(new Error("Failed to load Twilio SDK"));
      document.head.appendChild(s);
    });
  }

  // ── Session persistence ────────────────────────────────────────────
  const SESSION_KEY = "cb_session";

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function saveSession(id, convSid) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ identity: id, conversation_sid: convSid }));
    } catch {}
  }

  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  }

  // ── State ──────────────────────────────────────────────────────────
  let twilioClient = null;
  let activeConversation = null;
  const saved = loadSession();
  let identity = saved?.identity || "user_" + crypto.randomUUID();
  let isOpen = false;

  // ── Shadow DOM host ────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "chat-bubble-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  // ── Structural styles (layout, positioning, transitions) ──────────
  const styles = document.createElement("style");
  styles.textContent = /* css */ `
    :host {
      /* Fallback values — used when no theme is loaded */
      --cb-color-primary: #2C3E50;
      --cb-color-primary-hover: #243342;
      --cb-color-on-primary: #fff;
      --cb-color-surface: #fff;
      --cb-color-surface-alt: #f7f8fa;
      --cb-color-border: #e5e7eb;
      --cb-color-text: #1a1a1a;
      --cb-color-text-secondary: #666;
      --cb-btn-size: 60px;
      --cb-btn-size-mobile: 54px;
      --cb-btn-radius: 50%;
      --cb-btn-shadow: 0 4px 12px rgba(0,0,0,.25);
      --cb-btn-shadow-hover: 0 6px 20px rgba(0,0,0,.3);
      --cb-window-radius: 16px;
      --cb-window-shadow: 0 8px 30px rgba(0,0,0,.18);
      --cb-window-width: 380px;
      --cb-window-height: 520px;
      --cb-header-bg: var(--cb-color-primary);
      --cb-header-color: #fff;
      --cb-header-padding: 14px 16px;
      --cb-msg-radius: 14px;
      --cb-msg-bot-bg: #fff;
      --cb-msg-bot-color: var(--cb-color-text);
      --cb-msg-bot-border: 1px solid var(--cb-color-border);
      --cb-msg-user-bg: var(--cb-color-primary);
      --cb-msg-user-color: #fff;
      --cb-input-radius: 20px;
      --cb-input-border: #ddd;
      --cb-input-focus-border: var(--cb-color-primary);
      --cb-send-bg: var(--cb-color-primary);
      --cb-send-color: #fff;
      --cb-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --cb-font-size: 14px;
    }

    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}

    /* ── Floating button ─────────────────────────────────── */
    .cb-btn{
      position:fixed;bottom:24px;right:24px;z-index:2147483646;
      width:var(--cb-btn-size);height:var(--cb-btn-size);
      border-radius:var(--cb-btn-radius);border:none;
      background:var(--cb-color-primary);color:var(--cb-color-on-primary);
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      box-shadow:var(--cb-btn-shadow);
      transition:transform .2s,box-shadow .2s;
    }
    .cb-btn:hover{transform:scale(1.08);box-shadow:var(--cb-btn-shadow-hover)}
    .cb-btn svg{width:28px;height:28px;transition:transform .2s}
    .cb-btn.open svg{transform:rotate(90deg)}

    /* ── Chat window ─────────────────────────────────────── */
    .cb-window{
      position:fixed;bottom:100px;right:24px;z-index:2147483646;
      width:var(--cb-window-width);max-width:calc(100vw - 32px);
      height:var(--cb-window-height);max-height:calc(100vh - 120px);
      border-radius:var(--cb-window-radius);overflow:hidden;
      display:flex;flex-direction:column;
      background:var(--cb-color-surface);
      box-shadow:var(--cb-window-shadow);
      opacity:0;transform:translateY(16px) scale(.96);
      transition:opacity .25s ease,transform .25s ease;
      pointer-events:none;
      font-family:var(--cb-font-family);
      font-size:var(--cb-font-size);
    }
    .cb-window.visible{
      opacity:1;transform:translateY(0) scale(1);pointer-events:auto;
    }

    /* ── Header ──────────────────────────────────────────── */
    .cb-header{
      display:flex;align-items:flex-start;gap:10px;
      padding:var(--cb-header-padding);
      background:var(--cb-header-bg);color:var(--cb-header-color);
      flex-shrink:0;
    }
    .cb-header-avatar{
      width:36px;height:36px;border-radius:50%;object-fit:cover;
      background:rgba(255,255,255,.2);flex-shrink:0;
    }
    .cb-header-info{flex:1;min-width:0}
    .cb-header-title{font-size:15px;font-weight:600}
    .cb-header-status{font-size:11px;opacity:.8;margin-top:2px}
    .cb-new,.cb-close{
      background:none;border:none;color:inherit;cursor:pointer;
      padding:4px;border-radius:6px;display:flex;align-self:flex-start;
    }
    .cb-new:hover,.cb-close:hover{background:rgba(255,255,255,.15)}
    .cb-new svg{width:16px;height:16px;opacity:.7}
    .cb-new:hover svg{opacity:1}
    .cb-close svg{width:20px;height:20px}

    /* ── Messages ─────────────────────────────────────────── */
    .cb-messages{
      flex:1;overflow-y:auto;padding:16px;
      display:flex;flex-direction:column;gap:8px;
      background:var(--cb-color-surface-alt);
    }
    .cb-msg{
      max-width:80%;padding:10px 14px;
      border-radius:var(--cb-msg-radius);
      font-size:var(--cb-font-size);line-height:1.45;word-wrap:break-word;
      animation:cb-msgIn .3s ease-out both;
    }
    @keyframes cb-msgIn{
      from{opacity:0;transform:translateY(12px)}
      to{opacity:1;transform:translateY(0)}
    }
    .cb-msg.bot{
      align-self:flex-start;
      background:var(--cb-msg-bot-bg);color:var(--cb-msg-bot-color);
      border:var(--cb-msg-bot-border);border-bottom-left-radius:4px;
    }
    .cb-msg.bot strong{font-weight:600}
    .cb-msg.bot em{font-style:italic}
    .cb-msg.user{
      align-self:flex-end;
      background:var(--cb-msg-user-bg);color:var(--cb-msg-user-color);
      border-bottom-right-radius:4px;
    }

    /* ── Typing indicator ────────────────────────────────── */
    .cb-typing{
      align-self:flex-start;padding:10px 14px;
      background:var(--cb-msg-bot-bg);border:var(--cb-msg-bot-border);
      border-radius:var(--cb-msg-radius);border-bottom-left-radius:4px;
      display:none;
      opacity:0;transition:opacity .3s ease-out;
    }
    .cb-typing.active{display:flex;gap:5px;align-items:center;opacity:1}
    .cb-typing-dot{
      width:8px;height:8px;border-radius:50%;background:#999;
      animation:cb-bounce 1.4s infinite ease-in-out;
    }
    .cb-typing-dot:nth-child(2){animation-delay:.2s}
    .cb-typing-dot:nth-child(3){animation-delay:.4s}
    @keyframes cb-bounce{
      0%,80%,100%{opacity:.3;transform:translateY(0)}
      40%{opacity:1;transform:translateY(-4px)}
    }

    /* ── Input area ──────────────────────────────────────── */
    .cb-input-area{
      display:flex;align-items:center;gap:8px;
      padding:12px 14px;border-top:1px solid var(--cb-color-border);
      background:var(--cb-color-surface);flex-shrink:0;
    }
    .cb-input{
      flex:1;border:1px solid var(--cb-input-border);
      border-radius:var(--cb-input-radius);
      padding:10px 16px;font-size:var(--cb-font-size);outline:none;resize:none;
      font-family:inherit;line-height:1.4;max-height:100px;
      color:var(--cb-color-text);
    }
    .cb-input:focus{border-color:var(--cb-input-focus-border)}
    .cb-send{
      width:38px;height:38px;border-radius:50%;border:none;
      background:var(--cb-send-bg);color:var(--cb-send-color);
      cursor:pointer;display:flex;align-items:center;justify-content:center;
      flex-shrink:0;transition:opacity .15s;
    }
    .cb-send:disabled{opacity:.4;cursor:default}
    .cb-send svg{width:18px;height:18px}

    /* ── Connection banner ────────────────────────────────── */
    .cb-status-banner{
      padding:8px 16px;font-size:12px;text-align:center;
      background:#fef3c7;color:#92400e;display:none;flex-shrink:0;
    }
    .cb-status-banner.error{background:#fee2e2;color:#991b1b}
    .cb-status-banner.visible{display:block}

    /* ── Scrollbar ────────────────────────────────────────── */
    .cb-messages::-webkit-scrollbar{width:6px}
    .cb-messages::-webkit-scrollbar-track{background:transparent}
    .cb-messages::-webkit-scrollbar-thumb{background:#ccc;border-radius:3px}

    /* ── Mobile ───────────────────────────────────────────── */
    @media(max-width:480px){
      .cb-window{
        bottom:0;right:0;left:0;
        width:100%;max-width:100%;height:100%;max-height:100%;
        border-radius:0;
      }
      .cb-btn{bottom:16px;right:16px;
        width:var(--cb-btn-size-mobile);height:var(--cb-btn-size-mobile);
      }
    }
  `;
  shadow.appendChild(styles);

  // ── Theme loader ──────────────────────────────────────────────────
  function loadTheme(themeName) {
    if (!themeName) return;
    const url = baseURL + "/themes/" + themeName + ".css";
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Theme not found: " + themeName);
        return r.text();
      })
      .then((css) => {
        // Extract font URL from comment: /* @font-url: <url> */
        const fontMatch = css.match(/@font-url:\s*(.+)\s*\*/);
        if (fontMatch && fontMatch[1].trim() !== "none") {
          const fontURL = fontMatch[1].trim();
          if (!document.querySelector(`link[href="${fontURL}"]`)) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = fontURL;
            document.head.appendChild(link);
          }
        }
        // Inject theme CSS into shadow DOM (after structural styles)
        const themeStyle = document.createElement("style");
        themeStyle.textContent = css;
        shadow.insertBefore(themeStyle, styles.nextSibling);
      })
      .catch((err) => {
        console.warn("[ChatBubble] " + err.message);
      });
  }

  // ── Apply data-color override (highest priority) ──────────────────
  if (CFG.color) {
    const colorOverride = document.createElement("style");
    colorOverride.textContent = `:host {
      --cb-color-primary: ${CFG.color};
      --cb-header-bg: ${CFG.color};
      --cb-msg-user-bg: ${CFG.color};
      --cb-send-bg: ${CFG.color};
      --cb-input-focus-border: ${CFG.color};
    }`;
    shadow.appendChild(colorOverride);
  }

  // Load theme (inserted between structural and color override)
  loadTheme(CFG.theme);

  // ── HTML structure ─────────────────────────────────────────────────
  const container = document.createElement("div");
  container.innerHTML = `
    <!-- Floating button -->
    <button class="cb-btn" aria-label="Open chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </button>

    <!-- Chat window -->
    <div class="cb-window">
      <div class="cb-header">
        ${CFG.logo ? `<img class="cb-header-avatar" src="${CFG.logo}" alt="">` : ""}
        <div class="cb-header-info">
          <div class="cb-header-title">${CFG.title}</div>
          <div class="cb-header-status">Online</div>
        </div>
        <button class="cb-new" aria-label="New conversation" title="New conversation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
        </button>
        <button class="cb-close" aria-label="Close chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="cb-status-banner"></div>

      <div class="cb-messages">
        <div class="cb-typing">
          <span class="cb-typing-dot"></span>
          <span class="cb-typing-dot"></span>
          <span class="cb-typing-dot"></span>
        </div>
      </div>

      <div class="cb-input-area">
        <textarea class="cb-input" rows="1" placeholder="Type a message..."></textarea>
        <button class="cb-send" disabled aria-label="Send message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  shadow.appendChild(container);

  // ── DOM refs ───────────────────────────────────────────────────────
  const btnToggle = shadow.querySelector(".cb-btn");
  const chatWindow = shadow.querySelector(".cb-window");
  const btnClose = shadow.querySelector(".cb-close");
  const btnNew = shadow.querySelector(".cb-new");
  const messagesEl = shadow.querySelector(".cb-messages");
  const typingEl = shadow.querySelector(".cb-typing");
  const inputEl = shadow.querySelector(".cb-input");
  const btnSend = shadow.querySelector(".cb-send");
  const statusBanner = shadow.querySelector(".cb-status-banner");
  const headerStatus = shadow.querySelector(".cb-header-status");

  // ── Scroll helpers ──────────────────────────────────────────────────
  function isNearBottom(threshold = 100) {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
  }

  function scrollToBottom(behavior = "smooth") {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior });
  }

  // ── UI helpers ─────────────────────────────────────────────────────
  function toggleChat() {
    isOpen = !isOpen;
    chatWindow.classList.toggle("visible", isOpen);
    btnToggle.classList.toggle("open", isOpen);
    if (isOpen) {
      inputEl.focus();
      if (!twilioClient) connectTwilio();
      else scrollToBottom("instant");
    }
  }

  // ── Lightweight markdown for bot messages ───────────────────────────
  function formatBotMessage(text) {
    // Escape HTML to prevent XSS
    const esc = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return esc
      // Bold: **text** or __text__
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      // Italic: *text* or _text_ (but not inside words)
      .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<em>$1</em>")
      .replace(/(?<!\w)_(.+?)_(?!\w)/g, "<em>$1</em>")
      // Newlines to <br>
      .replace(/\n/g, "<br>");
  }

  function appendMessage(text, sender) {
    const el = document.createElement("div");
    el.className = `cb-msg ${sender}`;
    if (sender === "bot") {
      el.innerHTML = formatBotMessage(text);
    } else {
      el.textContent = text;
    }
    messagesEl.insertBefore(el, typingEl);
    // Always scroll for own messages; only scroll for bot if user is near bottom
    if (sender === "user" || isNearBottom()) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }

  function showTyping(on) {
    typingEl.classList.toggle("active", on);
    if (on && isNearBottom()) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }

  function setStatus(text, type) {
    if (!text) {
      statusBanner.classList.remove("visible");
      return;
    }
    statusBanner.textContent = text;
    statusBanner.className = `cb-status-banner visible ${type || ""}`;
  }

  function setHeaderStatus(text) {
    headerStatus.textContent = text;
  }

  // ── Auto-resize textarea ──────────────────────────────────────────
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + "px";
    btnSend.disabled = !inputEl.value.trim();
  });

  // ── Send message ──────────────────────────────────────────────────
  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || !activeConversation) return;

    appendMessage(text, "user");
    inputEl.value = "";
    inputEl.style.height = "auto";
    btnSend.disabled = true;

    try {
      await activeConversation.sendMessage(text);
      // Show typing indicator while waiting for bot reply
      showTyping(true);
    } catch (err) {
      console.error("[ChatBubble] Send failed:", err);
      showTyping(false);
      setStatus("Failed to send message. Please try again.", "error");
    }
  }

  // ── Twilio connection ─────────────────────────────────────────────
  async function connectTwilio() {
    if (!CFG.webhook) {
      setStatus("Chat is not configured (missing webhook).", "error");
      return;
    }

    setHeaderStatus("Connecting...");
    setStatus("Connecting to chat...");

    try {
      // 1. Fetch token — reuse existing session or create new
      const existingSession = loadSession();
      const isRestore = !!(existingSession?.conversation_sid);
      const reqBody = {
        identity,
        client_key: CFG.clientKey || undefined,
      };
      if (isRestore) {
        reqBody.refresh = true;
        reqBody.conversation_sid = existingSession.conversation_sid;
      }

      const resp = await fetch(CFG.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => null);
        // If restore fails (conversation expired), start fresh
        if (isRestore) {
          clearSession();
          identity = "user_" + crypto.randomUUID();
          return connectTwilio();
        }
        throw new Error(errData?.error || `Token request failed (${resp.status})`);
      }
      const data = await resp.json();
      const { token, conversation_sid } = data;

      if (!token || !conversation_sid) {
        throw new Error("Invalid token response");
      }

      // Save session for persistence across refreshes
      saveSession(identity, conversation_sid);

      // 2. Load Twilio SDK and init client
      const TwilioConversations = await loadTwilioSDK();
      const clientOpts = {};
      if (data.region) clientOpts.region = data.region;
      twilioClient = await TwilioConversations.Client.create(token, clientOpts);

      // 3. Join conversation
      try {
        activeConversation =
          await twilioClient.getConversationBySid(conversation_sid);
      } catch {
        activeConversation =
          await twilioClient.getConversationBySid(conversation_sid);
      }

      // 3b. Restore previous messages if resuming session
      if (isRestore) {
        try {
          const paginator = await activeConversation.getMessages(50);
          paginator.items.forEach((msg) => {
            if (msg.body && msg.body !== "[system] generate welcome message") {
              appendMessage(msg.body, msg.author === identity ? "user" : "bot");
            }
          });
          scrollToBottom("instant");
        } catch (e) {
          console.warn("[ChatBubble] Could not load history:", e);
        }
      }

      // 4. Listen for incoming messages
      activeConversation.on("messageAdded", (msg) => {
        // Only render messages from others (bot)
        if (msg.author !== identity) {
          showTyping(false);
          appendMessage(msg.body, "bot");
        }
      });

      // 5. Typing indicator
      activeConversation.on("typingStarted", (participant) => {
        if (participant.identity !== identity) showTyping(true);
      });
      activeConversation.on("typingEnded", (participant) => {
        if (participant.identity !== identity) showTyping(false);
      });

      // 6. Client connection state
      twilioClient.on("connectionStateChanged", (state) => {
        switch (state) {
          case "connected":
            setStatus("");
            setHeaderStatus("Online");
            break;
          case "connecting":
            setHeaderStatus("Connecting...");
            break;
          case "disconnecting":
          case "disconnected":
            setHeaderStatus("Offline");
            setStatus("Connection lost. Trying to reconnect...");
            break;
          case "denied":
            setHeaderStatus("Offline");
            setStatus("Connection denied. Please reload.", "error");
            break;
        }
      });

      // 7. Token expiry — refresh before it expires
      twilioClient.on("tokenAboutToExpire", async () => {
        try {
          const r = await fetch(CFG.webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identity, refresh: true, conversation_sid, client_key: CFG.clientKey || undefined }),
          });
          const d = await r.json();
          await twilioClient.updateToken(d.token);
        } catch (err) {
          console.error("[ChatBubble] Token refresh failed:", err);
        }
      });

      setStatus("");
      setHeaderStatus("Online");

      // 8. Trigger welcome message from AI (new conversations only)
      if (!isRestore) {
        try {
          showTyping(true);
          await activeConversation.sendMessage("[system] generate welcome message");
        } catch (e) {
          console.warn("[ChatBubble] Welcome message failed:", e);
          showTyping(false);
        }
      }
    } catch (err) {
      console.error("[ChatBubble] Connection error:", err);
      setHeaderStatus("Offline");
      setStatus(`Error: ${err.message || err}`, "error");
      twilioClient = null;
      activeConversation = null;
    }
  }

  // ── New conversation ─────────────────────────────────────────────
  async function newConversation() {
    clearSession();
    identity = "user_" + crypto.randomUUID();
    if (twilioClient) {
      try { await twilioClient.shutdown(); } catch {}
    }
    twilioClient = null;
    activeConversation = null;
    // Clear messages
    messagesEl.querySelectorAll(".cb-msg").forEach((el) => el.remove());
    showTyping(false);
    setStatus("");
    connectTwilio();
  }

  // ── Event listeners ────────────────────────────────────────────────
  btnToggle.addEventListener("click", toggleChat);
  btnClose.addEventListener("click", toggleChat);
  btnNew.addEventListener("click", newConversation);

  btnSend.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
})();
