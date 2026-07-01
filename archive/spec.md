# Chat Bubble Widget — Project Specification

## What Is This?

An embeddable AI chat widget that any website can add with a single `<script>` tag. It renders a floating chat bubble in the bottom-right corner of the page. When a visitor clicks it, a chat window opens and they can talk to an AI assistant in real time.

The system is **multi-client** — one shared codebase serves multiple different websites, each with its own branding (theme), its own AI brain, and its own configuration. Adding a new client requires zero code changes to the widget itself.

**Live demo:** The widget is hosted on GitHub Pages and currently serves two clients — DigiShares (a tokenization platform) and Alkohol.cz (a Czech e-commerce site).

---

## Technologies

| Layer | Technology | Why |
|---|---|---|
| **Widget (frontend)** | Vanilla JavaScript, HTML, CSS | No build step, no framework — a single file that loads anywhere |
| **CSS isolation** | Shadow DOM (closed mode) | Widget styles never leak into or get affected by the host page |
| **Real-time messaging** | Twilio Conversations SDK (WebSocket) | Reliable, scalable, handles presence/typing/history out of the box |
| **Backend / automation** | n8n (self-hosted) | Visual workflow builder — handles token generation, message routing, security |
| **AI processing** | External per-client webhooks | Each client has its own AI setup (e.g. their own n8n AI workflow with a knowledge base). The chat system just routes messages to it |
| **Hosting** | GitHub Pages | Free, simple, automatic deploys on push |
| **Theming** | CSS custom properties (`--cb-*`) | External `.css` files per client, loaded at runtime |

---

## Architecture Overview

The system has three layers: the **widget** (runs in the visitor's browser), **Twilio** (cloud messaging infrastructure), and **n8n** (backend logic).

```
┌─────────────────────────────────────────────────────────┐
│  Client Website (e.g. digishares.com)                   │
│                                                         │
│  <script src=".../widget.js"                            │
│          data-webhook="..."                             │
│          data-theme="digishares"                        │
│          data-client-id="digishares"                    │
│          data-client-key="..." />                       │
│                                                         │
│  ┌──────────────────────────┐                           │
│  │  Chat Bubble (Shadow DOM)│                           │
│  │  - Floating button       │                           │
│  │  - Chat window           │                           │
│  │  - Message input         │                           │
│  └──────────┬───────────────┘                           │
└─────────────┼───────────────────────────────────────────┘
              │
              │ 1. On open: POST /chat-token → get Twilio access token
              │ 2. Connect WebSocket via Twilio SDK
              │ 3. Send/receive messages in real time
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  Twilio Conversations (cloud, Ireland region)           │
│                                                         │
│  - Each chat session = one Conversation                 │
│  - Messages delivered via WebSocket (instant)           │
│  - onMessageAdded webhook → triggers n8n               │
└──────────────────────┬──────────────────────────────────┘
                       │
                       │ Webhook (server-to-server)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  n8n (self-hosted)                                      │
│                                                         │
│  Workflow 1: Token Endpoint                             │
│    - Validates client key, rate-limits by IP            │
│    - Creates Twilio Conversation + participant          │
│    - Signs JWT token, returns to widget                 │
│                                                         │
│  Workflow 2: Message Handler                            │
│    - Receives every new message from Twilio             │
│    - Runs security guardrails (prompt injection, etc.)  │
│    - Routes to the correct client's AI webhook          │
│    - Sends AI response back to the conversation         │
│                                                         │
│  Workflow 3: Agent Token Endpoint                       │
│    - Authenticates human agents (username/password)     │
│    - Returns token scoped to agent's assigned clients   │
└─────────────────────────────────────────────────────────┘
```

---

## How It Works

### Starting a Chat Session

1. A visitor loads a page that includes the widget `<script>` tag
2. The widget renders a floating chat button (bottom-right corner)
3. When the visitor clicks the button, the widget:
   - Generates a unique identity (`{client_id}_user_{uuid}`)
   - POSTs to the n8n Token Endpoint with the identity and client key
   - n8n validates the key, checks the rate limit, creates a Twilio Conversation, and returns a JWT access token
4. The widget uses the token to connect to Twilio via WebSocket
5. On a brand-new conversation, the widget sends a special system message (`[system] generate welcome message`) so the AI generates a personalized greeting

### Sending and Receiving Messages

1. The user types a message and hits Send
2. The message is sent to Twilio via the WebSocket connection (Twilio SDK)
3. Twilio fires an `onMessageAdded` webhook to the n8n Message Handler
4. n8n runs security guardrails — if the message looks like a prompt injection or abuse attempt, it returns a safe neutral reply without ever reaching the AI
5. If the message is safe, n8n looks up which client this conversation belongs to (from the user identity prefix) and forwards the message to that client's AI webhook
6. The AI processes the message and returns a response
7. n8n sends the AI response back to the Twilio Conversation via REST API
8. The widget receives the response instantly via WebSocket and displays it

### Session Persistence

- The user's identity and conversation ID are stored in `sessionStorage` (namespaced by client ID)
- If the user refreshes the page, the widget restores the session and loads the last 50 messages
- The "New Conversation" button clears the session and starts fresh
- Tokens expire after 30 minutes; the widget automatically refreshes them before expiry

---

## Widget Configuration

The widget is configured entirely through `data-*` attributes on the `<script>` tag. No code changes needed.

| Attribute | Required | Description |
|---|---|---|
| `data-webhook` | Yes | URL of the n8n Token Endpoint |
| `data-client-id` | Yes | Unique identifier for this client (e.g. `digishares`) |
| `data-client-key` | Yes | Secret key for authentication with the Token Endpoint |
| `data-theme` | Optional | Theme name — loads `themes/{name}.css` from the widget host |
| `data-color` | Optional | Primary color override (hex value, applied on top of theme) |
| `data-title` | Optional | Bot name displayed in the chat header (default: "Chat") |
| `data-logo` | Optional | URL to an avatar image shown in the header |

**Example:**
```html
<script src="https://darthpeter.github.io/chat-bubble/widget.js"
        data-webhook="https://n8n.example.com/webhook/chat-token"
        data-client-id="mycompany"
        data-client-key="secret123"
        data-theme="default"
        data-title="Support Bot"
        data-color="#FF6600">
</script>
```

---

## Theming

Each client can have its own visual theme. Themes are plain CSS files in the `themes/` directory that define CSS custom properties.

Available themes:
- `default.css` — clean blue theme
- `digishares.css` — navy and teal with Inter font
- `alkoholcz.css` — styled to match the Alkohol.cz brand

Themes control colors, fonts, border radius, shadows, and any other visual aspect of the chat window. The `data-color` attribute can override the primary color on top of any theme.

---

## Security

| Measure | Where | Details |
|---|---|---|
| **Client key validation** | Token Endpoint | Each client has a unique key; requests without a valid key are rejected (403) |
| **IP rate limiting** | Token Endpoint | Max 10 new conversations per IP per hour (token refreshes bypass this) |
| **Message guardrails** | Message Handler | Filters prompt injection, jailbreak attempts, data extraction, abuse, and code injection before they reach the AI |
| **Message length limit** | Message Handler | Messages truncated at 2,000 characters |
| **Short-lived tokens** | Token Endpoint | JWT tokens expire after 30 minutes; auto-refreshed by the widget |
| **Server-side credentials** | n8n | Twilio API keys and secrets never leave the server |
| **Shadow DOM isolation** | Widget | Closed Shadow DOM — the host page cannot access widget internals |
| **XSS protection** | Widget | All bot messages are HTML-escaped before rendering markdown |

---

## Live Agent Handoff (In Progress)

When the AI cannot help a visitor, the conversation can be handed off to a real human agent. The agent uses a dedicated web dashboard (`agent.html`) that connects to the same Twilio Conversation — the visitor sees no difference in the UI.

**How it works:**
- The AI decides when a handoff is needed (no keyword detection — the AI brain makes the call)
- The agent logs in to `agent.html` with username/password, authenticated via the Agent Token Endpoint
- Agents only see conversations for their assigned clients (per-client isolation)
- When the agent resolves the conversation, the bot takes back over

**Current status:** The agent dashboard and Agent Token Endpoint are built. The agent status endpoint (online/offline tracking) is next.

---

## File Structure

```
chat-bubble/
├── widget.js                  # The core widget — single vanilla JS file
├── agent.html                 # Agent dashboard for live agent handoff
├── demo.html                  # DigiShares test/demo page
├── demo-alkoholcz.html        # Alkohol.cz test/demo page
├── themes/
│   ├── default.css            # Default blue theme
│   ├── digishares.css         # DigiShares brand theme
│   └── alkoholcz.css          # Alkohol.cz brand theme
├── workflows/
│   ├── token-endpoint.json    # n8n workflow backup (secrets redacted)
│   ├── message-handler.json   # n8n workflow backup (secrets redacted)
│   └── agent-token-endpoint.json  # n8n workflow backup (secrets redacted)
├── docs/
│   └── spec.md                # This file
├── CLAUDE.md                  # Instructions for Claude Code AI assistant
├── CHAT_BUBBLE_PLAN.md        # Detailed project roadmap and TODO
├── LIVE_AGENT_PLAN.md         # Live agent handoff architecture
└── CHANGELOG.md               # Version history
```

---

## Adding a New Client

To onboard a new client website, you need:

1. **Theme file** — Create `themes/{client_id}.css` with the client's branding (colors, fonts, etc.)
2. **Client AI webhook** — The client needs an AI endpoint that accepts `{ conversationSid, message, author, messageSid }` and returns `{ output }`. This is typically an n8n AI workflow with a knowledge base.
3. **n8n configuration** — Add the client to:
   - `CLIENTS` table in the Token Endpoint (client key for authentication)
   - `ROUTING` table in the Message Handler (webhook URL for AI routing)
4. **Script tag** — Add the `<script>` tag to the client's website with the appropriate `data-*` attributes
5. **(Optional) Agent access** — Add agent credentials to the `AGENTS` table in the Agent Token Endpoint

No changes to `widget.js` or any workflow logic are needed.

---

## Key Design Principles

- **No build step** — Everything is plain HTML, CSS, and JavaScript. No npm, no webpack, no compilation. Just edit and push.
- **Separation of concerns** — The chat bubble is a dumb transport layer. It knows nothing about AI. Each client's AI brain lives in its own separate system.
- **Multi-client, single codebase** — One `widget.js` serves all clients. Configuration lives in `data-*` attributes and n8n config tables.
- **Real-time first** — WebSocket via Twilio SDK, not polling. Messages arrive instantly.
- **Privacy by design** — Credentials stay on the server. The browser only gets short-lived tokens.
