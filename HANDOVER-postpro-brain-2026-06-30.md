# Handover — how to build a "postpro brain" for your chat client

**From:** Chatbot (the shared `chat-bubble` widget + n8n relay)
**To:** any chat client project (Alkohol, Pompo, DigiShares, AtlasChat, LaDenta/eva-chat …)
**Date:** 2026-06-30
**Status:** the post-conversation pipeline is LIVE. Your client is already covered — it just skips (no error) until you give us a URL.

---

## The one-paragraph version

When one of your chat conversations goes idle for 10 minutes, Twilio closes it and our shared **dispatcher** (`Chat — Post-Conversation Analysis`, n8n `V7lNIBygIteHXAl4`) fetches the full transcript and **POSTs it to a webhook you own**. You build that webhook ("your postpro brain") in your own project and do whatever you want with the transcript — store it, summarize it, push a task to a CRM, etc. You don't touch the chat-bubble side; you just give us your webhook URL and we register it.

---

## What you build

A single **webhook** in your project (n8n, FastAPI, whatever you use) that:
1. Accepts a `POST` with a JSON body (shape below).
2. Returns `2xx` quickly (do heavy work async if needed).
3. Does your project-specific processing. **That logic is entirely yours** — the chat-bubble side stays generic.

## What you receive (the payload — frozen contract)

```json
{
  "conversation_sid": "CHxxxxxxxxxxxxxxxx",
  "client_id": "alkoholcz",
  "reason": "TIMER",
  "state_from": "active",
  "locale": "cs",
  "started_at": "2026-06-30T09:00:00Z",
  "ended_at":   "2026-06-30T09:10:00Z",
  "message_count": 4,
  "transcript": [
    { "author": "alkoholcz_user_3f2a…", "body": "Dobrý den, …", "timestamp": "2026-06-30T09:00:01Z" },
    { "author": "bot",                  "body": "Dobrý den! …", "timestamp": "2026-06-30T09:00:03Z" }
  ]
}
```

Field notes:
- **`conversation_sid`** — Twilio conversation ID. **Use it as your idempotency key** (see below).
- **`client_id`** — your client (so you can sanity-check it's yours).
- **`reason`** — `TIMER` for the normal 10-min idle close. (Other values are possible for non-timer closes.)
- **`locale`** — `cs` for Czech clients, `en` for English. (Derived from `client_id`.)
- **`message_count` / `transcript`** — the full conversation, oldest-first. `author` is either the user identity (`{client_id}_user_…`) or `bot` (and, in future, a human-agent identity).
- The transcript **includes the `"[system] generate welcome message"` line** (the welcome trigger) and the bot's welcome reply. **Filter those out** if you don't want them.

**Auth:** the request carries our shared `GlobalChatbot` auth header. You can verify it or ignore it — your call.

## How to hook it up

1. Stand up your webhook, get its URL (e.g. `https://n8n.../webhook/alkohol-postpro`).
2. **Send the URL to the Chatbot instance (Petr / the architect).** We add one line to the dispatcher's `ANALYSIS_ROUTING` table for your `client_id`:
   ```js
   alkoholcz: { webhookUrl: 'https://n8n.../webhook/alkohol-postpro' },
   ```
3. That's it — closed conversations for your client now POST to you.

## Timing & guarantees

- **Fires ~10 minutes after the user's last message** (the idle-close), **once per conversation**. Closed is terminal in Twilio, so the close event fires once.
- **Be idempotent by `conversation_sid`** anyway (upsert / dedup). Webhooks can be re-delivered; if your brain has a real side effect (email, CRM task, Spinoco), a duplicate would otherwise double-fire.
- **No brain wired = clean skip.** If your `client_id` has no URL registered, the dispatcher fetches the transcript, logs `routing_status: "skipped_no_url"`, and ends. **No error, nothing sent.** So nothing breaks for clients who haven't built a brain yet.
- **If your brain returns 5xx / times out:** the dispatcher logs it and moves on (no retry in V1). Your side owns reliability.

## What you do NOT do

- You don't touch `chat-bubble`, the Message Handler, or the dispatcher.
- You don't fetch the transcript yourself — we hand it to you.
- You don't manage Twilio — the close + delivery is already handled.

---

**Reply path:** send your webhook URL back to the Chatbot instance and we'll register it. For LaDenta/eva-chat specifically, this is the trigger your "Workflow B" (Supabase persist + Spinoco reception-handover) hangs off — your separate handover (`LaDenta/eva-chat/notes/handover-chatbot-2026-06-28.md`) is answered by this contract.
