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
  1. Token endpoint: creates Conversation + User + returns Access Token
  2. Message handler: receives Twilio webhook → AI processing → reply via Twilio API
```

## Key Design Decisions

- **No build step**: `widget.js` is a single vanilla JS file, no bundler, no framework
- **Shadow DOM**: recommended for CSS isolation from host page
- **Twilio SDK loaded dynamically** from CDN at runtime
- **Configuration via `data-*` attributes**: `data-webhook`, `data-theme`, `data-color`, `data-title`, `data-logo`, `data-client-key`
- **Theming system**: External CSS files in `themes/` loaded via `data-theme` attribute. CSS custom properties (`--cb-*`) on `:host`. `data-color` overrides primary color on top of any theme.
- **New client = new theme file + new n8n workflow + new script tag** — no widget code changes needed
- **Not SaaS**: each deployment is independent, no multi-tenancy
- **Separation of concerns**: chat bubble = reusable transport layer, client project = AI brain with knowledge base. Message Handler forwards to external client webhook instead of containing AI directly
- **Smart scroll**: auto-scrolls only when user is near bottom (100px threshold); always scrolls for own messages. Typing indicator shown after send, hidden on bot reply.

## Repo & Hosting

- **GitHub repo:** https://github.com/darthPeter/chat-bubble
- **GitHub Pages:** https://darthpeter.github.io/chat-bubble/
- Files: `widget.js`, `demo.html`, `themes/default.css`, `themes/digishares.css`

## n8n Workflows

- **n8n instance:** `https://n8n.srv1104100.hstgr.cloud`
- **Do not touch other n8n workflows**

| Workflow | ID | Webhook Path | Status |
|---|---|---|---|
| Chat — Token Endpoint | `ODrNXQASOPNObSWd` | `/webhook/chat-token` | Active, security hardened ✅ |
| Chat — Message Handler | `wnHbfZ7Djko2G4HZ` | `/webhook/chat-message` | Active, AI via client webhook ✅ |

### Token Endpoint structure (10 nodes)
```
Chat Token Webhook → Rate Limit & Validate (Code) → Is Valid? (If)
  → true: Create Conversation (HTTP) → Add Participant (HTTP) → Prepare JWT (Code) → HMAC Sign (Crypto) → Build Token Response (Code) → Return Token
  → false: Reject Request (Respond 403)
```
- Rate limiting: 10 conversations/IP/hour via `$getWorkflowStaticData('global')`, token refreshes bypass
- Client key: `CLIENT_KEY` constant in Rate Limit node — set per deployment, empty = skip validation
- Token TTL: 1800s (30 min), widget handles refresh via `tokenAboutToExpire`

### Message Handler structure (6 nodes)
```
Twilio Webhook → Is User Message? (If) → Extract Message Data (Code) → Call AI Webhook (HTTP) → Prepare Reply (Code) → Send Reply to Twilio (HTTP)
```

- Auth: Basic auth header in HTTP Request nodes (base64-encoded API Key SID:Secret)
- JWT: Built with Code node (header+payload) + n8n Crypto node (HMAC-SHA256) + Code node (assemble)
- If node filters Author ≠ "bot" to prevent infinite reply loops
- **AI is external**: Message Handler forwards to a client-specific webhook, keeping the chat bubble reusable
- Client webhook receives: `{ conversationSid, message, author, messageSid }`
- Client webhook returns: `{ output }` (also supports `reply`, `message`, `text` keys)
- `conversationSid` serves as session/thread ID for AI context across messages
- Auth credential `DigiSharesChatbot` (httpHeaderAuth) configured on Call AI Webhook node

## Twilio Setup

- **Region:** Ireland (IE1) — all API calls use `conversations.dublin.ie1.twilio.com`
- Conversations Service: "N8N Chatbot" (SID stored locally, not in repo)
- Service webhook: onMessageAdded → n8n Message Handler
- Account SID: stored locally, not in repo

## n8n Code Node Sandbox Limitations

These APIs are **NOT available** in n8n Code nodes:
- `require('crypto')` — disallowed
- `crypto.subtle` (Web Crypto API) — not defined
- `fetch()` — not defined

Use instead:
- **Crypto node** for hashing/HMAC (built-in n8n node, no credentials needed)
- **HTTP Request node** for external API calls
- `btoa()` and `TextEncoder` are available

## Detailed Plan & TODO

See `CHAT_BUBBLE_PLAN.md` for full architecture, security analysis, build progress, and step-by-step TODO.
