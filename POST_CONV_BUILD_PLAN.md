# Post-Conversation Analysis — Build Plan v2.2

**Status:** design corrected by Phase 0 empirical probes (2026-06-28). **Simpler** than v2.1 — Twilio's timer constraints made the old design illegal and pointed to a cleaner one. Ready for reviewer → build.

**Trigger:** Petr 2026-06-09 — "make it best-practice safe across all projects so we can just build." First real consumer: **eva-chat (LaDenta) Workflow B** — see `LaDenta/eva-chat/notes/handover-chatbot-2026-06-28.md`. Reply to that handover is deferred until this is built + soaked (Petr, 2026-06-28).

**What changed from v2.1:** Phase 0 probes proved v2.1's `Timers.Closed=PT5M30S` illegal and the `inactive`-trigger model fragile. v2.2 triggers on **`closed`** instead, which is terminal → fires exactly once → removes dedup, the SDK-event dependency (old P0.2), and the per-message state pre-check. Net: less code, stronger guarantee.

---

## TL;DR

1. **Token Endpoint** — set **only** `Timers.Closed=PT10M` on Create Conversation.
2. Conversation behaves normally (revivable, timer resets per message) until **10 min idle**, then Twilio **closes** it — final/terminal.
3. Twilio fires `onConversationStateUpdated` (`State=closed`) → **Message Handler** routes state events to a new **Post-Conv workflow** (internal Execute Workflow) → fetch transcript → fan out per-client via `ANALYSIS_ROUTING`.
4. **Bubble** — send optimistically, no pre-check. On the closed-conversation error, show a friendly per-client line and silently open a fresh conversation + resend.
5. **Fires exactly once per conversation** (closed is terminal) → **no dedup needed.**

---

## Phase 0 findings (DONE — empirical, 2026-06-28)

Probed against the live Twilio Conversations service (`IS8b1fcbe9e06a4b4f980c849f0ea0ec3b`).

| # | Finding | Evidence |
|---|---|---|
| P0.1 | **Pagination safe.** Recent real conversations carry 2–4 messages, no pagination. Single-page fetch (`PageSize=100`) is enough. | Sampled 6 recent convs via Messages API; max 4, `next_page=none`. |
| — | **`Timers.Inactive` min = 1 min.** `PT30S` rejected. | err `50375` "TimeToInactive should be ≥ 1 minute". |
| — | **`Timers.Closed` min = 10 min.** `PT5M30S` and `PT2M` rejected. **→ v2.1's prod value was illegal.** | err `50376` "TimeToClosed should be ≥ 10 minutes". |
| — | **Write to an INACTIVE conversation REVIVES it** (no error). Message accepted, `inactive→active`, idle timer resets from the new message. Proves the idle timer is measured from **last message** once messages exist. | POST message to inactive probe → 200 + `state:active`. |
| — | **Write to a CLOSED conversation is REJECTED.** Closed is **terminal** — no write, no reopen. | err **`50377`** "Can't update conversation as it's in final closed state", HTTP 400. |
| — | **Only-`Closed` timer ⇒ no inactive limbo.** Creating with just `Timers.Closed=PT10M` sets only `date_closed`; the conversation stays `active` (revivable) until it closes. | Create probe → `timers:{date_closed}` only, `state:active`. |
| — | **Reads work on a closed conversation.** | GET Messages on closed conv → 200. |

**Consequences that shape v2.2:**
- **Trigger on `closed`, not `inactive`.** Closed is terminal → the close event fires **once** per conversation → exactly-once by construction → **no dedup** (protocol or workflow).
- The only non-`active` state is `closed`, which **errors cleanly** on write → the bubble's **catch-on-send** is airtight with **no per-message state pre-check** (Petr's latency concern resolved).
- **Old P0.2 (SDK `stateUpdated` event) is dropped** — we no longer use the inactive event at all.

---

## Design

### Conversation lifecycle

```
 create                 each message resets the 10-min idle clock
   │                                   │
   ▼                                   ▼
 ACTIVE  ◄───── user keeps chatting / returns within 10 min ─────►  ACTIVE
   │                                                                  │
   │                         10 min of silence                        │
   └──────────────────────────────────────────────────────────────►  CLOSED (final)
                                                                       │
                                          writes rejected (err 50377)  │
                                          reads still allowed          │
                                          fires onConversationState-   │
                                          Updated(State=closed) ONCE ──┘
```

There is **no revivable "inactive" window** — the conversation is either `active` (works normally) or `closed` (errors). That is the whole reason the design is simple.

### Trigger
`onConversationStateUpdated` with `State=closed` → Message Handler gate → internal Execute Workflow → Post-Conv. One conversation closes once → one post-conv run.

### Bubble behavior (catch-on-send — Petr's design)
- **No state pre-check** (no added latency).
- `sendMessage()` optimistically. If it throws the closed-conversation error (SDK equivalent of server `50377`): **catch it, suppress the raw error**, append a friendly per-client system line, clear the session, open a **fresh** conversation (new `conversation_sid`), and **resend** the user's message.
- **Per-client end message** keyed by `client_id` (or a `data-ended-message` override):
  - CZ (`ladenta`, `alkoholcz`, `pompo`): *"Konverzace byla ukončena, zahajuji novou."*
  - EN (`digishares`, `atlaschat`): *"This conversation has ended — starting a new one."*

### No dedup
`closed` is terminal; the close event fires once per conversation. No protocol or workflow dedup. Consumer brains are still **advised to be idempotent by `conversation_sid`** on side-effects (e.g. eva-chat's Spinoco push) as cheap insurance.

---

## Architecture diagram

```
 Twilio Conversations Service "N8N Chatbot"
   Post-Webhook /webhook/chat-message
   Filters: onMessageAdded, onConversationStateUpdated  (+ new)
        │
        ▼
 ┌──────────────────────────────────────────────┐
 │ Chat — Message Handler                        │
 │  Webhook (responseMode: responseNode)         │
 │   ↓                                            │
 │  Is State Event? (EventType==='onConversation │
 │                   StateUpdated')   ── NEW      │
 │   ├ true  → Execute Post-Conv (Execute WF,    │
 │   │          onError: continueRegularOutput)  │
 │   │          → Respond 200                     │
 │   └ false → existing: Is User Message? → …     │
 │             → Send Reply → Respond 200         │
 └──────────────────────────────────────────────┘
        │ Execute Workflow (internal)
        ▼
 ┌──────────────────────────────────────────────┐
 │ Chat — Post-Conversation Analysis   [NEW]     │
 │  Execute Workflow Trigger (+ Webhook 2ndary)  │
 │   ↓                                            │
 │  Is Closed? (State==='closed')                 │
 │   ↓                                            │
 │  Parse client_id from FriendlyName             │
 │   ↓                                            │
 │  Fetch Transcript (Messages API, PageSize=100) │
 │   ↓                                            │
 │  Format envelope                               │
 │   ↓                                            │
 │  Route to Client Analysis (ANALYSIS_ROUTING)   │
 │   ↓                                            │
 │  Send to Analysis Webhook (GlobalChatbot auth) │
 └──────────────────────────────────────────────┘
        │ fan-out per client
        ▼
   digishares · alkoholcz · pompo · atlaschat · ladenta   (each empty until it opts in)
```

---

## Changes

### Change 1 — Token Endpoint (`ODrNXQASOPNObSWd`)
`Create Conversation` HTTP node: add **one** form-urlencoded body param — `Timers.Closed` = `PT10M`. No `Timers.Inactive`. Existing conversations (created before this) are unaffected; new ones get the 10-min terminal close.

### Change 2 — Message Handler (`wnHbfZ7Djko2G4HZ`)
Insert a gate at the top (before `Is User Message?`), because once the Twilio filter is added, `onConversationStateUpdated` events arrive at the same webhook and have no `Author`/`Body`:

```
[Twilio Message Webhook] (responseMode: responseNode)
   ↓
[Is State Event?]  $json.body.EventType === 'onConversationStateUpdated'
   ├ true  → [Execute Post-Conv] (Execute Workflow, onError: continueRegularOutput) → [Respond 200 — State]
   └ false → [existing Is User Message? → … → Send Reply to Twilio] → [Respond 200 — Message]
```
- `Execute Post-Conv` passes `$json.body` to the Post-Conv workflow.
- `onError: continueRegularOutput` so a Post-Conv hiccup never breaks the 200 back to Twilio.

### Change 3 — NEW workflow "Chat — Post-Conversation Analysis"
**Triggers:** Execute Workflow Trigger (primary) + Webhook `/webhook/chat-post-conv` (`responseImmediately`, manual-test only).

1. **Is Closed?** — `$json.State === 'closed'` (strip `.body` wrapper if Execute Workflow nests it — confirm on first run). False → drop.
2. **Parse client_id** (Code) — from `FriendlyName` (`chat_{clientId}_user_..._{ts}` → `clientId`; default `digishares`; null-guard missing FriendlyName). Emits `conversationSid`, `serviceSid`, `clientId`, `startedAt` (`DateCreated`), `endedAt` (`DateUpdated`/close time).
3. **Fetch Transcript** (HTTP) — `GET .../Services/{serviceSid}/Conversations/{conversationSid}/Messages?PageSize=100&Order=asc`, Twilio Basic auth (same header as Create Conversation / Send Reply). `onError: continueErrorOutput`, timeout 10s.
4. **Format** (Code) — build the payload envelope (below). Empty messages → return `[]` (drop, no analysis).
5. **Route to Client Analysis** (Code) — `ANALYSIS_ROUTING` lookup by `client_id`; empty `webhookUrl` → log `skipped_no_url`, no send.
6. **Send to Analysis Webhook** (HTTP) — POST envelope to the client URL, `GlobalChatbot` httpHeaderAuth cred, timeout 30s, `onError: continueRegularOutput`.

### Change 4 — Widget (`widget.js`)
- Wrap `sendMessage`: `try` send; `catch` → if `isConversationClosedError(err)`: set a flag, `clearSession()` + new identity + `connectTwilio()` (fresh conversation), append the per-client end message, then **resend** the user's text on the new conversation.
- `isConversationClosedError(err)` — match the SDK's closed-conversation error (verify exact `err.code`/shape against the Twilio JS SDK at build; server code is `50377`).
- `appendSystemMessage(text)` + `.cb-msg.system` CSS + the per-client end-string map (and optional `data-ended-message`).
- **No** event listener, **no** state pre-check.

### Change 5 — Twilio Conversations Service config
Add `onConversationStateUpdated` to the Service Post-Webhook **Filters**. **LAST step** (after all workflows + widget are live).

---

## Payload contract (FROZEN for consumers — e.g. eva-chat Workflow B)

```json
{
  "conversation_sid": "CHxxxxxxxxxxxxxxxx",
  "client_id": "ladenta",
  "started_at": "2026-06-28T20:00:00Z",
  "ended_at":   "2026-06-28T20:10:00Z",
  "message_count": 8,
  "transcript": [
    { "author": "ladenta_user_abc", "body": "...", "timestamp": "2026-06-28T20:00:00Z" },
    { "author": "bot",              "body": "...", "timestamp": "2026-06-28T20:00:03Z" }
  ]
}
```
- POSTed with the shared `GlobalChatbot` auth header.
- `author` = Twilio participant identity (`{client_id}_user_xxx`) or `bot` (and future `agent_*` for live-agent).
- **Consumers must be idempotent by `conversation_sid`.** (Belt-and-suspenders; the pipeline already fires once.)

---

## ANALYSIS_ROUTING — initial state

| client_id | webhookUrl (V1) | Opts in when |
|---|---|---|
| `digishares` | _(empty)_ | CRM push built |
| `alkoholcz` | _(empty)_ | CSAT analyzer built |
| `pompo` | _(empty)_ | — |
| `atlaschat` | _(empty)_ | Pardot ingest built |
| `ladenta` | _(empty → eva-chat URL)_ | **first consumer** — eva-chat Workflow B (Phase 8) |

Ship V1 all-empty; each client adds its URL later (one-line edit). Empty → logged skip, no send.

---

## Edge cases

- **Empty conversation** (opened, never used): closes at `create+10min` → post-conv fires → empty transcript → Format returns `[]` → dropped. Benign.
- **User returns within 10 min:** same conversation, timer resets, keeps chatting. No close, no post-conv until a real 10-min silence. Correct.
- **User returns after close:** `sendMessage` → `50377` → bubble shows friendly line, opens fresh conversation, resends. Old conversation already fired post-conv once.
- **Live-agent transcript:** when live-agent ships, the close event fires after handover ends; the fetched transcript includes agent messages. Desired (full audit trail).
- **Unknown/missing client_id:** Parse defaults to `digishares` (matches Message Handler), null-guarded.
- **Client not in ANALYSIS_ROUTING / empty URL:** logged skip, no send.
- **Analysis brain 5xx:** `onError: continueRegularOutput` → workflow completes; failure visible in execution history. No retry in V1.

---

## Risks & rollback

- **Filter added before workflows ready** → state events fall into the message flow → mitigate: **Twilio filter is the LAST step.**
- **Rollback order (safest first):** remove Twilio filter (drains pipeline) → disable/keep Post-Conv (Execute call swallowed by `continueRegularOutput`) → revert Message Handler gate → revert Token Endpoint timer → revert widget.
- **No infinite loop:** Post-Conv only calls per-client analysis URLs, none of which call back into `chat-message`.

---

## Execution sequence (implementation)

**ORDER CORRECTED 2026-06-29.** The original numbering deployed the close-timer (old Phase 1) before the widget could handle a closed conversation — which would break idle-then-return users on the live widget (their next send hits `50377` with no graceful restart). **The close-timer + Twilio filter must come LAST, after the widget catch-on-send is live.** Safe → live:

- **Step 1 — Build dispatcher workflow (isolated, zero user impact).** ✅ **BUILT 2026-06-29 — workflow `V7lNIBygIteHXAl4`** (inactive by design; runs when called via Execute Workflow). Create "Chat — Post-Conversation Analysis": `Execute Workflow Trigger` → `Is Closed?` (`$json.StateTo === 'closed'`) → `GET /Conversations/{sid}` (FriendlyName→client_id, date_created→started_at) → `GET .../Messages?PageSize=100` → `Format & Route` (envelope + `ANALYSIS_ROUTING` lookup) → `Has Route?` → `Send to Analysis Webhook` (GlobalChatbot, `onError: continueRegularOutput`). Nothing calls it yet → safe to build/iterate freely. (No webhook trigger — MCP can't activate workflows; the Execute Workflow Trigger runs when called regardless of active state.)
- **Step 2 — Widget catch-on-send (the care-point).** ✅ **APPLIED + pushed 2026-06-29 (commit `ef47942`)** — reviewer-vetted + browser-tested (`err.body.code===50377`; restore-on-closed succeeds → send reaches catch). Dormant until step 4. Add `isConversationClosedError` (scoped to a *confirmed* closed-conversation signal only — verify exact Twilio JS SDK error shape; do NOT reset on transient/network errors), `sendMessage` catch→clearSession→fresh conversation→resend, per-client end message + `.cb-msg.system`. Specify resend/welcome ordering. **Must be live before any conversation can close.** Push; wait ~5 min CDN; cache-bust verify.
- **Step 3 — Message Handler gate.** ✅ **BUILT 2026-06-29** — added `Is State Event?` (`$json.body.EventType === 'onConversationStateUpdated'`) → true: `Unwrap Body` (Code: `return [{json:$json.body}]`) → `Run Post-Conv` (Execute Workflow → `V7lNIBygIteHXAl4`, `onError: continueRegularOutput`); false: existing flow. Webhook kept `onReceived`. Smoke-tested: normal message → reaches AI brain (path intact); closed-ping → gate routes + unwraps correctly. **⚠️ Dispatcher must be set ACTIVE in n8n UI** — Execute Workflow can't call an inactive workflow (`"Workflow is not active"`); the gate's `onError` swallows it safely until then. Pre-gate MH backup = git `c7aa250` (rollback point); gated backup refresh deferred to step 6.
- **Step 4 — Token Endpoint timer + Twilio filter (together, LAST).** Add `Timers.Closed=PT10M` to Create Conversation AND add `onConversationStateUpdated` to the Service Post-Webhook filters. Now conversations close *and* every layer (widget, gate, dispatcher) handles it. Confirmed: timer-close emits the webhook (Phase 0 RESOLVED).
- **Step 5 — Soak.** Open real conversations, let them close at 10 min, assert exactly **one** dispatcher execution per `conversation_sid` with a correct transcript.
- **Step 6 — Docs + backups + commit.** Refresh `workflows/*.json` (token-endpoint, message-handler, NEW post-conv-analysis), update `CLAUDE.md` + `CHANGELOG.md`, close TODO items.
- **Step 7 — Wire eva-chat.** Add `ANALYSIS_ROUTING.ladenta` = eva-chat's URL, end-to-end test, then **reply to the eva-chat handover** with the frozen payload contract + timing.

---

## What's NOT in V1

- Pagination beyond 100 messages (P0.1 verified safe).
- Per-client close-timer override.
- Twilio webhook signature verification (mitigated: n8n→n8n via internal Execute Workflow, no new public surface).
- Analysis-brain retry / DLQ / alerting.

---

## Phase 0 — trigger verification: RESOLVED (probe 2026-06-28)

**The "one unknown" is answered: a TIMER auto-close DOES emit `onConversationStateUpdated`, and it was delivered to a real n8n webhook.** Probed via an isolated throwaway Conversations Service (its own service-level webhook → `chat-token`); a conversation with `Timers.Closed=PT10M` closed at exactly create+10min and delivered.

**Real payload (verbatim, form-urlencoded → `$json.body`):**
```json
{ "EventType": "onConversationStateUpdated", "StateTo": "closed", "StateFrom": "active",
  "Reason": "TIMER", "ConversationSid": "CH…", "ChatServiceSid": "IS…",
  "AccountSid": "AC…", "StateUpdated": "<ISO8601>", "RetryCount": "0" }
```
Headers include `X-Twilio-Signature` and `i-twilio-idempotency-token`.

**Corrections this forces into the node logic (v2.3 must apply — the Change 3 / diagram / edge-cases above still say the WRONG `State`):**
- Gate on **`$json.body.StateTo === 'closed'`** — NOT `State`. (`State`/`FriendlyName`/`DateCreated`/`DateUpdated` are **absent** from the webhook.)
- Get `client_id` (from `FriendlyName`), `started_at` (`DateCreated`), `message_count` via a **`GET /Conversations/{ConversationSid}`** inside Post-Conv. `ended_at` = the webhook's `StateUpdated`.
- Optionally also require `Reason === 'TIMER'` (a TIMER close = natural idle end; a manual/API close gives a different `Reason` — and in probing, **manual `State=closed` PATCH did NOT emit the webhook at all**, only the timer did — so TIMER is effectively the only path).
- `RetryCount` present → Twilio may redeliver; consumer idempotency by `conversation_sid` stays a HARD requirement for side-effectful brains.

---

## Reviewer + revision status

Reviewer (2026-06-28, universal template) returned **2 blockers + 4 should-fixes**, both blockers now empirically resolved by the probe:
- **B1 (wrong webhook fields)** → confirmed; correction above.
- **B2a (does timer-close fire?)** → confirmed YES; **B2b** (idempotency) → make it a hard contract requirement.
- **Still to fold into v2.3:** keep Message Handler webhook on `onReceived` (do NOT convert to `responseNode` — avoids the slow-AI-call → Twilio-timeout → double-reply regression); amend the frozen payload contract (`reason`, `state_from`, `locale`, handover-is-consumer's-job note); tighten the widget `isConversationClosedError` to a confirmed-closed signal only + specify resend/welcome ordering.
- **Decided (Petr 2026-06-28):** 10-min model, keep it simple — trigger on `closed` only, no dedup. (Dual-timer 5-min option declined.)

_v2.3 (folding the above) is the next revision before Phase 1 build._
