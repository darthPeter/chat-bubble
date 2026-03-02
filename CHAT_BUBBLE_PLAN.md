# Chat Bubble Widget — Project Plan

## Project Goal

Build a reusable, embeddable chat bubble widget hosted on GitHub Pages.
Any client website adds a single `<script>` tag to get a fully functional AI chat interface.
Backend is n8n. Real-time messaging via Twilio Conversations SDK (WebSocket).

---

## Architecture

```
Client Website
  └─ <script src="https://darthpeter.github.io/chat-bubble/widget.js"
             data-webhook="..." data-theme="digishares" data-title="...">
        │
        ├─ Renders chat bubble UI (bottom-right floating button)
        ├─ Loads theme CSS from themes/{name}.css (CSS custom properties)
        ├─ On open: calls n8n token endpoint → gets Twilio Access Token
        ├─ Connects to Twilio Conversations via WebSocket (JS SDK)
        └─ Sends/receives messages in real-time

Twilio Conversations (cloud)
  └─ onMessageAdded webhook → POST to n8n

n8n Workflows:
  1. Token endpoint: creates Conversation + User + returns Access Token
  2. Message handler: receives Twilio webhook → forwards to client AI webhook → reply via Twilio API
  3. (Future) Live agent: add human participant to Conversation, remove bot
```

---

## Reusability Design

One `widget.js`, configured entirely via script tag attributes:

| Attribute | Required | Description |
|---|---|---|
| `data-webhook` | yes | n8n webhook URL for this client's token endpoint |
| `data-theme` | optional | Theme name — loads `themes/{name}.css` |
| `data-color` | optional | Primary color override (on top of theme) |
| `data-title` | optional | Bot name in header (default: "Chat") |
| `data-logo` | optional | Avatar image URL in header |
| `data-client-key` | optional | Access key validated by n8n rate limiter |

New client = new theme CSS file + new n8n workflow + new script tag. No widget code changes.

---

## Current State

### Frontend — widget.js (662 lines)
- Shadow DOM (closed), no build step, Twilio SDK from CDN
- **Theming**: CSS custom properties (`--cb-*`), external theme files, `data-color` override
- **UX**: smooth auto-scroll (100px threshold), message slide-up animations, bouncing typing dots
- **Bot markdown**: renders `\n`, `**bold**`, `*italic*` (HTML escaped for XSS safety)
- **Welcome message**: sends `[system] generate welcome message` on new conversations
- **Session persistence**: `sessionStorage`, restores last 50 messages, new conversation button
- **Themes**: `themes/default.css` (blue), `themes/digishares.css` (navy/teal/Inter)

### n8n — Token Endpoint (`ODrNXQASOPNObSWd`)
11 nodes: `Webhook → Rate Limit & Validate → Is Valid? → Is Refresh? → (yes) Prepare JWT | (no) Create Conversation → Add Participant → Prepare JWT → HMAC Sign → Build Token Response → Return Token | Is Valid? false → Reject 403`

- Rate limiting: 10 conversations/IP/hour via `$getWorkflowStaticData('global')`
- Client key validation: `CLIENT_KEY` constant (empty = disabled)
- Token TTL: 1800s (30 min)
- Session restore: `refresh: true` + `conversation_sid` skips creation, reuses existing conversation

### n8n — Message Handler (`wnHbfZ7Djko2G4HZ`)
6 nodes: `Twilio Webhook → Is User Message? → Extract Message Data → Call AI Webhook → Prepare Reply → Send Reply to Twilio`

- Forwards to external client AI webhook (reusable transport layer)
- Payload: `{ conversationSid, message, author, messageSid }`
- Truncates messages over 2000 chars
- Auth: httpHeaderAuth credential `DigiSharesChatbot`

---

## How It Works

### Session Init (user opens chat)
1. Widget generates `user_<uuid>` identity (or restores from sessionStorage)
2. POST to token endpoint with `{ identity, client_key }` (new) or `{ identity, refresh: true, conversation_sid }` (restore)
3. n8n creates Twilio Conversation + participant (new), or skips creation (restore), generates JWT
4. Widget receives `{ token, conversation_sid }`, connects WebSocket
5. On new conversation: sends `[system] generate welcome message`
6. On restore: loads last 50 messages from Twilio history

### Messaging
1. User sends message via Twilio SDK (WebSocket)
2. Twilio fires `onMessageAdded` webhook → n8n Message Handler
3. n8n forwards to client AI webhook with `conversationSid` as session ID
4. AI response sent back to Twilio conversation via REST API
5. Widget receives bot reply instantly via WebSocket

### Why Two Separate Workflows
- **Token Endpoint**: called by browser, once per session, returns credentials
- **Message Handler**: called by Twilio (server-to-server), every message, processes AI

---

## Security

| Feature | Where | Details |
|---|---|---|
| Rate limit by IP | Token Endpoint | `$getWorkflowStaticData('global')`, max 10/IP/hour, refreshes bypass |
| Client key | Token Endpoint + widget | `CLIENT_KEY` constant, `data-client-key` attribute |
| Max message length | Message Handler | Truncates at 2000 chars before AI webhook |
| Token TTL | Token Endpoint | 1800s (30 min), widget auto-refreshes |
| Credentials server-side | n8n only | Twilio SID/Key/Secret never sent to browser |
| Shadow DOM | widget.js | Closed mode — host page can't access internals |
| CORS open | by design | Widget embeds on any domain; key + rate limit provide control |

---

## Credentials

| Value | Status |
|---|---|
| Twilio Account SID | Configured in n8n |
| Twilio API Key SID + Secret | Configured in n8n |
| Conversations Service SID (IE1) | Configured in n8n |
| Regional endpoint | `conversations.dublin.ie1.twilio.com` |
| DigiShares AI webhook auth | httpHeaderAuth credential in n8n |

---

## TODO

- ~~Update token endpoint to accept `conversation_sid` on refresh~~ ✅ Done (Is Refresh? branch skips creation)
- (Future) Live agent handoff: add human participant to Conversation, pause bot
