# Live Agent Handoff — Architecture & Plan

> **Status:** Brainstorming / Planning (not part of the project yet)
> **Date:** 2026-03-14

---

## The Idea

When the AI can't help (or the user explicitly asks), hand the conversation to a real human agent. The agent chats with the user through the same chat bubble — the user doesn't notice any difference in UI. For testing, use **Slack** as the agent backend (no custom dashboard needed).

---

## Is Slack a Good Idea?

**Yes, for small teams and testing.** Products like Chatwoot and Crisp use exactly this pattern. Here's the honest breakdown:

| Pros | Cons |
|---|---|
| Zero agent dashboard to build | No built-in queue management |
| Agents use a tool they already know | No SLA timers or response metrics |
| Mobile support (Slack app) | Gets noisy past ~10-20 concurrent chats |
| Notifications built in | No customer context sidebar |
| n8n has native Slack nodes | Slack free tier: 90-day message history |
| Fast to implement and test | Slack presence API unreliable for availability |

**Verdict:** Perfect for MVP/testing. When you outgrow it, swap Slack for a custom dashboard — the architecture below is designed for that.

---

## Industry Best Practices

### How Production Systems Do It

All major platforms (Zendesk, Intercom, Twilio Flex, LiveChat) follow the same pattern:

1. Bot handles conversation in **"bot mode"**
2. A trigger condition is met (user asks, AI gives up, sentiment drops)
3. Conversation metadata is updated → **"needs human"**
4. Routing system assigns to an available agent queue
5. Agent joins the conversation; bot is muted or assists
6. Agent resolves; conversation returns to bot mode or closes

### Two Architecture Models

**Bot-as-Agent** — The bot is registered alongside human agents in an agent hub. The hub handles all routing. Simpler, but less flexible.

**Bot-as-Proxy** (what we'd use) — The user always talks through our system. Our Message Handler decides whether to route to AI or to a human agent. We stay in control, can collect transcripts, inject messages, filter content for both sides.

---

## How It Works — The Full Picture

### Flow Chart

```
USER sends message in chat bubble
         |
         v
   +-----------+
   |  Twilio   |  (cloud — WebSocket to widget, webhook to n8n)
   | Conversa- |
   |   tions   |
   +-----+-----+
         |
         | onMessageAdded webhook
         v
   +------------------+
   | Message Handler  |  (n8n — existing workflow)
   |                  |
   | 1. Is User Msg?  |
   | 2. Extract Data  |
   | 3. Guardrails    |
   +--------+---------+
            |
            v
   +------------------+
   | CHECK MODE       |  <-- NEW: fetch Conversation Attributes from Twilio
   | (HTTP Request)   |      GET /Conversations/{sid} → parse attributes.mode
   +--------+---------+
            |
       +----+----+
       |         |
   mode="ai"  mode="agent"
       |         |
       v         v
  +--------+  +------------------+
  | Existing|  | Forward to Slack |  (post message to Slack thread)
  | AI flow |  | Thread           |
  | (Route  |  +------------------+
  | to      |
  | Client) |
  +----+----+
       |
       v
  +------------------+
  | AI Response      |
  | Check for        |
  | handoff signal   |  <-- AI can return { action: "handoff" }
  +--------+---------+
       |
  +----+----+
  |         |
 normal   handoff
  |         |
  v         v
 Send    +------------------+
 reply   | TRIGGER HANDOFF  |
 to      | 1. Fetch history |
 user    | 2. Post to Slack |
         | 3. Update attrs  |
         |    mode="agent"  |
         | 4. Reply to user |
         |   "Connecting..."|
         +------------------+
```

### Agent Replies Back (Slack → User)

```
AGENT types reply in Slack thread
         |
         v
   +-----------+
   |  Slack    |  Events API fires webhook
   |  Events   |
   +-----+-----+
         |
         v
   +------------------+
   | Slack → Twilio   |  (NEW n8n workflow)
   |                  |
   | 1. Parse thread  |
   | 2. Find convSid  |
   | 3. POST message  |
   |    to Twilio     |
   |    author="agent"|
   +------------------+
         |
         v
   +-----------+
   |  Twilio   |  delivers via WebSocket
   | Conversa- |
   |   tions   |
   +-----+-----+
         |
         v
   USER sees agent reply in chat bubble
   (looks same as bot messages)
```

---

## Where Does the Logic Live?

This is the key question. Here's exactly where each piece sits:

### Twilio (cloud) — Transport + State

Twilio doesn't know about "bot mode" or "agent mode". It's just a messaging pipe. But it stores our state:

| What | Where in Twilio | How |
|---|---|---|
| **Handoff state** | `Conversation.Attributes` (JSON) | `{ "mode": "ai" }` or `{ "mode": "agent", "slackTs": "..." }` |
| **Chat history** | `Conversation.Messages` | All messages (user, bot, agent) stored automatically |
| **Participants** | `Conversation.Participants` | User is always there. Optionally add agent as participant too. |
| **Conversation lifecycle** | `Conversation.State` | `active` / `inactive` / `closed` — managed by timers |

**Twilio's job:** Store messages, deliver them via WebSocket to the widget, fire webhooks to n8n. That's it. All routing decisions are ours.

### n8n (our server) — Brain + Routing

All the smart logic lives in n8n:

| What | Where in n8n | How |
|---|---|---|
| **Mode check** | Message Handler (new node) | HTTP GET to Twilio → read `attributes.mode` |
| **Keyword detection** | Message Handler (new node) | Check message for "talk to human" etc. |
| **AI handoff signal** | Message Handler (after AI response) | Check if AI returned `{ action: "handoff" }` |
| **Handoff trigger** | Message Handler (new nodes) | Fetch history, post to Slack, update Twilio attrs |
| **Forward to Slack** | Message Handler (new node) | HTTP POST to Slack `chat.postMessage` (in thread) |
| **Slack → Twilio bridge** | New workflow | Receives Slack events, posts to Twilio conversation |

### Slack (agent UI) — Human Interface

Slack is just the agent's screen:

| What | How |
|---|---|
| **New handoff notification** | Message posted to `#chatbot-support` with transcript + "Claim" button |
| **Ongoing conversation** | Thread in Slack — customer messages appear, agent replies |
| **Resolve** | Agent clicks "Resolve" button → triggers n8n webhook → sets mode back to "ai" |

### Widget (browser) — No Changes Needed

The chat bubble doesn't know about handoff at all. It talks to Twilio via WebSocket. Whether the reply comes from AI or a human agent, it arrives the same way — as a new message in the Twilio conversation.

---

## Twilio Deep Dive — How Conversations Work for This

### Participants

A Twilio Conversation can have multiple participants. Currently we have:
- **User** — added when conversation is created (identity: `alkoholcz_user_abc`)
- **Bot** — not actually a participant, it posts messages via REST API with `author: "bot"`

For agent handoff, we have two options:

**Option A: Agent as participant** — Add the human agent as a Twilio participant (`agent_jane`). They could connect via Twilio's SDK. But this requires building an agent UI that uses Twilio SDK. Overkill for testing.

**Option B: Agent via REST API (like the bot)** — Agent replies in Slack → n8n receives → posts to Twilio via REST API with `author: "agent"`. Same pattern as the bot. **This is what we'd do.**

### Conversation Attributes (State Machine)

The `attributes` field on a Conversation is a JSON string we control. We use it as our handoff state machine:

```
                  user asks / AI escalates
    ┌─────┐      ───────────────────────>      ┌─────────┐
    │  ai │                                     │  agent  │
    │ mode│      <───────────────────────       │  mode   │
    └─────┘       agent clicks "Resolve"        └─────────┘
```

```json
// Normal (default)
{ "mode": "ai" }

// Handoff triggered, waiting for agent
{ "mode": "agent", "handoff_at": "2026-03-14T10:30:00Z",
  "handoff_reason": "user_requested",
  "slack_thread_ts": "1710412200.001234",
  "slack_channel": "C07ABCDEF" }

// Resolved, back to bot
{ "mode": "ai", "last_handoff_resolved": "2026-03-14T11:00:00Z" }
```

### API Calls We'd Make

```
# Read conversation attributes (mode check)
GET /v1/Services/{ServiceSid}/Conversations/{ConversationSid}
→ response.attributes = '{"mode":"ai"}'

# Update attributes (trigger handoff)
POST /v1/Services/{ServiceSid}/Conversations/{ConversationSid}
Body: Attributes={"mode":"agent","slack_thread_ts":"..."}

# Fetch transcript (for Slack context)
GET /v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Messages?Order=asc&PageSize=50

# Post agent reply
POST /v1/Services/{ServiceSid}/Conversations/{ConversationSid}/Messages
Body: Author=agent&Body=Agent's reply text
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

Checked in Message Handler before AI routing. If matched → trigger handoff immediately.

### Layer 2: AI Escalation (smart, context-aware)

Add to the AI's system prompt:
> "If you cannot help the user, or if they seem frustrated and need human assistance, include `"action": "handoff"` in your JSON response."

After receiving AI response, check for the handoff flag in Prepare Reply node.

### Layer 3: Failure Counter (automatic, future)

Track consecutive "I don't know" responses in conversation attributes. After N failures → auto-handoff.

---

## Agent Online/Offline

### Phase 1: Testing (Simple)

Always accept handoff. Post to Slack. Agent replies when available. If no reply in X minutes, auto-message: "No agent is available right now. Let me continue helping you."

### Phase 2: Slack Presence Check

Before handoff, call Slack API `users.getPresence` for support team members. If all `away` → skip handoff, AI tells user agents aren't available.

### Phase 3: Toggle Command (Production-lite)

Slack slash command `/agent-status on|off` writes a flag to n8n static data. Message Handler checks before attempting handoff.

---

## Architecture for Future Custom Backend

The key design principle: **keep the agent backend swappable.**

### Agent Gateway Pattern

All handoff logic goes through an abstraction layer — the "Agent Gateway". Today it talks to Slack. Tomorrow it talks to a custom dashboard. The Message Handler doesn't care which.

```
Message Handler
  └─> needs handoff?
       └─> Agent Gateway (abstraction)
            ├─> Slack (today)
            ├─> Custom Dashboard (future)
            └─> Twilio Flex (future, if enterprise)
```

### Interface Contract

The Agent Gateway supports these operations (as n8n sub-workflows or webhook endpoints):

```
1. gateway.handoff(conversation_sid, transcript, customer_info, reason)
   → Creates a "ticket" in the agent backend
   → Returns { ticket_id, status }

2. gateway.forward(conversation_sid, message, author)
   → Forwards a customer message to the active ticket
   → Called on each message while mode="agent"

3. gateway.resolve(conversation_sid)
   → Called by agent backend when agent clicks "Resolve"
   → Sets Twilio attributes back to mode="ai"
```

### What Changes When Swapping Backends

| Component | Changes? | Why |
|---|---|---|
| Widget (`widget.js`) | No | Doesn't know about handoff |
| Twilio setup | No | Same attributes schema, same webhooks |
| Message Handler routing | No | Still checks `attributes.mode`, still calls gateway |
| Agent Gateway | **Yes** | Swap Slack calls for dashboard API calls |
| Slack → Twilio workflow | **Replaced** | New: Dashboard → Twilio workflow |
| Agent UI | **Replaced** | Slack → Custom web dashboard |

### The Source of Truth

**Twilio Conversation Attributes = the source of truth** for handoff state. Not Slack, not the dashboard.

- If Slack goes down, the state is still in Twilio
- If you swap backends, the schema doesn't change
- Message Handler always checks Twilio, never queries the agent backend for state

---

## n8n Workflows — What We'd Build

### Modified: Message Handler (existing)

Add 3 new nodes:

```
... Guardrails → Is Safe?
  → true: Fetch Conversation (HTTP GET) → Parse Mode (Code)
    → mode="agent": Forward to Slack (HTTP) → done
    → mode="ai": Check Handoff Keywords (Code)
      → handoff: Trigger Handoff (Code+HTTP) → done
      → normal: Route to Client → Call AI → Check AI Handoff Flag
        → handoff: Trigger Handoff
        → normal: Prepare Reply → Send to Twilio
```

### New: Slack → Twilio Bridge

```
Slack Event Webhook → Is Thread Reply? (If) → Is Agent? (If, filter bot msgs)
  → Extract ConversationSid from thread (Code)
  → POST message to Twilio (HTTP, author="agent")
```

### New: Handoff Resolve Handler

```
Slack Interactive Webhook (button click) → Parse action (Code)
  → Update Twilio attributes: mode="ai" (HTTP)
  → Update Slack message: "Resolved" (HTTP)
  → Send message to user: "You're back with AI assistant" (HTTP → Twilio)
```

---

## Slack Setup Needed

1. **Slack App** with:
   - Bot token scopes: `chat:write`, `channels:read`, `users:read`
   - Events API subscription: `message.channels` (or Socket Mode)
   - Interactive components: request URL for button clicks
2. **Channel:** `#chatbot-support` (or per-client channels)
3. **n8n credentials:** Slack OAuth token or webhook URLs

---

## Multi-Client Considerations

| Aspect | How |
|---|---|
| **Slack routing** | One shared `#chatbot-support` channel with client tag in thread header, OR per-client channels (`#support-digishares`, `#support-alkoholcz`) |
| **Agent assignment** | For testing: any agent can claim any client. Future: per-client agent pools |
| **Handoff message** | Per-client from ROUTING table: "Connecting you with DigiShares support..." |
| **Agent hours** | Per-client config possible: `{ agentHours: "09:00-17:00 CET" }` |

---

## Implementation Order (When We Start)

1. **Slack app + channel setup** — create app, configure events API
2. **Message Handler: mode check** — fetch conversation attributes, route by mode
3. **Message Handler: keyword detection** — detect "talk to human"
4. **Handoff trigger** — fetch transcript, post to Slack, update Twilio attrs
5. **Slack → Twilio bridge** — new workflow for agent replies
6. **Resolve button** — Slack interactive message handler
7. **Test end-to-end** — one client, one agent, full roundtrip
8. **AI escalation** — add handoff flag to AI system prompt
9. **Online/offline** — basic timeout fallback
