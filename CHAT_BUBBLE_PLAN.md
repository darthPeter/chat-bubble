# Chat Bubble — Plans & TODO

## Multi-Client Architecture

### Problem

Currently, the Token Endpoint has a single hardcoded `CLIENT_KEY` and the Message Handler has a single hardcoded AI webhook URL. Adding a new client means duplicating workflows. This doesn't scale and creates maintenance burden.

### Solution: Shared Workflows with Client Routing

One `widget.js`, one Token Endpoint, one Message Handler — with client config routing tables. Each client gets only: a theme CSS file, a test page, and entries in the routing config.

### Widget Changes

1. **New attribute** `data-client-id` (e.g., `"digishares"`, `"clientB"`) — identifies the client
2. **Identity format** changes from `user_{uuid}` to `{clientId}_user_{uuid}` — carries client context through Twilio
3. **Session storage key** namespaced: `cb_session_{clientId}` — prevents conflicts when test pages share GitHub Pages origin
4. **Token request** sends `client_id` alongside `client_key` in POST body
5. **Backwards compatibility**: identity without prefix (`user_xxx`) treated as `digishares` during migration

### Token Endpoint Changes

Replace single `CLIENT_KEY` constant with a **client config table** in the Rate Limit & Validate node:

```javascript
const CLIENTS = {
  digishares: { key: '7a7434cd...' },
  clientB:    { key: 'abc123...'   },
  clientC:    { key: 'def456...'   },
};

// Parse client_id from request body (sent by widget)
const clientId = webhookData.body?.client_id || '';
const clientConfig = CLIENTS[clientId];

if (!clientConfig) {
  return [{ json: { valid: false, error: 'Unknown client' } }];
}
if (clientConfig.key && clientKey !== clientConfig.key) {
  return [{ json: { valid: false, error: 'Invalid client key' } }];
}
```

Everything else (conversation creation, JWT generation) stays identical — it's already generic.

### Message Handler Changes

Add a **routing Code node** between Extract Message Data and Call AI Webhook:

```javascript
const ROUTING = {
  digishares: {
    webhookUrl: 'https://n8n.../webhook/digishares-ai',
    credential: 'DigiSharesChatbot',
  },
  clientB: {
    webhookUrl: 'https://n8n.../webhook/clientB-ai',
    credential: 'ClientBChatbot',
  },
};

// Parse client_id from author identity: "digishares_user_xxx" → "digishares"
const author = $json.author || '';
const clientId = author.includes('_user_') ? author.split('_user_')[0] : 'digishares';
const route = ROUTING[clientId];

if (!route) {
  return []; // Drop unknown client messages silently
}
```

Call AI Webhook node uses `{{ $json.webhookUrl }}` as dynamic URL.

### Per-Client Checklist

For each new client, create/configure:
- [ ] Theme CSS file: `themes/{clientId}.css`
- [ ] Test page: `demo-{clientId}.html`
- [ ] Client key: generate and add to Token Endpoint CLIENTS table
- [ ] AI webhook: n8n workflow or external endpoint
- [ ] Auth credential: httpHeaderAuth in n8n (if AI webhook needs auth)
- [ ] Routing entry: add to Message Handler ROUTING table
- [ ] Script tag for client website with all `data-*` attributes

### Data Isolation

| Layer | How | Risk |
|---|---|---|
| **Twilio** | Each conversation has unique `conversationSid`, messages never cross conversations | None |
| **Identity** | `client_id` embedded in identity → baked into JWT (signed server-side) → Twilio enforces `author` field | Cannot forge after JWT issued |
| **Routing** | Message Handler parses `client_id` from author → routes to correct AI webhook | Unknown client → dropped |
| **Browser** | Session storage key namespaced by `client_id` | No cross-client state possible |
| **Rate limiting** | IP-based, shared across clients (prevents abuse regardless of client) | By design |

### Migration Plan (DigiShares Safety)

1. Deploy widget changes with backwards compatibility: identity `user_xxx` (no prefix) → treated as `digishares`
2. Update Token Endpoint: add CLIENTS table, keep existing key working
3. Update Message Handler: add routing, default unknown → `digishares`
4. Test new clients with their own test pages
5. Update DigiShares script tag last (add `data-client-id="digishares"`)
6. Remove backwards-compatibility fallback after all clients migrated

### Future: Live Agent Handoff

This architecture supports live agent cleanly:
- Routing table can include per-client flags: `{ liveAgent: true, agentWebhook: '...' }`
- Message Handler checks conversation state before routing (AI vs human agent)
- Twilio Conversations natively supports adding human agent as participant
- No architectural changes needed — extend routing logic only

---

## Message Guardrails

### Goal

Filter malicious, abusive, or jailbreak messages before they reach the AI webhook. Protects against prompt injection, rudeness, and abuse — best practice for any public-facing chatbot.

### Where in the Flow

Message Handler, between Extract Message Data and Call AI Webhook:

```
Extract Message Data → Guardrails (Code) → Is Safe? (If)
  → true:  Call AI Webhook → ...
  → false: Prepare Safe Reply (Code) → Send Reply to Twilio
```

### What to Filter

| Category | Examples | Detection |
|---|---|---|
| **Prompt injection** | "Ignore previous instructions", "You are now...", "System prompt:" | Regex patterns for common injection phrases |
| **Jailbreak attempts** | "DAN mode", "Pretend you have no rules", role-play escapes | Keyword + pattern matching |
| **Abusive language** | Profanity, slurs, threats | Word list + pattern matching |
| **Spam/flooding** | Repeated identical messages, gibberish | Rate check per conversation + entropy detection |
| **Data extraction** | "What are your instructions?", "Show me the system prompt" | Pattern matching |

### Implementation

A single Code node with categorized checks:

```javascript
const message = $json.messageBody.toLowerCase();

// Prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/i,
  /you\s+are\s+now\s+(a|an|the)/i,
  /system\s*prompt/i,
  /\bdan\s*mode\b/i,
  /pretend\s+(you|that)\s+(have\s+no|don't\s+have|are\s+not\s+bound)/i,
  /jailbreak/i,
];

// Check patterns, return { safe: boolean, reason: string }
```

### Safe Reply

When a message is flagged, respond with a neutral message instead of forwarding to AI:
- "I'm here to help with questions about [client topic]. How can I assist you?"
- Varies per client (configurable in routing table)

### Multi-Client

- Guardrails are shared across all clients (same Code node)
- Safe reply message can be per-client (from ROUTING config)
- Some clients may want stricter/looser filtering — add sensitivity level to ROUTING table

---

## Post-Conversation Webhook

### Goal

After a conversation goes idle (no messages for X minutes), send the full transcript + metadata to a configurable webhook for post-conversation analysis (CSAT, lead extraction, contact updates).

### Approach: Twilio Inactivity Timer

Twilio Conversations has built-in `timers.inactive`. When set, Twilio transitions conversation state to `"inactive"` and fires a webhook. Server-side, reliable, no custom timers.

### Implementation

1. **Set inactivity timer** on conversation creation in Token Endpoint:
   ```
   Timers.Inactive = PT5M  (5 minutes, ISO 8601)
   ```

2. **Add webhook filter** to Twilio Service: `onConversationStateUpdated` → new n8n endpoint

3. **New n8n workflow** — "Chat — Post-Conversation Analysis":
   ```
   Twilio Webhook → Is Inactive? (If) → Fetch Transcript (HTTP) → Format (Code) → Send to Analysis Webhook (HTTP)
   ```

4. **Payload to analysis webhook:**
   ```json
   {
     "conversation_sid": "CHxxx...",
     "client_id": "digishares",
     "started_at": "2026-03-03T10:00:00Z",
     "ended_at": "2026-03-03T10:12:00Z",
     "message_count": 8,
     "transcript": [
       { "author": "user_abc", "body": "Hi...", "timestamp": "..." },
       { "author": "bot", "body": "Hello!...", "timestamp": "..." }
     ]
   }
   ```

5. **Multi-client**: analysis webhook URL in per-client routing config

---

## TODO

- [x] **Multi-client architecture** — shared routing deployed (2026-03-12)
- [x] **Message guardrails** — prompt injection, jailbreak, abuse filtering (deployed 2026-03-12)
- [ ] **New client onboarding** — theme + test page + routing for 2 new clients
- [ ] **Post-conversation webhook** — Twilio inactivity timer + transcript workflow
- [ ] **(Future) Live agent handoff** — add human participant, pause bot routing
