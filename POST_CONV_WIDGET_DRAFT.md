# Widget catch-on-send — DRAFT (post-conv build, step 2)

**Status:** draft **v2 — VALIDATED, ready to apply.** Reviewer round-1 fixes folded; browser test passed (2026-06-29). Both blockers resolved empirically:
- **Restore path:** a returning user whose conversation is closed → restore *succeeds* (`getConversationBySid` + `getMessages` resolve, history loads, no error) → the next send reaches `sendMessage`'s catch. **Entry point is correct; no restore-path branch needed.**
- **Detection:** closed-conv send throws with `err.body.code === 50377`, `err.body.message === "Can't update conversation as it's in final closed state"`, `err.status === 400` (top-level `err.code` is `undefined`). The draft's `err.code || err.body?.code === 50377` check fires correctly. (Primary `state.current === 'closed'` couldn't be read from console scope but runs inside the widget; the `50377` secondary is the proven signal — detection is robust on the hedge alone.)
**Goal:** when a conversation has gone terminal-`closed` (10-min idle timer, once the post-conv pipeline is live), the user's next send must not silently fail. Catch it, show a per-client notice, transparently open a fresh conversation, and resend — **no per-message state pre-check** (Petr's latency rule).

**Why this must ship before the close-timer:** today conversations never close, so this never fires. Once `Timers.Closed=PT10M` lands (build step 4), a returning user hits a closed conversation; without this, the current widget shows a dead-end "Failed to send" (widget.js:662).

---

## Key design decisions (reviewer's concerns pre-addressed)

1. **Closed detection = conversation STATE, not error-string guessing.** The Twilio JS SDK exposes `conversation.state.current` (`active`/`inactive`/`closed`). In the send-failure `catch`, we check `activeConversation.state.current === 'closed'`. That is the *confirmed-closed signal* the reviewer asked for — we never auto-reset on a transient/network error. (Defensive secondary: Twilio closed-conv error codes `50377`/`50404`, in case state hasn't synced — see Open Question 1.) Zero happy-path latency (only runs after a failure).
2. **Welcome suppressed on restart.** A fresh conversation normally auto-sends `[system] generate welcome message` (widget.js:804–807). On a restart-after-close the user is mid-conversation, so we suppress the greeting (new `suppressWelcome` arg to `connectTwilio`).
3. **Visible history preserved.** Unlike `newConversation()` (which clears the pane, widget.js:832), restart-after-close keeps the prior messages on screen for continuity — only a new `conversation_sid` underneath.
4. **No double user-bubble.** The user's optimistic bubble is already on screen (widget.js:650). We resend the same text on the fresh conversation; the `messageAdded` listener ignores self-authored messages (widget.js:749), so it won't re-render.
5. **Notice ordering:** the system notice lands *after* the user's optimistic bubble → reads as `[user msg] → [💤 previous conversation expired, continuing in a new one] → [bot reply]`. Wording is chosen to fit that position. (Alternative — remove+reinsert the user bubble for notice-first order — noted but rejected for V1 as fiddly.)
6. **Per-client message** keyed by `client_id`, with a `data-ended-message` override. CZ for ladenta/alkoholcz/pompo, EN for digishares/atlaschat.

---

## The changes (against current `widget.js`)

### A. CFG — add the override attribute (in the `CFG` object, ~line 6–16)
```js
endedMessage: scriptTag.getAttribute("data-ended-message") || "",
```

### B. New helpers (add near the other UI helpers, ~after line 636)
```js
// ── Per-client "conversation ended" notice ───────────────────────
const ENDED_MESSAGES = {
  ladenta:    "Předchozí konverzace vypršela — pokračuji v nové.",
  alkoholcz:  "Předchozí konverzace vypršela — pokračuji v nové.",
  pompo:      "Předchozí konverzace vypršela — pokračuji v nové.",
  atlaschat:  "Your previous conversation expired — continuing in a new one.",
  digishares: "Your previous conversation expired — continuing in a new one.",
};
function endedMessage() {
  return CFG.endedMessage || ENDED_MESSAGES[CFG.clientId] || ENDED_MESSAGES.digishares;
}

function appendSystemMessage(text) {
  finishActiveStream();
  const el = document.createElement("div");
  el.className = "cb-msg system";
  el.textContent = text;
  messagesEl.insertBefore(el, typingEl);
  if (isNearBottom()) requestAnimationFrame(() => scrollToBottom());
}

// Confirmed-closed signal: SDK conversation reports terminal 'closed' state.
// Defensive secondary: the Twilio closed-conversation error code. We ONLY
// auto-restart on this — never on transient/network send failures.
function isClosedConversation(conv, err) {
  try { if (conv && conv.state && conv.state.current === "closed") return true; } catch {}
  const code = err && (err.code || (err.body && err.body.code));
  return code === 50377;   // [reviewer #5] dropped 50404 (generic "not found", too broad
                           // → could misfire pre-timer). Confirm the real SDK code in the browser test.
}
```

Also declare a re-entrancy flag with the other state vars (~line 67–72):
```js
let restarting = false;   // [reviewer #3] guards against double-restart during the async restart
```

### C. `sendMessage` — add a re-entrancy guard at the top (after line 647) + replace the `catch` block (659–663)
```js
  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || !activeConversation || restarting) return;   // [reviewer #3] guard
    // ... existing optimistic append / clear / disable (lines 650–653) unchanged ...
    try {
      await activeConversation.sendMessage(text);
      showTyping(true);
    } catch (err) {
      if (isClosedConversation(activeConversation, err)) {
        await restartAfterClose(text);
      } else {
        console.error("[ChatBubble] Send failed:", err);
        showTyping(false);
        setStatus("Failed to send message. Please try again.", "error");
        btnSend.disabled = false;   // [reviewer #1] don't leave a dead button
      }
    }
  }
```

### D. New `restartAfterClose` (add near `newConversation`, ~line 822)
```js
// Conversation expired (idle 10-min terminal close). Transparently start a
// fresh conversation and resend the user's pending message. Keeps visible
// history; suppresses the welcome (user is mid-conversation, not cold-start).
async function restartAfterClose(pendingText) {
  if (restarting) return;          // [reviewer #3]
  restarting = true;
  try {
    appendSystemMessage(endedMessage());   // lands after the user's optimistic bubble
    showTyping(false);

    clearSession();
    identity = generateIdentity();
    if (twilioClient) { try { await twilioClient.shutdown(); } catch {} }
    twilioClient = null;
    activeConversation = null;

    await connectTwilio({ suppressWelcome: true });

    if (activeConversation) {
      try {
        await activeConversation.sendMessage(pendingText);
        showTyping(true);
      } catch (e) {
        console.error("[ChatBubble] Resend after restart failed:", e);
        showTyping(false);
        setStatus("Failed to send message. Please try again.", "error");
        btnSend.disabled = false;                              // [reviewer #1]
      }
    } else {
      // connectTwilio failed (its own catch nulled activeConversation, widget.js:817–818)
      showTyping(false);
      setStatus("Couldn't reconnect — please reload.", "error");   // [reviewer #4]
      btnSend.disabled = false;                                 // [reviewer #1/#4]
    }
  } finally {
    restarting = false;
  }
}
```

### E. `connectTwilio` — accept `suppressWelcome` (widget.js:667 + 804)
- Line 667: `async function connectTwilio() {` → `async function connectTwilio({ suppressWelcome = false } = {}) {`
- Line 804: `if (!isRestore) {` → `if (!isRestore && !suppressWelcome) {`

All existing callers pass no args (`toggleChat` :453, restore-fail recursion :702, `newConversation` :835) → default `false` → behavior unchanged. Only `restartAfterClose` passes `true`.

### F. CSS — add a `.cb-msg.system` rule (in the base `<style>`, after `.cb-msg.user` ~line 207)
```css
.cb-msg.system{
  align-self:center;max-width:90%;
  background:transparent;border:none;padding:4px 8px;
  font-size:calc(var(--cb-font-size) - 2px);
  font-style:italic;text-align:center;opacity:0.65;
}
```

---

## Open questions for the reviewer / build-time

1. **State-sync race.** Does `activeConversation.state.current` reliably read `'closed'` at the instant of the `catch`, or can the server-close lag the SDK's local state? If it lags, this send falls to the transient "Failed to send" path; the user retries and the *second* attempt restarts (state synced by then). The secondary error-code check is the hedge. **Needs a real browser test (Petr) — log the full `err` to learn the exact SDK shape/code.**
2. **Exact SDK closed-conv error code** — to firm up the secondary check (server REST is `50377`; the JS SDK may surface a different code). Confirm in the browser test.
3. **Notice ordering** — confirm `[user msg] → notice → reply` is acceptable, or require notice-first (needs bubble remove+reinsert).
4. **`getConversationBySid` on an already-closed conv** (restore path, widget.js:723–728) — a returning user restoring a *closed* conversation loads it read-only, sees history, then their send triggers this restart. That's the same path and is handled — but worth confirming the restore doesn't throw earlier.

## Browser test — ✅ PASSED 2026-06-29

**Result:** restore on a closed conv succeeded (history loaded, no errors); the new send failed at the catch with `err.body = {status:400, code:50377, message:"Can't update conversation as it's in final closed state"}`. → returning user reaches `sendMessage`'s catch; `50377` detection confirmed. Steps used below.

**Goal:** does a returning user whose conversation has closed actually reach `sendMessage`'s catch (→ this draft works), or die earlier in `connectTwilio` restore (→ closed-handling must move into the restore path)? Plus capture the exact send error code.

1. Open `https://darthpeter.github.io/chat-bubble/demo-atlaschat.html`, open DevTools (F12) → **Console**.
2. Send a message in the bubble; confirm the bot replies (a conversation now exists).
3. In Console run: `JSON.parse(sessionStorage.getItem('cb_session_atlaschat')).conversation_sid` → copy the `CH…` value, give it to the operator.
4. Operator force-closes that conversation server-side (Twilio `State=closed`), confirms back.
5. **Reload** the page. Report: (a) did the earlier message history reappear? (b) any red `[ChatBubble] …` Console errors? (paste them).
6. Type a **new** message + send. Report: (a) what the bubble does (sends? "Failed to send"? stuck?); (b) expand the Console line `[ChatBubble] Send failed:` and paste the error's `code` / `message` / `status`.

**Reads:** history reappears + send fails at the catch → restore reaches `sendMessage`, draft works as-is. History does NOT load / widget goes "Offline" → `getConversationBySid` throws on a closed conv → add closed-handling to `connectTwilio` restore (723–744) too. The send-error `code` finalizes the `50377`-only secondary check.

## Not in this change
- Token-endpoint timer, Twilio filter (build step 4 — must come AFTER this is live).
- Any server-side change.
