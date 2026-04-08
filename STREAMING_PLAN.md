# Real-Time Streaming — Architecture Plan

> **Status:** Planning — not yet approved for implementation
> **Date:** 2026-04-08
> **Prerequisite:** Current simulated streaming (word-by-word reveal) is live and working

---

## Goal

Stream AI response tokens to the widget in real-time as the AI brain generates them, instead of waiting for the full response. Gives users immediate feedback and a more conversational feel.

## Current Architecture (No Streaming)

```
Widget → Twilio WS → Message Handler → AI Brain (waits 5-45s) → full response
                                        Message Handler → Twilio API → Widget
```

- Widget shows typing dots while waiting
- Full message arrives at once, then simulated word-by-word reveal (35ms/word)
- Works well, but long AI responses (with tool calls) create 10-45s of dead air

## Proposed Architecture: Hybrid Sideband Streaming

```
┌─────────┐    Twilio WS     ┌──────────────┐
│  Widget  │◄────────────────►│    Twilio     │
│          │                  │ Conversations │
│          │    SSE stream    └──────┬────────┘
│          │◄──────────────┐        │ webhook
└────┬─────┘               │        ▼
     │                 ┌───┴─────────────────┐
     │    Twilio msg   │  Message Handler    │
     └────────────────►│  (n8n)              │
                       │  1. Receive msg     │
                       │  2. Call AI brain   │
                       │     (streaming ON)  │
                       │  3. Relay tokens    │──► SSE Endpoint ──► Widget
                       │     to SSE endpoint │    (real-time)
                       │  4. Collect full    │
                       │     response        │
                       │  5. Guardrails on   │
                       │     full response   │
                       │  6. Send via Twilio │──► Twilio ──► Widget
                       └─────────────────────┘    (final, for history)
```

### Key Principle

**Twilio stays the source of truth.** Streaming is a progressive UX enhancement. The full message is ALWAYS sent via Twilio for persistence, history, agent dashboard. If SSE fails, the user still gets the message — just sees typing dots longer.

## Why SSE (Not WebSocket)

| Factor | SSE | WebSocket |
|---|---|---|
| Direction | Server → Client (exactly what token streaming needs) | Bidirectional (overkill) |
| Reconnection | Built-in (`EventSource` auto-reconnects) | Must implement manually |
| Proxies/CDNs | Works through standard HTTP infrastructure | Can be blocked |
| Complexity | Simple HTTP endpoint | Upgrade handshake, stateful |
| Industry standard | ChatGPT, Claude API, Gemini all use SSE | N/A for AI streaming |

We already have WebSocket via Twilio for bidirectional messaging. SSE is only for the token streaming overlay.

## Backwards Compatibility

### Per-Client Opt-In (Routing Table)

```javascript
const ROUTING = {
  digishares: { webhookUrl: '...', streaming: false },  // unchanged
  alkoholcz:  { webhookUrl: '...', streaming: false },  // unchanged
  pompo:      { webhookUrl: '...', streaming: true },   // streams!
};
```

- `streaming: false` → current flow, zero code path changes
- `streaming: true` → Handler relays tokens to SSE + sends final via Twilio

### Per-Widget Opt-In (Script Tag)

```html
<script src="widget.js"
  data-webhook="..."
  data-streaming="true"
  ...
></script>
```

- No `data-streaming` → current behavior (typing dots → full message via Twilio)
- `data-streaming="true"` → opens SSE after sending, renders tokens live

### Graceful Degradation

```
Widget sends message
  → If data-streaming: try SSE connection
    → SSE works: render tokens live, replace with Twilio message when it arrives
    → SSE fails: fall back to typing dots, wait for Twilio message (current behavior)
  → If no data-streaming: typing dots → Twilio message (current behavior, unchanged)
```

## Components to Build

### 1. SSE Relay Endpoint (~50-100 lines)

n8n cannot serve SSE responses natively. Need a small sideband service.

**Options:**
- **Node.js server** (~80 lines) — simple Express/Hono app
- **Cloudflare Worker** (~60 lines) — serverless, auto-scaling, no infra
- **Deno Deploy** (~60 lines) — similar to CF Worker

**Responsibilities:**
- Accept SSE connections from widgets: `GET /stream/{conversationSid}`
- Accept token pushes from Message Handler: `POST /stream/{conversationSid}/push`
- Forward tokens to connected SSE clients
- Send `[DONE]` event when stream completes
- Auto-cleanup idle connections (30s timeout)
- Heartbeat (`: keepalive` every 15s to prevent proxy timeout)

**SSE event format:**
```
event: token
data: {"text": "Tady jsou"}

event: token
data: {"text": " skvělé Hot Wheels"}

event: done
data: {"conversationSid": "CHxxx"}
```

### 2. Message Handler Changes

For `streaming: true` clients:

```
Current:  Call AI Webhook (sync, wait for full response)
Streaming: Call AI Webhook (streaming mode)
           → Brain streams tokens → Handler pushes to SSE endpoint
           → Handler collects full response
           → Guardrails on full response
           → Send via Twilio API (same as now)
```

**n8n limitation:** n8n HTTP Request node waits for the full response — it cannot process a streaming response chunk by chunk. Options:
- **Option A:** AI brain pushes tokens directly to SSE endpoint (brain knows the conversationSid). Handler just triggers the brain and waits for completion.
- **Option B:** Use an n8n Code node with a custom streaming HTTP client (if n8n sandbox allows it — currently `fetch()` is NOT available in Code nodes).
- **Option C:** Move the streaming relay logic into the AI brain workflow itself.

**Recommended: Option A** — simplest, keeps Message Handler unchanged:

```
Message Handler → calls AI brain (passes conversationSid + SSE endpoint URL)
AI Brain:
  1. Opens streaming to LLM
  2. For each token: POST to SSE endpoint /stream/{convSid}/push
  3. Returns full response to Message Handler (as now)
Message Handler → guardrails → Twilio API (as now)
```

### 3. Widget Changes (~30 lines)

Add to `widget.js`:

```javascript
// In CFG:
streaming: scriptTag.hasAttribute("data-streaming"),
streamingEndpoint: scriptTag.getAttribute("data-streaming-endpoint") || "",

// After sending a message (in sendMessage):
if (CFG.streaming && CFG.streamingEndpoint) {
  startSSEStream(conversationSid);
}

// SSE client:
function startSSEStream(convSid) {
  const el = document.createElement("div");
  el.className = "cb-msg bot";
  messagesEl.insertBefore(el, typingEl);

  const source = new EventSource(`${CFG.streamingEndpoint}/stream/${convSid}`);
  let fullText = "";

  source.addEventListener("token", (e) => {
    const data = JSON.parse(e.data);
    fullText += data.text;
    el.innerHTML = formatBotMessage(fullText);
    scrollToBottom();
  });

  source.addEventListener("done", () => {
    source.close();
    // Twilio message will arrive and reconcile
  });

  source.onerror = () => {
    source.close();
    // Fall back — Twilio message will arrive normally
    if (!fullText) el.remove(); // remove empty element
    showTyping(true);
  };
}
```

The existing `streamBotText()` async generator pattern is already designed for this swap. The `messageAdded` handler would detect if the message was already streamed (by matching `conversationSid`) and skip re-rendering.

### 4. Send Button Disable (~5 lines)

```javascript
// In sendMessage():
btnSend.disabled = true;
inputEl.disabled = true;

// On stream complete or Twilio message received:
btnSend.disabled = !inputEl.value.trim();
inputEl.disabled = false;
```

## Concurrent Messages — Edge Cases

### User Sends Second Message During Streaming

**Frontend prevention (primary):**
- Disable send button + input while bot is streaming
- Re-enable when stream completes or Twilio message arrives
- This is what ChatGPT, Claude.ai, and all major AI chats do

**Backend safety net (secondary):**
- If a second message somehow arrives during an active stream:
  1. Queue it (per conversationSid, store in memory)
  2. Finish current stream
  3. Process queued message
  4. Timeout: if stream doesn't complete in 60s, force-finish and process queue

### User Sends Rapid-Fire Messages (Before Bot Responds)

- First message triggers AI processing
- Subsequent messages arrive as Twilio messages (normal)
- Message Handler receives them via webhook, but AI is still processing first
- **Solution:** Per-conversation debounce/lock in Message Handler:
  - If conversation has active AI processing, queue incoming messages
  - Or: batch rapid messages into one combined message before AI call

### "Stop Generating" (Future Enhancement)

- Widget shows a "Stop" button during streaming
- Click: closes SSE, sends cancel signal to backend
- Partial response stays visible (or is discarded)
- User can type next message
- Nice to have, not required for v1

## Connection Management

### Lazy SSE Connections

- Do NOT open SSE when widget loads
- Open only after user sends a message (when expecting a response)
- Close after stream completes + 30s idle timeout
- Reopen on next message

### Connection Drops

- `EventSource` auto-reconnects (built-in browser behavior)
- If SSE drops mid-stream: widget falls back to typing dots
- Twilio message arrives regardless → user gets the response
- No data loss, no special recovery logic needed

### Multiple Tabs

- Each tab opens its own SSE connection (simplest)
- Both tabs receive the same stream
- Both tabs receive the Twilio message
- No cross-tab coordination needed (optimize later if scale requires it)

### Heartbeat

- SSE endpoint sends `: keepalive\n\n` comment every 15s
- Prevents proxies/load balancers from closing "idle" connections

## Implementation Order

| Step | What | Effort | Dependencies |
|---|---|---|---|
| 1 | SSE relay endpoint (Node.js or CF Worker) | 1-2 days | Hosting decision |
| 2 | AI brain modifications (push tokens to SSE endpoint) | 1 day | Step 1 |
| 3 | Widget SSE client + `data-streaming` attribute | 0.5 day | Step 1 |
| 4 | Message Handler routing flag (`streaming: true/false`) | 0.5 day | None |
| 5 | Send button disable during streaming | 0.5 day | Step 3 |
| 6 | Test with Pompo (first streaming client) | 0.5 day | Steps 1-5 |
| 7 | "Stop generating" button | 0.5 day | Optional, later |

**Total estimated effort: 3-5 days**

## Product Cards + Streaming

When the AI returns `[product]` blocks in a streaming response:
- Tokens stream normally until `[product]` marker appears
- Widget buffers tokens between `[product]` and `[/product]`
- Once `[/product]` is received, render the complete card
- Text after the card continues streaming normally

This requires a streaming-aware parser that detects partial `[product]` blocks and buffers them instead of rendering raw markers. The current `parseProductCards()` function works on complete text — for streaming, a stateful parser would be needed (~30 lines).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| SSE endpoint downtime | No streaming, typing dots instead | Twilio message always arrives (graceful degradation) |
| n8n can't stream to SSE endpoint | Architecture doesn't work | Use Option A: AI brain pushes tokens directly |
| Token latency through relay | Sluggish streaming feel | SSE relay is ~1-5ms overhead, negligible |
| AI brain timeout (60s) | Long streams | Already handled — timeout set to 60s |
| CORS on SSE endpoint | Widget can't connect | Configure CORS headers on SSE endpoint |
| Browser SSE limit (6 per domain HTTP/1.1) | Multiple tabs fail | Use HTTP/2 (multiplexed) or separate subdomain |

## Decision Log

- **2026-04-08:** Plan created. Simulated streaming (word-by-word) is live. Real streaming deferred — evaluate after Pompo v1.5 stabilizes.
