# CLAUDE.md

> **CRITICAL RULE:** All project knowledge MUST live in this repo (git-tracked). This file holds core architecture, configs, and pointers to other docs. Detailed plans and specific topics get their own `.md` files — this file links to them. Never bloat this file with deep-dive details, but make sure it knows where to FIND everything. Claude Code memory files are SHORT-TERM CACHE only — never store long-term knowledge there.

## Project Overview

Embeddable chat bubble widget hosted on GitHub Pages. Any client website adds a single `<script>` tag to get an AI chat interface. Backend is n8n, real-time messaging via Twilio Conversations SDK (WebSocket).

## Architecture

```
Client Website → <script> tag with data-* config
  → widget.js renders floating chat bubble
  → On open: calls n8n token endpoint → gets Twilio Access Token
  → Connects to Twilio Conversations via WebSocket (JS SDK)
  → Sends/receives messages in real-time

Twilio Conversations (cloud)
  → onMessageAdded webhook → POST to n8n

n8n Workflows:
  1. Token endpoint: validates client → creates Conversation + User → returns Access Token
  2. Message handler: receives Twilio webhook → routes to client AI webhook → reply via Twilio API
```

## Key Design Decisions

- **No build step**: `widget.js` is a single vanilla JS file, no bundler, no framework
- **Shadow DOM**: closed mode for CSS isolation from host page
- **Twilio SDK loaded dynamically** from CDN at runtime
- **Configuration via `data-*` attributes**: `data-webhook`, `data-theme`, `data-color`, `data-title`, `data-logo`, `data-client-key`, `data-client-id`
- **Theming system**: External CSS files in `themes/` loaded via `data-theme` attribute. CSS custom properties (`--cb-*`) on `:host`. `data-color` overrides primary color on top of any theme.
- **Multi-client, single codebase**: one `widget.js`, one Token Endpoint, one Message Handler. Client routing via `client_id` in identity prefix. See `CHAT_BUBBLE_PLAN.md` for details.
- **Separation of concerns**: chat bubble = reusable transport layer, client project = AI brain with knowledge base. Message Handler routes to client-specific AI webhook.
- **Smart scroll**: auto-scrolls only when user is near bottom (100px threshold); always scrolls for own messages. Typing indicator shown after send, hidden on bot reply.
- **Session persistence**: identity + conversation_sid in `sessionStorage` (namespaced by client_id). Restores on refresh, loads message history. New conversation button resets.
- **Welcome message**: widget sends `[system] generate welcome message` on new conversations — AI generates greeting. Skipped on session restore.
- **Bot markdown**: lightweight formatter renders `\n`, `**bold**`, `*italic*`, and clickable URLs in bot messages. HTML escaped first for XSS safety.

## Repo & Hosting

- **GitHub repo:** https://github.com/darthPeter/chat-bubble
- **GitHub Pages:** https://darthpeter.github.io/chat-bubble/
- **Files:**
  - `widget.js` — core widget (vanilla JS, no build step)
  - `demo.html` — DigiShares test page
  - `demo-alkoholcz.html` — Alkohol.cz test page (alkohol.cz in iframe background)
  - `themes/default.css`, `themes/digishares.css`, `themes/alkoholcz.css` — theme files
  - `workflows/` — n8n workflow JSON backups (secrets redacted)
  - `CHAT_BUBBLE_PLAN.md` — roadmap, plans, and TODO
  - `LIVE_AGENT_PLAN.md` — live agent handoff architecture (brainstorming, not active yet)
  - `CHANGELOG.md` — version history

## n8n Workflows

- **n8n instance:** `https://n8n.srv1104100.hstgr.cloud`
- **Do not touch other n8n workflows**

| Workflow | ID | Webhook Path | Status |
|---|---|---|---|
| Chat — Token Endpoint | `ODrNXQASOPNObSWd` | `/webhook/chat-token` | Active, security hardened |
| Chat — Message Handler | `wnHbfZ7Djko2G4HZ` | `/webhook/chat-message` | Active, AI via client webhook |

### Token Endpoint (11 nodes)
```
Chat Token Webhook → Rate Limit & Validate (Code) → Is Valid? (If)
  → true: Is Refresh? (If)
    → true (token refresh):  Prepare JWT → HMAC Sign → Build Token Response → Return Token
    → false (new session):   Create Conversation → Add Participant → Prepare JWT → ...
  → false: Reject Request (Respond 403)
```
- Rate limiting: 10 conversations/IP/hour via `$getWorkflowStaticData('global')`, token refreshes bypass
- Client validation: `CLIENTS` config table in Rate Limit node — validates key per `client_id` from request body. No `client_id` defaults to `digishares`.
- Token TTL: 1800s (30 min), widget handles refresh via `tokenAboutToExpire`
- Session restore: `refresh: true` + `conversation_sid` skips conversation creation

### Message Handler (10 nodes)
```
Twilio Webhook → Is User Message? (If) → Extract Message Data (Code) → Guardrails (Code) → Is Safe? (If)
  → true:  Route to Client (Code) → Call AI Webhook (HTTP) → Prepare Reply (Code) → Send Reply to Twilio (HTTP)
  → false: Prepare Safe Reply (Code) ──────────────────────────────────────────────→ Send Reply to Twilio (HTTP)
```
- If node filters Author != "bot" to prevent infinite reply loops
- **Guardrails**: filters prompt injection, jailbreak, data extraction, abuse, code injection. System messages (`[system]`) pass through.
- Flagged messages get a neutral safe reply without reaching the AI webhook
- **Route to Client**: parses `client_id` from author identity prefix (`digishares_user_xxx` → `digishares`), looks up webhook URL from `ROUTING` config table. Backwards compat: `user_xxx` (no prefix) → `digishares`.
- Call AI Webhook uses dynamic URL from routing: `{{ $json.webhookUrl }}`
- **Auth**: single `GlobalChatbot` httpHeaderAuth credential (ID: O7q7nPcQ1jLW2gNM) — all client AI webhooks accept the same auth token. n8n HTTP Request node can only use one static credential, so all clients share it.
- Client webhook receives: `{ conversationSid, message, author, messageSid }`
- Client webhook returns: `{ output }` (also supports `reply`, `message`, `text` keys)
- `conversationSid` serves as session/thread ID for AI context across messages
- Message length truncated at 2000 chars before AI webhook

## Twilio Setup

- **Region:** Ireland (IE1) — all API calls use `conversations.dublin.ie1.twilio.com`
- Conversations Service: "N8N Chatbot" (SID configured in n8n, not in repo)
- Service webhook: onMessageAdded → n8n Message Handler
- Account SID: configured in n8n, not in repo

## n8n Code Node Sandbox Limitations

These APIs are **NOT available** in n8n Code nodes:
- `require('crypto')` — disallowed
- `crypto.subtle` (Web Crypto API) — not defined
- `fetch()` — not defined

Use instead:
- **Crypto node** for hashing/HMAC (built-in n8n node, no credentials needed)
- **HTTP Request node** for external API calls
- `btoa()` and `TextEncoder` are available

## Workflow Versioning

n8n workflow JSON backups are stored in `workflows/` with secrets redacted as `__PLACEHOLDER__` values. This provides git-tracked version history for all workflow changes.

**Process — after every n8n workflow change:**
1. Download workflow JSON via n8n MCP (`n8n_get_workflow`, mode `full`)
2. Strip metadata: `staticData`, `shared`, `activeVersion`, `meta`, `pinData`, `tags`
3. Redact secrets: auth headers, API secrets, client keys → `__PLACEHOLDER__`
4. Save to `workflows/{workflow-name}.json`
5. Update `_backup.date` and `_backup.version` fields
6. Commit with descriptive message

**Redacted placeholders** (actual values configured in n8n):
- `__TWILIO_BASIC_AUTH__` — Basic auth header (base64 of API_KEY_SID:API_KEY_SECRET)
- `__TWILIO_API_SECRET__` — Twilio API Key Secret
- `__CLIENT_KEY_DIGISHARES__`, `__CLIENT_KEY_ALKOHOLCZ__` — Per-client access keys
- `__ACCOUNT_SID__`, `__API_KEY_SID__`, `__SERVICE_SID__` — Twilio identifiers
- `__AI_WEBHOOK_URL_DIGISHARES__`, `__AI_WEBHOOK_URL_ALKOHOLCZ__` — Per-client AI webhook URLs
- `__AI_AUTH_TOKEN_DIGISHARES__`, `__AI_AUTH_TOKEN_ALKOHOLCZ__` — Per-client AI webhook auth tokens (stored in ROUTING table but auth handled by GlobalChatbot credential)
- `__CREDENTIAL_ID__`, `__CREDENTIAL_NAME__` — n8n credential references (GlobalChatbot)

## Active Clients

| Client | client_id | Theme | Demo Page | Status |
|---|---|---|---|---|
| DigiShares | `digishares` | `themes/digishares.css` | `demo.html` | Live |
| Alkohol.cz | `alkoholcz` | `themes/alkoholcz.css` | `demo-alkoholcz.html` | Live (2026-03-13) |

## n8n Credential Limitation

n8n HTTP Request node can only bind **one static credential** — you cannot switch credentials dynamically per client. Solution: all client AI webhooks share the same `GlobalChatbot` httpHeaderAuth credential (same auth token accepted by all).

## Detailed Plan & TODO

See `CHAT_BUBBLE_PLAN.md` for multi-client architecture plan, post-conversation webhook plan, and current TODO.
See `LIVE_AGENT_PLAN.md` for live agent handoff architecture (brainstorming phase, not active).
