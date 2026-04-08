# Changelog — Chat Bubble Widget

## 2026-04-08 — Streaming text reveal + Pompo brain v1.5

### Widget (widget.js)
- Bot text messages now reveal word by word (~25ms/word) with auto-scroll following along
- Streaming designed as async generator pattern — ready to swap simulated streaming for real SSE/WebSocket token streaming from AI brain
- `appendMessage` now accepts `{ stream: true }` option: live messages stream, history restore is instant
- If new message arrives during streaming, current stream finishes instantly
- Product cards still appear instantly (no streaming for visual elements)

### Message Handler (n8n)
- Pompo routing updated to new AI brain: `Pompo-RAG-Agent-v1.5` (workflow `UxPTfMBoz5EHrTdt`)

---

## 2026-04-07 — Product cards for e-commerce

### Widget (widget.js)
- Rich product cards rendered when AI bot uses `[product]...[/product]` format in responses
- Fields: `name` (required), `price`, `image`, `url`, `button` — missing fields gracefully omitted
- `button` field: optional label for the CTA button (default "View ›"). Enables i18n — Czech bots use `button: Zobrazit`, etc.
- Cards styled with existing `--cb-*` CSS custom properties — automatically matches each client's theme
- Image with `onerror` fallback, button opens product URL in new tab
- Fully backwards compatible: no `[product]` markers = zero behavior change
- Fool-proof: broken format falls back to plain text, XSS-safe (all values HTML-escaped)
- Supports interleaved text and product cards in the same message

---

## 2026-04-06 — Auto-open feature

### Widget (widget.js)
- New `data-auto-open` attribute: when present, widget automatically opens after a delay (default 2s)
- New `data-auto-open-delay` attribute: configurable delay in milliseconds
- Dismissed state persisted in `localStorage` (`cb_dismissed_{clientId}`) — once user closes the chat, auto-open never triggers again
- Backwards compatible: existing clients without `data-auto-open` see zero behavior change
- Edge cases handled: user opens before timer (skipped), user clicks bubble before timer (cancelled), localStorage unavailable (graceful fallback)

### Pompo demo (demo-pompo.html)
- Enabled `data-auto-open` — chat opens automatically after 2s on the demo page

---

## 2026-04-05 — New client: Pompo.cz

### New client onboarded: Pompo.cz (client_id: `pompo`)
Czech toy e-commerce site (hračky online). Third client on the platform.

### New files
- `themes/pompo.css` — Pompo brand theme: red primary (#e63946), blue accent (#457b9d), clean sans-serif, gradient header
- `demo-pompo.html` — test page with pompo.cz in iframe background + chat widget

### Token Endpoint (`ODrNXQASOPNObSWd`)
- Added `pompo` to `CLIENTS` config table with unique client key

### Message Handler (`wnHbfZ7Djko2G4HZ`)
- Added `pompo` to `ROUTING` config table → AI webhook: `/webhook/f305ec84-10a9-49c9-a0dc-edc58b4818db`
- Auth: shared `GlobalChatbot` credential (same as all clients)

### Documentation
- Updated `CLAUDE.md` — Active Clients table, files list, redacted placeholders
- Updated `CHAT_BUBBLE_PLAN.md` — TODO checklist
- Updated workflow backups in `workflows/`

### Embed tag
```html
<script
  src="https://darthpeter.github.io/chat-bubble/widget.js"
  data-webhook="https://n8n.srv1104100.hstgr.cloud/webhook/chat-token"
  data-theme="pompo"
  data-title="Pompo.cz"
  data-logo="https://data.pompo.cz/templates/images/logo.svg"
  data-client-key="cb5b910b75f235a374b6f9b1b4956790593aef05c8d5f5c9"
  data-client-id="pompo"
></script>
```

---

## 2026-03-15 — Fix alkohol.cz mobile fullscreen

### Theme (themes/alkoholcz.css)
- Fixed chat window not going fullscreen on mobile — theme's `bottom: 84px !important` was overriding widget.js mobile `bottom: 0`
- Added mobile `@media(max-width:480px)` in theme to reset `.cb-window` and `.cb-btn` to proper fullscreen positions

---

## 2026-03-15 — Agent dashboard + token endpoint (live agent handoff — steps 1-2/5)

### New file: agent.html
- **Agent dashboard** for live agent handoff — single vanilla JS file, no build step, hosted on GitHub Pages
- **Login screen** — username/password form, POSTs to Agent Token Endpoint (to be built in step 2)
- **Conversation list** — sidebar with real-time updates via `conversationAdded`/`conversationRemoved` events, sorted by latest message, unread badges, client_id labels
- **Chat view** — loads last 50 messages, real-time `messageAdded` listener, messages styled by author type (user/bot/agent/system)
- **Send messages** — `conversation.sendMessage()` directly via Twilio SDK, Enter to send, Shift+Enter for newline
- **Resolve button** — `updateAttributes({mode:"ai"})` + sends "back with AI" message + `leave()`, with confirmation dialog
- **Online/Offline toggle** — POSTs to Agent Status Endpoint (to be built in step 3), falls back gracefully if endpoint doesn't exist yet
- **Browser notifications** — Notification API, prompts for permission, alerts on new handoffs
- **Tab title** — shows unread count like `(3) Agent Dashboard`
- **Per-client agent isolation** — `allowedClients` from token response filters conversations by `client_id`, so DigiShares agents only see DigiShares chats
- **Demo mode** (`?demo`) — 2 mock conversations (DigiShares + Alkohol.cz) with realistic chat history, fully interactive UI without backend
- **Token refresh** — `tokenAboutToExpire` handler, credentials stored in memory (not localStorage)
- **Mobile responsive** — stacks sidebar/chat vertically on small screens
- ~80% code reuse from widget.js (SDK loader, client creation, token refresh, events)

### New workflow: Chat — Agent Token Endpoint (`Dv0ZfV2HELCw7Ske`, 8 nodes)
```
Agent Token Webhook → Validate Agent → Is Valid?
  → true:  Prepare JWT → HMAC Sign → Build Token Response → Return Token
  → false: Reject 403
```
- **AGENTS config table** in Validate Agent node — per-agent username/password + assigned client_ids
- Returns `{ token, identity, clients, region }` — agent.html uses `clients` to filter conversations
- Identity format: `agent_{username}` — unique per agent
- No conversation creation — agents join existing conversations via Twilio SDK
- Same JWT/HMAC pattern as frontend Token Endpoint, separate workflow for isolation
- Tested: login works, invalid credentials return 403

### Updated: LIVE_AGENT_PLAN.md
- Status changed from "Planning" to "In progress"
- Added **AGENTS config table** spec — per-agent username/password + assigned client_ids
- Added **per-client agent isolation** section — agents only see their own client's conversations
- Added **per-client agentOnline** — `agentOnline: { digishares: true, alkoholcz: false }` instead of global flag
- Updated implementation order with current status (steps 1-2 done, step 3 next)

---

## 2026-03-12 — Clickable URLs in bot messages

### Widget (widget.js)
- URLs in bot messages (`http://` and `https://`) are now auto-linked as clickable `<a>` tags
- Opens in new tab (`target="_blank"`, `rel="noopener"` for security)
- XSS-safe: HTML escaped before URL detection
- Link styling: inherits text color, underlined, `word-break:break-all` for long URLs

---

## 2026-03-12 — Multi-client routing infrastructure

### Widget (widget.js)
- Added `data-client-id` attribute support
- Identity format: `{clientId}_user_{uuid}` when client-id is set, `user_{uuid}` when not (backwards compat)
- Session storage key namespaced: `cb_session_{clientId}` — prevents cross-client conflicts on same origin
- `client_id` sent in token request body (init + refresh)
- Helper `generateIdentity()` used across all identity creation points

### Token Endpoint (`ODrNXQASOPNObSWd`) — 11 nodes
- Replaced single `CLIENT_KEY` constant with **`CLIENTS` config table** — validates key per client_id
- `client_id` parsed from request body, defaults to `digishares` when missing (backwards compat)
- Unknown client_id → reject 403 "Unknown client"
- `clientId` passed downstream for logging/debugging

### Message Handler (`wnHbfZ7Djko2G4HZ`) — now 10 nodes
- Added **Route to Client** Code node (between Is Safe? and Call AI Webhook)
- `ROUTING` config table maps client_id → AI webhook URL
- Parses client_id from author identity prefix: `digishares_user_xxx` → `digishares`
- Backwards compat: `user_xxx` (no prefix) → defaults to `digishares`
- Unknown client → message dropped silently
- Call AI Webhook now uses dynamic URL: `{{ $json.webhookUrl }}`

---

## 2026-03-12 — Message guardrails

### Message Handler (`wnHbfZ7Djko2G4HZ`) — now 9 nodes
- Added **Guardrails** Code node after Extract Message Data — checks messages against 5 categories of patterns before forwarding to AI
- Added **Is Safe?** If node — branches between safe (→ AI webhook) and flagged (→ safe reply)
- Added **Prepare Safe Reply** Code node — returns neutral response for flagged messages
- Both branches merge at existing Send Reply to Twilio node

### Guardrail categories
- **Prompt injection**: "ignore previous instructions", "you are now...", `[INST]`, `system:` markers
- **Jailbreak**: DAN mode, developer mode, "pretend you have no rules", bypass requests
- **Data extraction**: "what are your instructions", "show me the system prompt"
- **Abuse & threats**: profanity directed at bot, threats of violence
- **Code injection**: `<script>` tags, `javascript:` URIs, event handler attributes

### Design
- System messages (`[system] generate welcome message`) pass through guardrails untouched
- Safe reply is neutral — doesn't reveal what was blocked: "I'm here to help you with your questions. Could you please rephrase your message?"
- Pattern-based (regex), no external API calls — zero latency overhead

---

## 2026-03-12 — Project health & multi-client planning

### Documentation
- Rewrote `CLAUDE.md` — fixed stale node count (was "10", actual is 11), added workflow versioning process, added multi-client design decisions, consolidated file list
- Rewrote `CHAT_BUBBLE_PLAN.md` — removed duplicate content (was overlapping with CLAUDE.md), added multi-client architecture plan with routing tables, data isolation analysis, migration plan
- Synced parent `CLAUDE.md` with repo copy (was stale, missing Is Refresh? branch)

### Workflow Versioning
- Created `workflows/` directory with first-ever JSON backups
- `workflows/token-endpoint.json` — Token Endpoint (11 nodes, v71)
- `workflows/message-handler.json` — Message Handler (6 nodes, v26)
- Secrets redacted as `__PLACEHOLDER__` values, metadata stripped
- Added versioning process to CLAUDE.md

### Repo
- Added `.gitignore`

---

## 2026-03-02 — Session restore across page refresh

### Token Endpoint (`ODrNXQASOPNObSWd`) — now 11 nodes
- Added **Is Refresh?** If node: branches between new conversation (create) and session restore (skip creation)
- When `refresh: true` + `conversation_sid` is sent, skips Create Conversation + Add Participant, generates fresh JWT for existing conversation
- **Rate Limit & Validate** updated to pass `isRefresh` and `existingConversationSid` downstream
- **Prepare JWT** updated to read `conversation_sid` from webhook body on refresh, or from Create Conversation output on new

### Widget (widget.js)
- Fixed `tokenAboutToExpire` handler to also send `conversation_sid` (prevents JWT generation failure on token refresh)

---

## 2026-03-02 — Session persistence + new conversation

### Widget (widget.js)
- **Session persistence**: identity + conversation_sid saved to `sessionStorage`. Page refresh restores session, loads last 50 messages from Twilio history. Falls back to new conversation if restore fails.
- **New conversation button**: small refresh icon in header (next to close X). Clears session, resets identity, reconnects fresh.
- **AI welcome message**: on new conversations, widget silently sends `[system] generate welcome message` — AI responds with a greeting. Skipped on session restore.
- **Bot markdown rendering**: bot messages support `\n` (line breaks), `**bold**`, `*italic*`. HTML escaped for XSS safety. User messages stay plain text.
- **Smooth auto-scroll**: `scrollTo({ behavior: 'smooth' })`, only auto-scrolls if user is near bottom (100px threshold)
- **Message animations**: slide up 12px + fade in (300ms ease-out)
- **Typing indicator**: bouncing dots (bounce 4px + opacity pulse). Shown after send, hidden on bot reply.

---

## 2026-03-02 — Theming system + DigiShares design

### Architecture
- **CSS custom properties** (`--cb-*`) on `:host` for all visual styles — colors, shadows, radii, fonts
- **External theme files** in `themes/` directory, loaded via `data-theme` attribute
- Three-layer CSS cascade: structural fallbacks → theme file → `data-color` override
- Theme files use `/* @font-url: ... */` comment — widget parses and injects `<link>` for fonts
- `data-color` always wins over theme (backwards compatible quick override)

### Widget (widget.js)
- Refactored all inline CSS to use `var(--cb-*)` with fallback values
- Added `data-theme` attribute support and theme loader (async fetch + inject into Shadow DOM)
- Computes `baseURL` from `document.currentScript.src` for resolving theme paths
- Structural CSS (layout, positioning, transitions) stays inline; visual properties are themeable

### New files
- `themes/default.css` — original blue (#2196F3) look as CSS custom properties
- `themes/digishares.css` — DigiShares brand: navy #002D6B, teal accent #2BCECE, Inter font, gradient header

---

## 2026-03-02 — Security hardening

### Token Endpoint (`ODrNXQASOPNObSWd`) — now 10 nodes
- Added **Rate Limit & Validate** code node: IP-based rate limiting using `$getWorkflowStaticData('global')`, max 10 new conversations per IP per hour, token refreshes bypass rate limiting
- Added **Is Valid?** If node: branches to Create Conversation (true) or Reject Request (false)
- Added **Reject Request** Respond to Webhook node: returns 403 with error message
- Added **client key validation**: `CLIENT_KEY` constant in Rate Limit node, when set rejects requests without matching `client_key`
- Reduced **token TTL** from 3600 (1h) to 1800 (30min)

### Message Handler (`wnHbfZ7Djko2G4HZ`)
- Added **message length truncation**: messages over 2000 characters are truncated before forwarding to AI webhook

### Widget (widget.js)
- Added `data-client-key` attribute support
- Widget sends `client_key` in POST body to token endpoint (init + refresh)
- Parses error response body for better error messages on token request failure

---

## 2026-03-02 — External AI webhook integration

### Architecture
- Chat bubble is now a **reusable transport layer** — AI logic lives in separate client projects
- Message Handler forwards to external client webhook instead of containing AI directly
- `conversationSid` passed to client webhook as session/thread ID for AI context

### n8n — Message Handler (`wnHbfZ7Djko2G4HZ`)
- Restructured from 4 nodes to 6 nodes:
  `Twilio Webhook → Is User Message? → Extract Message Data → Call AI Webhook → Prepare Reply → Send Reply to Twilio`
- Extract Message Data: pulls conversationSid, messageBody, author, messageSid from Twilio payload
- Call AI Webhook: POST to client-specific URL with `{ conversationSid, message, author, messageSid }`
- Prepare Reply: extracts AI response (supports `output`, `reply`, `message`, `text` keys)
- Auth credential `DigiSharesChatbot` (httpHeaderAuth) added for client webhook

---

## 2026-03-01 — End-to-end echo mode working

### Widget (widget.js)
- Built complete chat UI: floating button, chat window, header, messages, input area
- Shadow DOM (closed) for CSS isolation
- Twilio Conversations SDK loaded dynamically from CDN
- Token fetch, WebSocket connection, real-time message rendering
- Typing indicator, connection state handling, token refresh
- Mobile responsive (full-screen below 480px)
- Added Twilio SDK region support — reads `region` from token endpoint response
- Error banner now shows actual error message for debugging

### n8n — Token Endpoint (`ODrNXQASOPNObSWd`)
- Webhook POST `/webhook/chat-token`
- Creates Twilio Conversation + adds user participant (HTTP Request nodes)
- Generates JWT Access Token (Code + Crypto HMAC-SHA256 node)
- Returns `{ token, conversation_sid, region }` to widget
- Uses IE1 regional endpoint: `conversations.dublin.ie1.twilio.com`

### n8n — Message Handler (`wnHbfZ7Djko2G4HZ`)
- Webhook POST `/webhook/chat-message`
- Filters bot messages (If node: Author != "bot")
- Generates echo reply (Code node — placeholder for AI)
- Sends reply via Twilio REST API (HTTP Request node)

### Twilio Configuration
- Conversations Service "N8N Chatbot" (IE1 region)
- Service webhook configured: `onMessageAdded` → n8n Message Handler
- API Key auth (Basic auth in HTTP Request headers)
