# Live Agent Handoff — Architecture & Plan

> **Status:** In progress — Step 1 (agent.html) done, Step 2 (Agent Token Endpoint) next
> **Date:** 2026-03-14
> **Last revised:** 2026-03-15 — agent.html built, added per-client agent isolation + AGENTS config table

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
   | Read agentOnline |  from $getWorkflowStaticData('global')
   | from static data |
   +--------+---------+
            |
            v
   Existing AI flow:
   Route to Client → Call AI Webhook (with agentAvailable param)
       |
       v
   +------------------+
   | Check AI response|  AI returns { action: "handoff" } ?
   | for handoff flag |  AND agentOnline is true?
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

## Handoff Triggers — AI Is the Sole Decision Maker

**No keyword detection in Message Handler.** The client AI brain decides when to hand off, based on full conversation context. This is simpler (fewer nodes in Message Handler) and smarter (AI understands nuance, frustration, context — not just regex patterns).

### How It Works

1. Message Handler passes `agentAvailable: true/false` to the client AI webhook (alongside the message)
2. The AI system prompt includes handoff instructions:
   > "You have access to a live agent handoff feature. The `agentAvailable` parameter tells you whether a human agent is currently online.
   > - If the user needs human help AND `agentAvailable` is true: include `"action": "handoff"` in your response
   > - If the user needs human help AND `agentAvailable` is false: tell the user that live support is not available right now and suggest trying during working hours
   > - Use your judgement: explicit requests ('talk to a human'), repeated failures, frustrated users, or questions outside your knowledge are all valid handoff reasons"
3. Message Handler checks AI response for the handoff flag in Prepare Reply node
4. If `action: "handoff"` → trigger handoff (update attrs, add agent participant, notify user)
5. If normal response → send reply as usual

### Why No Keyword Detection

- AI has full conversation context — understands "I'm done with this bot" without matching a regex
- AI respects `agentAvailable` — won't trigger handoff when agent is offline, instead responds gracefully
- Fewer nodes in Message Handler = simpler workflow
- One decision maker, not two competing layers
- AI can handle nuanced cases that keywords miss (frustration, repeated confusion, off-topic questions)

### Future: Failure Counter (automatic)

Track consecutive low-confidence responses in conversation attributes. After N failures → AI auto-escalates. This is an enhancement to the AI prompt, not a separate detection layer.

---

## Agent Online/Offline

### How It Works

The agent dashboard (`agent.html`) has an **on/off toggle**. This controls whether the AI is allowed to trigger handoffs.

```
agent.html toggle ON/OFF
  → POST /webhook/agent-status { online: true/false }
  → n8n stores in $getWorkflowStaticData('global').agentOnline

Message Handler (every message):
  → reads agentOnline from static data
  → passes agentAvailable: true/false to client AI webhook
  → AI decides based on context + availability
```

**Two layers of enforcement:**
1. **AI layer (primary):** AI knows `agentAvailable` status. If false, it tells users "agents aren't available, try during working hours" instead of triggering handoff. The AI handles this gracefully in context.
2. **Message Handler layer (safety net):** Even if AI mistakenly returns `action: "handoff"` while `agentOnline` is false, Message Handler ignores the handoff flag and sends the AI's text reply only.

### Agent Status Endpoint

Simple n8n webhook (can be a new workflow or added to Token Endpoint):

```
POST /webhook/agent-status
Body: { "secret": "agent_password", "online": true }
→ Validate secret
→ $getWorkflowStaticData('global').agentOnline = true/false
→ Return { status: "ok", online: true/false }
```

### Future: Auto-Offline

- Timeout: if agent.html sends no heartbeat for X minutes → auto-set offline
- Per-client hours: ROUTING table could include `agentHours: "09:00-17:00 CET"` for automatic scheduling

---

## agent.html — What We'd Build

A single vanilla JS file hosted on GitHub Pages (same pattern as widget.js):

```
agent.html (~300-400 lines, no build step)
│
├── Auth Section
│   └── Simple login form → POST to Agent Token Endpoint → get Twilio Access Token + allowed clients list
│
├── Online/Offline Toggle
│   ├── Toggle switch in header → POST to /webhook/agent-status { online: true/false }
│   └── Visual indicator: green "Online" / grey "Offline"
│
├── Sidebar (conversation list)
│   ├── client.getSubscribedConversations() → list active handoffs
│   ├── client.on("conversationAdded") → new handoff appears
│   ├── Filter: only show conversations where attributes.client_id ∈ allowedClients
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
  → true:  Prepare JWT (agent identity) → HMAC Sign → Return Token + allowed clients
  → false: Reject 403
```

- Agent credentials: per-agent username/password stored in `AGENTS` config table in Code node
- Identity: `agent_{username}` (per-agent, unique)
- Each agent has `clients: ["digishares"]` or `clients: ["alkoholcz"]` — list of assigned client_ids
- Token response includes `{ token, identity, region, clients: [...] }` — agent.html uses this to filter conversations
- Same JWT/HMAC pattern as existing Token Endpoint — significant code reuse
- No conversation creation — agent joins existing conversations via SDK

#### AGENTS Config Table (in Code node)

```javascript
const AGENTS = {
  "jan":    { password: "...", clients: ["digishares"], name: "Jan" },
  "petra":  { password: "...", clients: ["alkoholcz"], name: "Petra" },
  "admin":  { password: "...", clients: ["digishares", "alkoholcz"], name: "Admin" },
};
```

- Each client's employees only see their own conversations
- An admin/super-agent can be assigned to multiple clients
- Easy to add new agents — just add a row to the table

---

## n8n Changes — What We'd Modify/Build

### Modified: Message Handler (existing workflow)

Add nodes after Guardrails:

```
... Guardrails → Is Safe?
  → true: Fetch Conversation Attrs (HTTP GET to Twilio) → Parse Mode + Agent Status (Code)
    → Is Agent Mode? (If)
      → true: STOP (do nothing — agent communicates via SDK)
      → false: Route to Client → Call AI (with agentAvailable param) → Check AI Handoff Flag (Code)
        → handoff AND agentOnline: Trigger Handoff (Code+HTTP: update attrs, add participant, notify user)
        → normal: Prepare Reply → Send to Twilio (existing)
```

New nodes needed: ~3-4 (Fetch Attrs, Parse Mode + Status, Is Agent Mode?, Trigger Handoff)

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

## Multi-Client Agent Isolation

Each client (DigiShares, Alkohol.cz, etc.) has their own agents/employees. Agents must only see conversations belonging to their assigned client(s).

### How It Works

```
Agent logs in → Token Endpoint validates credentials → returns allowed clients list
  → agent.html stores allowedClients = ["digishares"]
  → On conversationAdded: check conversation attributes.client_id
    → if client_id ∈ allowedClients → show in sidebar
    → if client_id ∉ allowedClients → ignore (shouldn't happen, but safety net)

Handoff trigger (Message Handler):
  → When AI triggers handoff, adds agent as participant
  → Which agent? Uses client_id to pick the right agent identity
  → agentOnline status is per-client (not global)
```

### Per-Client Agent Status

The `agentOnline` flag in n8n static data becomes per-client:

```javascript
// n8n $getWorkflowStaticData('global')
{
  agentOnline: {
    "digishares": true,   // DigiShares agent is online
    "alkoholcz": false    // Alkohol.cz agent is offline
  }
}
```

Message Handler reads `agentOnline[client_id]` and passes the correct `agentAvailable` to the AI webhook.

Agent Status Endpoint receives `{ identity, online, client_id }` — updates per-client status.

### Handoff — Which Agent Gets the Conversation?

For MVP: one shared identity per client (e.g., `agent_digishares`, `agent_alkoholcz`). All agents for that client share the identity and see the same conversations.

Future: per-agent identities (`agent_jan`, `agent_petra`) with a routing/assignment layer.

| Aspect | How |
|---|---|
| **Conversation list** | agent.html filters by `allowedClients` — agents only see their own client's conversations |
| **Agent identity** | MVP: `agent_{client_id}` (shared per client). Future: `agent_{username}` (per-agent) |
| **Handoff trigger** | Message Handler adds `agent_{client_id}` as participant based on conversation's client_id |
| **Handoff message** | Per-client from ROUTING table: "Connecting you with DigiShares support..." |
| **Agent hours** | Per-client config in ROUTING table: `{ agentHours: "09:00-17:00 CET" }` |
| **Online/offline** | Per-client in static data — DigiShares agent online doesn't affect Alkohol.cz |

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

## Post-Processing / Conversation Summary

The post-conversation webhook (planned separately in `CHAT_BUBBLE_PLAN.md`) is **fully compatible** with live agent conversations. All messages — user, bot, and agent — live in the same Twilio Conversation.

When fetching the transcript (`GET /Conversations/{sid}/Messages`), every message has an `author` field:
- `alkoholcz_user_xxx` → user message
- `bot` → AI response
- `agent_support` → live agent response
- `system` → handoff notifications ("Connecting you with support...")

The summary workflow can distinguish AI vs human portions: "AI handled the first 5 messages, then a human agent resolved the issue." No changes needed to the post-processing workflow — it just reads richer transcripts.

---

## Implementation Order

| Step | What | Status |
|---|---|---|
| 1 | **agent.html** — dashboard page: login, conversation list, chat, resolve, on/off toggle, browser notifications, demo mode (`?demo`), per-client filtering via `allowedClients` | **DONE** (2026-03-15) |
| 2 | **Agent Token Endpoint** — n8n workflow `Dv0ZfV2HELCw7Ske`: AGENTS config table, validates creds, returns Twilio token + `clients` list | **DONE** (2026-03-15) |
| 3 | **Agent Status Endpoint** — webhook to toggle per-client `agentOnline` in n8n static data | **NEXT** |
| 4 | **Message Handler changes** — mode check (fetch attrs, skip AI if mode="agent"), author filter (also filter agent_*), pass per-client `agentAvailable` to AI, handoff trigger (check AI response for `action: "handoff"`, update attrs + add participant) | Not started |
| 5 | **Wire up** — AI system prompt with handoff instructions + agentAvailable logic, end-to-end test | Not started |

### Future enhancements (after MVP)
- Timeout fallback: auto-resolve if agent doesn't respond within X minutes
- Per-agent identities with routing/assignment layer
- Agent hours: per-client `agentHours` in ROUTING table for automatic scheduling
