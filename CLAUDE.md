# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **Bot markdown**: lightweight formatter renders `\n`, `**bold**`, `*italic*` in bot messages. HTML escaped first for XSS safety.

## Repo & Hosting

- **GitHub repo:** https://github.com/darthPeter/chat-bubble
- **GitHub Pages:** https://darthpeter.github.io/chat-bubble/
- **Files:**
  - `widget.js` — core widget (663 lines, vanilla JS)
  - `demo.html` — test page
  - `themes/default.css`, `themes/digishares.css` — theme files
  - `workflows/` — n8n workflow JSON backups (secrets redacted)
  - `CHAT_BUBBLE_PLAN.md` — roadmap and plans
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
- Client key: `CLIENT_KEY` constant in Rate Limit node — validated per client_id
- Token TTL: 1800s (30 min), widget handles refresh via `tokenAboutToExpire`
- Session restore: `refresh: true` + `conversation_sid` skips conversation creation

### Message Handler (6 nodes)
```
Twilio Webhook → Is User Message? (If) → Extract Message Data (Code) → Call AI Webhook (HTTP) → Prepare Reply (Code) → Send Reply to Twilio (HTTP)
```
- If node filters Author != "bot" to prevent infinite reply loops
- AI is external: routes to client-specific webhook URL
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
- `__CLIENT_KEY__` — Client access key
- `__ACCOUNT_SID__`, `__API_KEY_SID__`, `__SERVICE_SID__` — Twilio identifiers
- `__AI_WEBHOOK_URL__` — Client AI webhook URL
- `__CREDENTIAL_ID__`, `__CREDENTIAL_NAME__` — n8n credential references

## Detailed Plan & TODO

See `CHAT_BUBBLE_PLAN.md` for multi-client architecture plan, post-conversation webhook plan, and current TODO.
