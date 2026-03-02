# Chat Bubble Widget — Claude Code Briefing

## Project Goal

Build a reusable, embeddable chat bubble widget hosted on GitHub Pages.  
Any client website adds a single `<script>` tag to get a fully functional AI chat interface.  
Backend is n8n. Real-time messaging via Twilio Conversations SDK (WebSocket).  
Architecture supports future **live agent handoff** without any frontend changes.

---

## Architecture

```
Client Website
  └─ <script src="https://[github-user].github.io/chat-bubble/widget.js"
             data-webhook="..." data-theme="digishares" data-title="...">
        │
        ├─ Renders chat bubble UI (bottom-right floating button)
        ├─ Loads theme CSS from themes/{name}.css (CSS custom properties)
        ├─ On open: calls n8n token endpoint → gets Twilio Access Token
        ├─ Connects to Twilio Conversations via WebSocket (JS SDK)
        └─ Sends/receives messages in real-time

Twilio Conversations (cloud)
  └─ onMessageAdded webhook → POST to n8n

n8n Workflow
  ├─ Token endpoint: creates Conversation + User + returns Access Token to widget
  ├─ Message handler: receives message from Twilio webhook → AI processing → reply via Twilio API
  └─ (Future) Live agent: add human participant to Conversation, remove bot
```

---

## Reusability Design

One `widget.js` file, configured entirely via script tag attributes:

```html
<!-- Example: LaDenta -->
<script
  src="https://[github-user].github.io/chat-bubble/widget.js"
  data-webhook="https://n8n.domain.com/webhook/ladenta-chat"
  data-color="#2196F3"
  data-title="Eva - Dental Assistant"
  data-logo="https://ladenta.cz/logo.png"
></script>

<!-- Example: Atlas Copco -->
<script
  src="https://[github-user].github.io/chat-bubble/widget.js"
  data-webhook="https://n8n.domain.com/webhook/torquie-chat"
  data-color="#FF6B00"
  data-title="Torquie"
  data-logo="https://atlascopco.com/logo.png"
></script>
```

**Config attributes:**
| Attribute | Required | Description |
|---|---|---|
| `data-webhook` | ✅ | n8n webhook URL for THIS client's token endpoint |
| `data-color` | optional | Brand primary color (default: #2C3E50) |
| `data-title` | optional | Bot name shown in chat header (default: "Chat") |
| `data-logo` | optional | Avatar image URL in chat header |

New client = new n8n workflow + new script tag. No code changes.

---

## What Is Already Done

### Twilio
- ✅ Twilio account exists (**IE1 — Ireland region**)
- ✅ Conversations product enabled
- ✅ Conversations Service created: **"N8N Chatbot"**
  - Service SID: (stored locally, not in repo)
  - Regional API base: `https://conversations.dublin.ie1.twilio.com`
- ✅ API Key created (SK... + secret — stored by user)
- ✅ Default Conversations Service set to N8N Chatbot
- ✅ Webhook configured on service (onMessageAdded, POST)

### Frontend (GitHub Pages)
- ✅ GitHub repo created: https://github.com/darthPeter/chat-bubble
- ✅ GitHub Pages enabled: https://darthpeter.github.io/chat-bubble/
- ✅ `widget.js` built — full UI shell + Twilio SDK init:
  - Shadow DOM (closed) for CSS isolation
  - Floating button (bottom-right, brand-colored, animated)
  - Chat window: header (avatar + title + status + close), scrollable messages, auto-resize textarea
  - Twilio Conversations SDK loaded dynamically from CDN on first open
  - Token fetch flow: POST to webhook → receives `{ token, conversation_sid }` → connects WebSocket
  - Real-time message rendering (`messageAdded` event)
  - Typing indicator (3-dot animation)
  - Connection state handling (connecting / online / offline / error banner)
  - Automatic token refresh on `tokenAboutToExpire`
  - Mobile responsive (full-screen below 480px)
- ✅ `demo.html` — test page embedding the widget

### n8n Workflows
- ✅ **Chat — Token Endpoint** (ID: `ODrNXQASOPNObSWd`)
  - Webhook: `POST /webhook/chat-token` → responds via Respond to Webhook node
  - Code node: creates Twilio Conversation, adds user participant, generates JWT Access Token
  - Returns `{ token, conversation_sid }` to widget
  - 3 nodes: `Chat Token Webhook` → `Create Conversation & Token` → `Return Token`
  - **Status: built, needs Twilio credentials filled in, not yet activated**

- ✅ **Chat — Message Handler** (ID: `wnHbfZ7Djko2G4HZ`)
  - Webhook: `POST /webhook/chat-message` → responds 200 immediately
  - If node: filters out bot messages (Author ≠ "bot") to prevent infinite loops
  - Code node: processes message + sends reply back to Twilio Conversation
  - 3 nodes: `Twilio Message Webhook` → `Is User Message?` → `Process & Reply`
  - AI: currently **echo mode** for testing (`Echo: <message>`), swap with real AI later
  - **Status: built, needs Twilio credentials filled in, not yet activated**

---

## What Has Been Built

### 1. Frontend — widget.js ✅
Single vanilla JS file, no build step. Twilio SDK loaded dynamically from CDN.
- Reads config from `data-*` attributes: `data-webhook`, `data-theme`, `data-color`, `data-title`, `data-logo`, `data-client-key`
- Shadow DOM (closed) for full CSS isolation from host page
- **Theming**: CSS custom properties (`--cb-*`) on `:host`. External theme files loaded via `data-theme` attribute. `data-color` overrides primary color.
- Floating button (bottom-right, brand color, hover animation)
- Chat window: header (avatar + title + status + close), scrollable messages, auto-resize textarea
- Token fetch: POST to `data-webhook` → receives `{ token, conversation_sid }`
- Twilio Conversations SDK: WebSocket connection, `messageAdded` listener, typing indicators
- Connection state management (connecting / online / offline / error banner)
- Token refresh via `tokenAboutToExpire` event
- Mobile responsive (full-screen below 480px)
- **UX**: Smart auto-scroll (100px threshold, smooth behavior), message slide-up + fade-in animations (300ms), bouncing typing dots shown after send / hidden on reply
- **Bot markdown**: lightweight formatter renders `\n`, `**bold**`, `*italic*` in bot messages (HTML escaped for XSS safety)
- **Welcome message**: sends `[system] generate welcome message` on new conversations — AI generates greeting
- **Session persistence**: identity + conversation_sid in `sessionStorage`. Restores on refresh, loads last 50 messages. Falls back to new conversation if expired.
- **New conversation button**: refresh icon in header, clears session, reconnects fresh
- **Theme files**: `themes/default.css` (blue), `themes/digishares.css` (navy/teal/Inter)
- **Repo:** https://github.com/darthPeter/chat-bubble
- **Live:** https://darthpeter.github.io/chat-bubble/demo.html

### 2. n8n — Token Endpoint Workflow ✅ Active
**ID:** `ODrNXQASOPNObSWd` | **Webhook path:** `/webhook/chat-token`

```
Chat Token Webhook (POST) → Create Conversation (HTTP) → Add Participant (HTTP) → Prepare JWT (Code) → HMAC Sign (Crypto) → Build Token Response (Code) → Return Token (Respond)
```

- HTTP Request nodes handle Twilio API calls (Basic Auth header)
- Code nodes build JWT header+payload (no crypto needed)
- n8n Crypto node signs with HMAC-SHA256 (replaces broken `crypto.subtle`)
- Returns `{ token, conversation_sid }` to widget
- Uses regional endpoint: `conversations.dublin.ie1.twilio.com`

### 3. n8n — Message Handler Workflow ✅ Active (echo mode)
**ID:** `wnHbfZ7Djko2G4HZ` | **Webhook path:** `/webhook/chat-message`

```
Twilio Message Webhook (POST) → Is User Message? (If) → Prepare Reply (Code) → Send Reply to Twilio (HTTP)
```

- Webhook responds 200 immediately (Twilio doesn't timeout)
- If node filters: Author ≠ "bot" (prevents infinite reply loops)
- Code node extracts message body and generates reply (currently echo)
- HTTP Request node sends reply to Twilio conversation
- **AI is placeholder** — currently echoes `Echo: <message>` for testing

---

## GitHub Pages Setup

Repo structure:
```
chat-bubble/
  ├─ widget.js          ← the embeddable script
  ├─ demo.html          ← test page with the script tag
  └─ README.md
```

- Enable GitHub Pages on repo (branch: main, root folder)
- Widget URL: `https://[username].github.io/chat-bubble/widget.js`

---

## Build Order

1. ~~**Create GitHub repo** `chat-bubble`, enable Pages~~ ✅
2. ~~**Build `widget.js`** — UI + Twilio SDK init + config from attributes~~ ✅
3. ~~**Build `demo.html`** — test page pointing at mock webhook~~ ✅
4. ~~**Build n8n "Chat — Token Endpoint" workflow**~~ ✅
5. ~~**Build n8n "Chat — Message Handler" workflow**~~ ✅
6. ~~**Fill in Twilio credentials + activate workflows**~~ ✅
7. ~~**Update Twilio Service webhook URL** to point to n8n~~ ✅ (user configured)
8. ~~**Update `demo.html`** with real n8n webhook URL~~ ✅ (pushed to GitHub)
9. ~~**Test backend end-to-end** — token generation + echo reply via API~~ ✅
10. ~~**Test widget end-to-end** — open demo page, send message, get echo reply~~ ✅
11. ~~**Replace echo with external AI webhook**~~ ✅ (client webhook integration)
12. ~~**Security hardening** — rate limiting, client key, message truncation, token TTL~~ ✅
13. ~~**Theming system** — CSS custom properties, external theme files, DigiShares brand~~ ✅
14. ~~**Chat UX polish** — smooth scroll, message animations, typing indicator~~ ✅
15. ~~**Bot markdown rendering** — newlines, bold, italic in bot messages~~ ✅
16. ~~**AI welcome message** — system message triggers greeting on new conversations~~ ✅
17. ~~**Session persistence** — sessionStorage, message history restore, new conversation button~~ ✅

---

## TODO — What To Do Next

### ~~Step 1: Fill in Twilio credentials~~ ✅ Done
### ~~Step 2: Activate both workflows~~ ✅ Done
### ~~Step 3: Update Twilio webhook~~ ✅ Done (user configured)
### ~~Step 4: Update demo.html~~ ✅ Pushed to GitHub
### ~~Step 5: Test backend (API-level)~~ ✅ Both workflows tested successfully
- Token Endpoint: creates conversation, adds participant, generates JWT, returns `{ token, conversation_sid }`
- Message Handler: receives message, filters bot messages, generates echo reply, sends to Twilio (201 Created)

### ~~Step 6: Test widget end-to-end~~ ✅ Passed
- Widget connects, shows "Online"
- User sends message → receives "Echo: test" reply in real-time
- Full pipeline working: widget → n8n token → Twilio SDK → message → Twilio webhook → n8n handler → echo reply → WebSocket back to widget
- Fixed: Twilio SDK region (must pass `{ region: 'ie1' }` to `Client.create()`)
- Fixed: Twilio Service webhook was not configured — set via API to `https://n8n.srv1104100.hstgr.cloud/webhook/chat-message`

### ~~Step 7: Connect external AI webhook~~ ✅ Done
- Message Handler now forwards messages to an external client AI webhook instead of echo
- Architecture: chat bubble = reusable transport layer, client project = AI brain with knowledge base
- Flow: `Extract Message Data → Call AI Webhook (POST) → Prepare Reply → Send Reply to Twilio`
- Payload sent to client webhook:
  ```json
  { "conversationSid": "CHxxx", "message": "user text", "author": "user_uuid", "messageSid": "IMxxx" }
  ```
- Client webhook returns: `{ "output": "AI response" }` (also supports `reply`, `message`, `text` keys)
- `conversationSid` used as session ID for AI context/memory across messages
- Auth: Header auth credential `DigiSharesChatbot` (configured manually in n8n)
- Client webhook URL: configured in n8n (not stored in repo)
- Tested end-to-end from widget — AI responses appear in real-time in chat

### ~~Step 8: Security hardening~~ ✅ Done
Implemented:
- **Rate limiting by IP** (Token Endpoint): Code node uses `$getWorkflowStaticData('global')` to track requests per IP. Max 10 new conversations per IP per hour. Token refreshes bypass rate limiting.
- **Client key validation** (Token Endpoint): `CLIENT_KEY` constant in Rate Limit & Validate node. When set, rejects requests without matching `client_key` in POST body. Currently empty (disabled) — set per deployment.
- **Max message length** (Message Handler): Extract Message Data truncates messages over 2000 characters before forwarding to AI webhook.
- **Token TTL** reduced from 3600 (1h) to 1800 (30min). Widget already handles refresh via `tokenAboutToExpire`.
- **Widget**: Added `data-client-key` attribute support. Sends `client_key` in POST body. Parses error response body for better error messages.
- **CORS**: Kept open (n8n default) since widget can be embedded on any client domain. Client key + rate limiting provide the access control.

Token Endpoint structure (10 nodes):
```
Chat Token Webhook → Rate Limit & Validate (Code) → Is Valid? (If)
  → true: Create Conversation → Add Participant → Prepare JWT → HMAC Sign → Build Token Response → Return Token
  → false: Reject Request (Respond 403)
```

### ~~Step 9: Theming system + DigiShares design~~ ✅ Done
- Refactored `widget.js` to use CSS custom properties (`--cb-*`) on `:host` for all visual styles
- Structural CSS (layout, positioning, transitions) stays inline with fallback values
- Added `data-theme` attribute — loads external CSS from `themes/{name}.css` via fetch
- Theme files only set `:host` variables — no selectors needed
- Font loading: theme CSS has `/* @font-url: <url> */` comment, widget parses + injects `<link>` into `document.head`
- `data-color` still works as highest-priority override on top of any theme (backwards compatible)
- CSS cascade: structural fallbacks → theme file → `data-color` override
- Created `themes/default.css` — original blue (#2196F3/#2C3E50) look
- Created `themes/digishares.css` — DigiShares brand: navy #002D6B, teal #2BCECE, Inter font, gradient header
- `demo.html` updated to use `data-theme="digishares"`
- New client = create `themes/clientname.css` + set `data-theme="clientname"` — no widget code changes

---

## Credentials (configured in n8n workflows)

| Value | Status |
|---|---|
| Twilio Account SID | ✅ Configured |
| Twilio API Key SID | ✅ Configured |
| Twilio API Key Secret | ✅ Configured (in HTTP Request auth headers + Crypto node) |
| Conversations Service SID | ✅ Configured (IE1 region) |
| Twilio regional endpoint | ✅ `conversations.dublin.ie1.twilio.com` |

---

## Detailed Flow — How It Works

### Session Init (user opens chat — once per session)

```
Browser (widget.js)              n8n (Token Endpoint)              Twilio
       │                                │                            │
       │  1. User clicks bubble         │                            │
       │  2. Generate identity          │                            │
       │     "user_<uuid>"              │                            │
       │                                │                            │
       │  3. POST /webhook/chat-token   │                            │
       │     { identity }               │                            │
       │ ──────────────────────────────>│                            │
       │                                │  4. Create Conversation    │
       │                                │ ──────────────────────────>│
       │                                │  5. Add user participant   │
       │                                │ ──────────────────────────>│
       │                                │  6. Generate Access Token  │
       │                                │     (Chat Grant, scoped)   │
       │                                │                            │
       │  7. { token, convo_sid }       │                            │
       │ <──────────────────────────────│                            │
       │                                                             │
       │  8. Load Twilio JS SDK from CDN                             │
       │  9. Connect WebSocket using token                           │
       │ ──────────────────────────────────────────────────────────>│
       │                    CONNECTED (real-time channel open)       │
```

### Messaging (every message)

```
Browser (widget.js)              Twilio                     n8n (Message Handler)
       │                            │                              │
       │  User types "Hello"        │                              │
       │ ──────────────────────────>│  (via WebSocket/SDK)         │
       │                            │                              │
       │                            │  onMessageAdded webhook      │
       │                            │  POST /webhook/chat-message  │
       │                            │ ────────────────────────────>│
       │                            │                              │  Filter: skip bot msgs
       │                            │                              │  AI processes message
       │                            │                              │  (Claude/OpenAI/etc)
       │                            │      POST reply to convo     │
       │                            │ <────────────────────────────│
       │                            │                              │
       │  Bot reply arrives         │                              │
       │  (instant, via WebSocket)  │                              │
       │ <──────────────────────────│                              │
```

### Why Two Separate Workflows

| | Chat — Token Endpoint | Chat — Message Handler |
|---|---|---|
| **Called by** | Widget (browser) | Twilio (server-to-server) |
| **When** | Once per session (chat open) | Every message in any conversation |
| **Trigger** | n8n Webhook node | n8n Webhook node (different URL) |
| **Purpose** | Create session, return credentials | Process messages, generate AI replies |
| **Input** | `{ identity }` from widget | Twilio `onMessageAdded` payload |
| **Output** | `{ token, conversation_sid }` to widget | AI reply sent via Twilio REST API |

They **cannot** be combined — different callers, different triggers, different timing.

---

## Security

### What's Secure
- **Twilio credentials** (Account SID, API Key, Secret) live only in n8n — never sent to browser
- **Access Tokens** are short-lived (1h) and scoped to one conversation
- **Shadow DOM** is closed — host page JS cannot access chat widget internals
- **Messages** travel through Twilio's encrypted infrastructure (TLS)
- **n8n ↔ Twilio** communication is server-to-server, not exposed to browser

### Risks & Mitigations

| Risk | Severity | Details | Mitigation |
|---|---|---|---|
| Webhook URL in page source | Medium | `data-webhook` is visible to anyone inspecting the page. Could be used to create spam conversations. | Add `data-client-key` — a simple key validated by n8n. Not a secret, but stops casual abuse. |
| No rate limiting | Medium | Attacker could spam the token endpoint, creating thousands of Twilio conversations (costs money). | Add rate limiting in n8n: max N conversations per IP per hour. |
| No CORS restriction | Low | n8n webhook accepts requests from any origin. | Configure n8n response headers to restrict `Access-Control-Allow-Origin` to allowed client domains. |
| Client-side identity | Low | User could forge the identity string. | Low impact — each identity gets its own isolated conversation. No access to other conversations. |

### Hardening — Implemented ✅

| Feature | Where | Details |
|---|---|---|
| Rate limit by IP | Token Endpoint — Rate Limit & Validate node | `$getWorkflowStaticData('global')`, max 10/IP/hour, token refreshes bypass |
| Client key | Token Endpoint — Rate Limit & Validate node + widget.js | `CLIENT_KEY` constant, `data-client-key` attribute, stops bots/scrapers |
| Max message length | Message Handler — Extract Message Data node | Truncates at 2000 chars before AI webhook |
| Token TTL | Token Endpoint — Prepare JWT node | Reduced from 3600 to 1800 (30 min) |
| CORS | N/A — kept open | Widget embeds on any domain; client key + rate limiting provide access control |

---

## Notes

- Widget uses Twilio Conversations **JavaScript SDK** loaded from Twilio CDN
- Access tokens expire (default 1h) — widget handles refresh via `tokenAboutToExpire` event
- For live agent: add human participant to Conversation via API, pause n8n bot logic by checking participant list before replying
- This is NOT SaaS — no multi-tenancy database needed. Each deployment is independent.
