# Session resume — Chatbot widget (2026-07-01)

**STATUS: All work done, committed, and pushed. Nothing mid-flight. Safe to restart.** Today we wired the first postpro client (LaDenta/eva-chat) into the live post-conversation dispatcher and filed the reply handover. The post-conv pipeline has been LIVE since 2026-06-30; today just added one route.

## What was done this session

1. **Wired `ladenta` → eva-chat postpro brain** in the live dispatcher `V7lNIBygIteHXAl4` (`Format & Route` node): `ANALYSIS_ROUTING.ladenta.webhookUrl = https://n8n.srv1104100.hstgr.cloud/webhook/eva-chat-postpro`. Live, re-validated (0 errors), active.
2. **Auth confirmed** — outbound `Send to Analysis Webhook` already uses the `GlobalChatbot` credential (`O7q7nPcQ1jLW2gNM`) that eva-chat's webhook expects (`Auth: QocmNeKizhzGxB0G`). No change needed.
3. **Backup + docs** — `workflows/post-conv-analysis.json` bumped to v1.1 (URL redacted); CHANGELOG entry added.
4. **Reply handover written** — `answer-to-evachat-register-2026-07-01.md` (answers `LaDenta/eva-chat/notes/handover-chatbot-2026-07-01-register.md`).
5. **Memory housekeeping** — flushed pending post-conv/session-state edits in the shared gitted memory (portfolio commit `27782d4`).

Commits: `27782d4` (portfolio memory) · `a96f8be` (widget: wiring + backup + reply).

## The one thing to carry forward — client_id naming

eva-chat asked us to register `ladenta-chat`, but the widget sends **`ladenta`** (`demo-ladenta.html` line 25 / `widget.js` identity `ladenta_user_…`). So we keyed the route under **`ladenta`**, and the `client_id` in the payload we POST will be **`ladenta`**. **eva-chat must not assert on `ladenta-chat`** or they'll drop everything. This is spelled out in our reply doc.

## Exact resume steps (next session)

1. **Route the handover to eva-chat** — the reply doc is filed in our repo but eva-chat can't see it until routed. Either Petr tells the eva-chat instance "check handovers", or (with Petr's OK) we drop a pointer into `LaDenta/eva-chat/notes/`. **This is the only open action.**
2. **Then just wait** — the next LaDenta chat that goes idle 10 min is eva-chat's first real transcript. Nothing to build.
3. **Other clients** (digishares, alkoholcz, pompo, atlaschat) remain empty in `ANALYSIS_ROUTING` → clean skip. Wire each when its postpro brain ships (same one-line edit + reply, per `HANDOVER-postpro-brain-2026-06-30.md`).

## What stays running vs. what stops

- **The pipeline runs entirely on the Hostinger n8n instance, NOT your computer.** Restarting your machine / this Claude session changes nothing — Twilio still closes idle conversations, the dispatcher still fires, and closed LaDenta conversations will POST to eva-chat. **A restart drops zero live work.**
- Nothing local is running that a reboot would kill.

## Pointers
- Post-conv build detail: `POST_CONV_BUILD_PLAN.md`
- Consumer contract (for any client): `HANDOVER-postpro-brain-2026-06-30.md`
- Reply to eva-chat: `answer-to-evachat-register-2026-07-01.md`
- Memory continuity note (shared, auto-loads): `project_post_conv_plan`
