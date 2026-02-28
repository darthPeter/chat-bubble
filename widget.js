(function () {
  "use strict";

  // ── Read config from <script> data attributes ──────────────────────
  const scriptTag = document.currentScript;
  const CFG = {
    webhook: scriptTag.getAttribute("data-webhook") || "",
    color: scriptTag.getAttribute("data-color") || "#2C3E50",
    title: scriptTag.getAttribute("data-title") || "Chat",
    logo: scriptTag.getAttribute("data-logo") || "",
  };

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

  // ── State ──────────────────────────────────────────────────────────
  let twilioClient = null;
  let activeConversation = null;
  let identity = "user_" + crypto.randomUUID();
  let isOpen = false;

  // ── Shadow DOM host ────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "chat-bubble-host";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  // ── Styles ─────────────────────────────────────────────────────────
  const styles = document.createElement("style");
  styles.textContent = /* css */ `
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}

    /* ── Floating button ─────────────────────────────────── */
    .cb-btn{
      position:fixed;bottom:24px;right:24px;z-index:2147483646;
      width:60px;height:60px;border-radius:50%;border:none;
      background:${CFG.color};color:#fff;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 12px rgba(0,0,0,.25);
      transition:transform .2s,box-shadow .2s;
    }
    .cb-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.3)}
    .cb-btn svg{width:28px;height:28px;transition:transform .2s}
    .cb-btn.open svg{transform:rotate(90deg)}

    /* ── Chat window ─────────────────────────────────────── */
    .cb-window{
      position:fixed;bottom:100px;right:24px;z-index:2147483646;
      width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);
      border-radius:16px;overflow:hidden;
      display:flex;flex-direction:column;
      background:#fff;
      box-shadow:0 8px 30px rgba(0,0,0,.18);
      opacity:0;transform:translateY(16px) scale(.96);
      transition:opacity .25s ease,transform .25s ease;
      pointer-events:none;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    }
    .cb-window.visible{
      opacity:1;transform:translateY(0) scale(1);pointer-events:auto;
    }

    /* ── Header ──────────────────────────────────────────── */
    .cb-header{
      display:flex;align-items:center;gap:10px;
      padding:14px 16px;
      background:${CFG.color};color:#fff;
      flex-shrink:0;
    }
    .cb-header-avatar{
      width:36px;height:36px;border-radius:50%;object-fit:cover;
      background:rgba(255,255,255,.2);flex-shrink:0;
    }
    .cb-header-title{font-size:15px;font-weight:600;flex:1}
    .cb-header-status{font-size:11px;opacity:.8;margin-top:2px}
    .cb-close{
      background:none;border:none;color:#fff;cursor:pointer;
      padding:4px;border-radius:6px;display:flex;
    }
    .cb-close:hover{background:rgba(255,255,255,.15)}
    .cb-close svg{width:20px;height:20px}

    /* ── Messages ─────────────────────────────────────────── */
    .cb-messages{
      flex:1;overflow-y:auto;padding:16px;
      display:flex;flex-direction:column;gap:8px;
      background:#f7f8fa;
    }
    .cb-msg{
      max-width:80%;padding:10px 14px;border-radius:14px;
      font-size:14px;line-height:1.45;word-wrap:break-word;
    }
    .cb-msg.bot{
      align-self:flex-start;background:#fff;color:#1a1a1a;
      border:1px solid #e5e7eb;border-bottom-left-radius:4px;
    }
    .cb-msg.user{
      align-self:flex-end;background:${CFG.color};color:#fff;
      border-bottom-right-radius:4px;
    }

    /* ── Typing indicator ────────────────────────────────── */
    .cb-typing{
      align-self:flex-start;padding:10px 14px;
      background:#fff;border:1px solid #e5e7eb;border-radius:14px;
      border-bottom-left-radius:4px;display:none;
    }
    .cb-typing.active{display:flex;gap:4px;align-items:center}
    .cb-typing-dot{
      width:7px;height:7px;border-radius:50%;background:#aaa;
      animation:cb-blink 1.4s infinite both;
    }
    .cb-typing-dot:nth-child(2){animation-delay:.2s}
    .cb-typing-dot:nth-child(3){animation-delay:.4s}
    @keyframes cb-blink{0%,80%,100%{opacity:.3}40%{opacity:1}}

    /* ── Input area ──────────────────────────────────────── */
    .cb-input-area{
      display:flex;align-items:center;gap:8px;
      padding:12px 14px;border-top:1px solid #e5e7eb;
      background:#fff;flex-shrink:0;
    }
    .cb-input{
      flex:1;border:1px solid #ddd;border-radius:20px;
      padding:10px 16px;font-size:14px;outline:none;resize:none;
      font-family:inherit;line-height:1.4;max-height:100px;
    }
    .cb-input:focus{border-color:${CFG.color}}
    .cb-send{
      width:38px;height:38px;border-radius:50%;border:none;
      background:${CFG.color};color:#fff;cursor:pointer;
      display:flex;align-items:center;justify-content:center;flex-shrink:0;
      transition:opacity .15s;
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
      .cb-btn{bottom:16px;right:16px;width:54px;height:54px}
    }
  `;
  shadow.appendChild(styles);

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
        <div>
          <div class="cb-header-title">${CFG.title}</div>
          <div class="cb-header-status">Online</div>
        </div>
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
  const messagesEl = shadow.querySelector(".cb-messages");
  const typingEl = shadow.querySelector(".cb-typing");
  const inputEl = shadow.querySelector(".cb-input");
  const btnSend = shadow.querySelector(".cb-send");
  const statusBanner = shadow.querySelector(".cb-status-banner");
  const headerStatus = shadow.querySelector(".cb-header-status");

  // ── UI helpers ─────────────────────────────────────────────────────
  function toggleChat() {
    isOpen = !isOpen;
    chatWindow.classList.toggle("visible", isOpen);
    btnToggle.classList.toggle("open", isOpen);
    if (isOpen) {
      inputEl.focus();
      if (!twilioClient) connectTwilio();
    }
  }

  function appendMessage(text, sender) {
    const el = document.createElement("div");
    el.className = `cb-msg ${sender}`;
    el.textContent = text;
    messagesEl.insertBefore(el, typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping(on) {
    typingEl.classList.toggle("active", on);
    if (on) messagesEl.scrollTop = messagesEl.scrollHeight;
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
    } catch (err) {
      console.error("[ChatBubble] Send failed:", err);
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
      // 1. Fetch token from n8n endpoint
      const resp = await fetch(CFG.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity }),
      });

      if (!resp.ok) throw new Error(`Token request failed (${resp.status})`);
      const data = await resp.json();
      const { token, conversation_sid } = data;

      if (!token || !conversation_sid) {
        throw new Error("Invalid token response");
      }

      // 2. Load Twilio SDK and init client
      const TwilioConversations = await loadTwilioSDK();
      twilioClient = await TwilioConversations.Client.create(token);

      // 3. Join conversation
      try {
        activeConversation =
          await twilioClient.getConversationBySid(conversation_sid);
      } catch {
        activeConversation =
          await twilioClient.getConversationBySid(conversation_sid);
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
            body: JSON.stringify({ identity, refresh: true }),
          });
          const d = await r.json();
          await twilioClient.updateToken(d.token);
        } catch (err) {
          console.error("[ChatBubble] Token refresh failed:", err);
        }
      });

      setStatus("");
      setHeaderStatus("Online");
    } catch (err) {
      console.error("[ChatBubble] Connection error:", err);
      setHeaderStatus("Offline");
      setStatus("Could not connect to chat. Please try again later.", "error");
      twilioClient = null;
      activeConversation = null;
    }
  }

  // ── Event listeners ────────────────────────────────────────────────
  btnToggle.addEventListener("click", toggleChat);
  btnClose.addEventListener("click", toggleChat);

  btnSend.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
})();
