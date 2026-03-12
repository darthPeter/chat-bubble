# Changelog — Chat Bubble Widget

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
