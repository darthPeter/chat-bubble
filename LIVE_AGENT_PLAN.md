# Live Agent Handoff — Architecture & Plan

> **Status:** Planning (not part of the project yet)
> **Date:** 2026-03-14
> **Last revised:** 2026-03-14 — replaced Slack approach with direct Twilio SDK agent dashboard

---

## The Idea

When the AI can't help (or the user explicitly asks), hand the conversation to a real human agent. The agent chats with the user through the same chat bubble — the user doesn't notice any difference in UI.

---

## Agent Backend Evaluation

The original proposal defaulted to Slack. After comparing alternatives against our existing stack, a **simple agent dashboard page** (`agent.html`) using Twilio SDK directly is both simpler and more capable.

### Why Not Slack?

Slack introduces two translation hops on every message and requires significant infrastructure:

```
With Slack:
  User → Twilio → n8n webhook → forward to Slack thread → agent replies
  Agent → Slack Events API → n8n bridge workflow → Twilio REST API → User

  Requires: Slack app, Events API, Interactive Components, 2 new n8n workflows,
            thread↔conversation mapping, Slack retry handling
```

| Issue | Detail |
|---|---|
| 2 new n8n workflows | Slack→Twilio bridge + Resolve handler |
| Third-party dependency | Slack app setup (Events API, Interactive Components, bot tokens) |
| Message delay | ~1-3s per hop (event webhooks, not WebSocket) |
| Thread management | Must map Slack threads ↔ Twilio conversations |
| Free tier limit | 90-day message history |
| Scaling | Gets noisy past ~10-20 concurrent chats |
| Code reuse | 0% from widget.js |

### Why Not WhatsApp?

WhatsApp via Twilio Conversations is technically possible (Twilio supports WhatsApp participants natively), but:

| Issue | Detail |
|---|---|
| Approval process | WhatsApp Business API requires Facebook Business verification |
| Testing only | Twilio WhatsApp Sandbox limited to pre-registered numbers |
| No rich UI | No buttons, no conversation list, no "resolve" action — text commands only |
| Multi-conversation | Unmanageable on a phone for multiple concurrent chats |
| Costs | Per-message pricing |
| Session window | 24-hour limit on outbound messages |

### Why Agent Dashboard (agent.html)?

**Key insight:** We already use Twilio Conversations SDK in `widget.js` with ~80% reusable code. The agent connects to the **same Twilio Conversation** as the user — no bridge, no translation.

```
With agent.html:
  User → Twilio (WebSocket) → Agent sees it instantly (WebSocket)
  Agent → Twilio (WebSocket) → User sees it instantly (WebSocket)

  Requires: one HTML file on GitHub Pages. That's it.
```

| Advantage | Detail |
|---|---|
| 0 new n8n workflows | No bridge needed — both sides use Twilio SDK |
| 0 third-party dependencies | Uses Twilio (already have it) + GitHub Pages (already have it) |
| Real-time | WebSocket both directions, same as user experience |
| ~80% code reuse | SDK loader, client creation, token refresh, events — all from widget.js |
| Full UI control | Build exactly what's needed (conversation list, resolve button, notifications) |
| Production path | This IS the dashboard — evolve it, don't replace it |
| Mobile support | Responsive HTML works on phone browsers |

### Industry Confirmation

Every production system (Intercom, Zendesk, Crisp, Chatwoot, LiveChat, Twilio Flex) uses a **web dashboard** as the primary agent interface. Slack/WhatsApp are always optional secondary channels, never the core.

---

## How Twilio Conversations Enables This

### The Core Concept

A Twilio Conversation is a **shared message room**. Anyone added as a Participant receives all messages in real-time via WebSocket (SDK). No forwarding or bridging needed.

```
┌──────────┐     WebSocket      ┌─────────────────┐     WebSocket      ┌──────────┐
│  User    │◄──────────────────►│    Twilio        │◄──────────────────►│  Agent   │
│ (widget) │   participant #1   │  Conversation    │   participant #2   │ (agent   │
└──────────┘                    │                  │                    │  .html)  │
                                │  Messages []     │                    └──────────┘
                                │  Attributes {}   │
                                │  Participants [] │
                                └────────┬─────────┘
                                         │
                                         │ onMessageAdded webhook (still fires)
                                         ▼
                                ┌─────────────────┐
                                │  n8n Message     │
                                │  Handler         │
                                │                  │
                                │  mode="agent"?   │
                                │  → do nothing    │  ← agent already sees it via SDK
                                │  mode="ai"?      │
                                │  → existing flow │
                                └─────────────────┘
```

### Current State (AI mode)

- **User** = Twilio Participant (connected via SDK in widget.js)
- **Bot** = NOT a participant. Posts messages via REST API with `author: "bot"`. n8n Message Handler is the bot's brain.
- Only the user is connected via WebSocket. Bot replies arrive because Twilio delivers all messages to all participants.

### With Agent Handoff

- **User** = still a Participant (no change)
- **Agent** = added as Participant when handoff triggers. Connects via SDK in agent.html.
- **Bot** = muted. Message Handler sees `mode="agent"` and skips AI routing.
- Both user and agent are on WebSocket — messages are instant, bidirectional, native.

### Why This Is Simpler Than Slack

With Slack, every message crosses **two systems** (Twilio ↔ Slack) via n8n bridges. With the agent dashboard, **both sides are in the same Twilio Conversation**. Twilio IS the bridge.

```
Slack approach (per message):
  User types → Twilio stores → webhook → n8n → Slack API → Agent sees in Slack
  Agent types → Slack Events → webhook → n8n → Twilio API → User sees in widget
  = 4 hops, 2 API translations, ~2-3s latency

Dashboard approach (per message):
  User types → Twilio delivers via WebSocket → Agent sees in agent.html
  Agent types → Twilio delivers via WebSocket → User sees in widget
  = 0 hops, 0 translations, instant
```

---

## Architecture — The Full Picture

### Handoff Trigger (n8n Message Handler)

```
USER sends message in chat bubble
         |
         v
   +-----------+
   |  Twilio   |  webhook fires as usual
   +-----+-----+
         |
         v
   +------------------+
   | Message Handler   |  (existing workflow, modified)
   |                   |
   | 1. Is User Msg?   |  filter author != "bot" AND author != "agent_*"
   | 2. Extract Data   |
   | 3. Guardrails     |
   +--------+----------+
            |
            v
   +------------------+
   | FETCH MODE       |  NEW: GET /Conversations/{sid} → parse attributes.mode
   | (HTTP Request)   |
   +--------+---------+
            |
       +----+----+
       |         |
   mode="ai"  mode="agent"
       |         |
       v         v
   Existing    STOP         ← agent sees messages via SDK, no forwarding needed
   AI flow
       |
       v
   +------------------+
   | Check for        |
   | handoff trigger  |  keyword match OR AI returns { action: "handoff" }
   +--------+---------+
       |
  +----+----+
  |         |
normal   handoff
  |         |
  v         v
Send     +------------------+
reply    | TRIGGER HANDOFF  |
to       | 1. Update attrs  |  POST /Conversations/{sid} Attributes={"mode":"agent",...}
user     |    mode="agent"  |
         | 2. Add agent as  |  POST /Conversations/{sid}/Participants Identity="agent_support"
         |    participant   |
         | 3. Reply to user |  POST message: "Connecting you with support..."
         |   "Connecting..."|
         +------------------+
                  |
                  v
         Agent's Twilio SDK fires "conversationAdded" event
         → agent.html shows the new conversation automatically
```

### Agent Replies (No Bridge Needed)

```
AGENT sees new conversation in agent.html (via SDK "conversationAdded" event)
  → clicks conversation → sees full message history
  → types reply → sends via Twilio SDK (sendMessage)
  → Twilio delivers to User via WebSocket
  → User sees agent reply in chat bubble (looks same as bot messages)

Meanwhile:
  → Twilio webhook fires for agent's message too
  → Message Handler sees author = "agent_support"
  → Filtered out at "Is User Msg?" step → does nothing ✓
```

### Resolve (Agent Ends Handoff)

```
Agent clicks "Resolve" in agent.html
  → conversation.updateAttributes({ "mode": "ai", "last_handoff_resolved": "..." })
  → conversation.sendMessage("You're back with the AI assistant")
  → conversation.leave()   ← agent removes self as participant

Next user message → webhook → Message Handler → mode="ai" → AI handles it ✓
```

---

## Where Does the Logic Live?

### Twilio (cloud) — Transport + State

Twilio is the shared message room and state store:

| What | Where in Twilio | How |
|---|---|---|
| **Handoff state** | `Conversation.Attributes` (JSON) | `{ "mode": "ai" }` or `{ "mode": "agent", ... }` |
| **Chat history** | `Conversation.Messages` | All messages (user, bot, agent) stored automatically |
| **Participants** | `Conversation.Participants` | User always there. Agent added on handoff, removed on resolve. |
| **Real-time delivery** | WebSocket (SDK) | Both user and agent receive messages instantly |

**Twilio Conversation Attributes = the source of truth** for handoff state. Not n8n, not the dashboard. If any component goes down, the state is still in Twilio.

### n8n (server) — Brain + Routing

n8n makes the routing decision and triggers handoffs:

| What | Where in n8n | How |
|---|---|---|
| **Mode check** | Message Handler (new node) | HTTP GET to Twilio → read `attributes.mode` |
| **If mode="agent"** | Message Handler (new If node) | Skip AI routing entirely (agent sees it via SDK) |
| **Keyword detection** | Message Handler (new Code node) | Check message for "talk to human" etc. before AI |
| **AI handoff signal** | Message Handler (after AI response) | Check if AI returned `{ action: "handoff" }` |
| **Handoff trigger** | Message Handler (new nodes) | Update attrs + add participant + notify user |

### agent.html (browser) — Agent Interface

The agent dashboard connects directly to Twilio:

| What | How |
|---|---|
| **Authentication** | Agent logs in → gets Twilio Access Token (from Agent Token Endpoint) |
| **Discover conversations** | `client.getSubscribedConversations()` — lists all active handoffs |
| **New handoff notification** | `client.on("conversationAdded")` — fires when agent is added as participant |
| **Read messages** | `conversation.getMessages()` + `conversation.on("messageAdded")` |
| **Send reply** | `conversation.sendMessage(text)` — delivered to user via WebSocket |
| **Resolve** | `conversation.updateAttributes(...)` + `conversation.leave()` |
| **Browser notifications** | `Notification API` — alert agent when new handoff arrives |

### widget.js (browser) — No Changes

The chat bubble doesn't know about handoff. It talks to Twilio via WebSocket. Whether the reply comes from AI (posted via REST API by n8n) or a human agent (sent via SDK from agent.html), it arrives the same way — as a new message in the conversation.

---

## Conversation Attributes — State Machine

```
                  user asks / AI escalates
    ┌─────┐      ───────────────────────>      ┌─────────┐
    │  ai │                                     │  agent  │
    │ mode│      <───────────────────────       │  mode   │
    └─────┘       agent clicks "Resolve"        └─────────┘
```

```json
// Normal (default — no attributes set means AI mode)
{ "mode": "ai" }

// Handoff triggered
{ "mode": "agent",
  "handoff_at": "2026-03-14T10:30:00Z",
  "handoff_reason": "user_requested",
  "client_id": "digishares" }

// Resolved, back to AI
{ "mode": "ai",
  "last_handoff_resolved": "2026-03-14T11:00:00Z" }
```

### Twilio API Calls

```
# Read conversation attributes (mode check — Message Handler)
GET /v1/Services/{ServiceSid}/Conversations/{ConversationSid}
→ response.attributes = '{"mode":"ai"}'

# Update attributes (trigger handoff — Message Handler)
POST /v1/Services/{ServiceSid}/Conversations/{ConversationSid}
Body: Attributes={"mode":"agent","handoff_at":"...","client_id":"..."}

# Add agent as participant (trigger handoff — Message Handler)
POST /v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Participants
Body: Identity=agent_support

# Post handoff message to user (trigger handoff — Message Handler)
POST /v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Messages
Body: Author=system&Body=Connecting you with support...
```

All using `conversations.dublin.ie1.twilio.com` (IE1 region).

---

## Handoff Triggers — When to Switch

### Layer 1: Keyword Detection (fast, in Message Handler)

```javascript
const HANDOFF_KEYWORDS = [
  /\b(talk|speak|connect)\s+(to|with)\s+(a\s+)?(human|person|agent|someone|real\s+person)/i,
  /\b(live|real|human)\s+(agent|support|person|chat)/i,
  /\bI\s+(want|need)\s+(a\s+)?(human|person|agent)/i,
  /\btransfer\s+(me\s+)?(to\s+)?(support|agent|human)/i,
];
```

Checked in Message Handler before AI routing. If matched → trigger handoff immediately (skip AI call).

### Layer 2: AI Escalation (smart, context-aware)

Add to the AI's system prompt:
> "If you cannot help the user, or if they seem frustrated and need human assistance, include `"action": "handoff"` in your JSON response."

After receiving AI response, check for the handoff flag in Prepare Reply node.

### Layer 3: Failure Counter (future)

Track consecutive "I don't know" responses in conversation attributes. After N failures → auto-handoff.

---

## Agent Online/Offline

### Phase 1: Testing (Simple)

Always accept handoff. Agent replies when available. If no reply in X minutes, auto-message via n8n scheduled check: "No agent is available right now. Let me continue helping you." → set mode back to "ai".

### Phase 2: Agent Status Flag

n8n static data stores `agentOnline: true/false`. Agent dashboard toggles it via a simple n8n webhook endpoint. Message Handler checks before attempting handoff. If agents offline → AI tells user.

### Phase 3: Dashboard Presence

Agent dashboard sends periodic heartbeat to n8n. If no heartbeat for 5 min → mark offline. More reliable than manual toggle.

---

## agent.html — What We'd Build

A single vanilla JS file hosted on GitHub Pages (same pattern as widget.js):

```
agent.html (~300-400 lines, no build step)
│
├── Auth Section
│   └── Simple login form → POST to Agent Token Endpoint → get Twilio Access Token
│
├── Sidebar (conversation list)
│   ├── client.getSubscribedConversations() → list active handoffs
│   ├── client.on("conversationAdded") → new handoff appears
│   ├── Each item shows: client_id, user identity, handoff time, last message preview
│   └── Unread indicator (conversation.getUnreadMessagesCount())
│
├── Chat View (selected conversation)
│   ├── conversation.getMessages(50) → load history
│   ├── conversation.on("messageAdded") → real-time messages
│   ├── Messages styled by author: user (left), bot (left, dimmed), agent (right)
│   └── Typing indicator: conversation.on("typingStarted")
│
├── Input
│   ├── Text input + send button
│   ├── conversation.sendMessage(text) → delivered to user via WebSocket
│   └── conversation.typing() → user sees typing indicator
│
├── Actions
│   ├── "Resolve" button → updateAttributes({mode:"ai"}) + leave() + notify user
│   └── "Back to AI" sends system message before resolving
│
└── Notifications
    └── Notification API → browser notification on new handoff (conversationAdded event)
```

### Reusable Code from widget.js

| Component | Reuse | Notes |
|---|---|---|
| SDK loader (`loadTwilioSDK()`) | 100% | Copy-paste |
| Client creation | 100% | Same `Client.create(token)` |
| Token refresh handler | 95% | Same `tokenAboutToExpire` event |
| Connection state monitoring | 95% | Same events, different UI |
| Message receiving | 85% | Remove author filter — agent sees all messages |
| Message sending | 90% | Same `sendMessage()` |
| Message history loading | 70% | Same paginator, different display |

### Agent Token Endpoint

New lightweight n8n workflow (or extension of existing Token Endpoint):

```
Agent Token Webhook → Validate Agent Credentials (Code) → Is Valid? (If)
  → true:  Prepare JWT (agent identity) → HMAC Sign → Return Token
  → false: Reject 403
```

- Agent credentials: simple shared secret or per-agent username/password (stored in n8n Code node)
- Identity: `agent_support` (shared) or `agent_{name}` (per-agent)
- Same JWT/HMAC pattern as existing Token Endpoint — significant code reuse
- No conversation creation — agent joins existing conversations via SDK

---

## n8n Changes — What We'd Modify/Build

### Modified: Message Handler (existing workflow)

Add nodes after Guardrails:

```
... Guardrails → Is Safe?
  → true: Fetch Conversation Attrs (HTTP GET to Twilio)
    → Parse Mode (Code)
    → Is Agent Mode? (If)
      → true: STOP (do nothing — agent communicates via SDK)
      → false: Check Handoff Keywords (Code)
        → keyword match: Trigger Handoff (Code+HTTP: update attrs, add participant, notify user)
        → no match: Route to Client → Call AI → Check AI Handoff Flag (Code)
          → handoff flag: Trigger Handoff
          → normal: Prepare Reply → Send to Twilio (existing)
```

New nodes needed: ~4-5 (Fetch Attrs, Parse Mode, Is Agent Mode?, Check Keywords, Trigger Handoff)

### Modified: Message Handler — Author Filter

Current: filters `Author != "bot"`
Updated: filters `Author != "bot" AND Author != "agent_*"` (prevent agent messages from triggering AI)

### New: Agent Token Endpoint (small workflow)

Simple webhook that validates agent credentials and returns a Twilio Access Token. Reuses JWT/HMAC logic from existing Token Endpoint.

### NOT Needed (eliminated by this architecture)

- ~~Slack → Twilio Bridge workflow~~ (agent uses SDK directly)
- ~~Resolve Handler workflow~~ (agent resolves via SDK)
- ~~Slack app setup~~ (no Slack dependency)

---

## Multi-Client Considerations

| Aspect | How |
|---|---|
| **Conversation list** | agent.html shows `client_id` from conversation attributes — agent sees which client each chat belongs to |
| **Agent assignment** | For testing: single `agent_support` identity, any agent sees all. Future: per-client agent pools |
| **Handoff message** | Per-client from ROUTING table in Message Handler: "Connecting you with DigiShares support..." |
| **Agent hours** | Per-client config possible in ROUTING table: `{ agentHours: "09:00-17:00 CET" }` |

---

## Future Evolution Path

Since agent.html IS the dashboard (not a temporary test), it evolves naturally:

| Phase | Add |
|---|---|
| **MVP** | Basic list + chat + resolve |
| **v2** | Customer context sidebar (conversation history, client info) |
| **v3** | Queue management, agent assignment, SLA timers |
| **v4** | Analytics (response time, resolution rate, handoff reasons) |
| **v5** | Optional Slack/WhatsApp notifications as secondary alert channel |

At no point do you "rip out" infrastructure. Each phase adds to the same page.

---

## Implementation Order (When We Start)

1. **Agent Token Endpoint** — new n8n workflow, validates agent creds, returns Twilio token
2. **Message Handler: mode check** — fetch conversation attributes, skip AI if mode="agent"
3. **Message Handler: author filter** — also filter agent messages (not just bot)
4. **Message Handler: keyword detection** — detect "talk to human" before AI routing
5. **Message Handler: handoff trigger** — update attrs + add participant + notify user
6. **agent.html: basic version** — auth, conversation list, chat view, send, resolve
7. **Test end-to-end** — one client, one agent, full roundtrip
8. **AI escalation** — add handoff flag to AI system prompt + check in Prepare Reply
9. **Online/offline** — basic timeout fallback (auto-resolve after X minutes)
10. **Browser notifications** — Notification API for new handoffs
