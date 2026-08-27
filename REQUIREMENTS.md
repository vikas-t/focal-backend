# Focal Backend — Requirements

**Status:** specification, nothing built yet
**Target platform:** Supabase (Postgres + Edge Functions)
**Consumer:** the Focal Chrome extension (`github.com/vikas-t/focal`)

---

## 1. What this is, in one paragraph

Focal is a Chrome extension that explains and fact-checks text you select while
reading. Today it is **bring-your-own-key**: the user pastes an OpenAI API key into
Options, and every request goes straight from their browser to `api.openai.com`. There
is no server.

This backend exists for exactly one reason: **let a new user try Focal without an
OpenAI account.** It holds *our* OpenAI key, meters a small free allowance per install,
and proxies requests to OpenAI. When the allowance runs out, the extension tells the
user to add their own key and reverts to the direct path.

That is the entire scope. It is not an account system, not an analytics platform, and
not a general API.

---

## 2. Non-negotiable constraints

These come from the product's positioning and are not up for renegotiation during
implementation. If a design decision conflicts with one of these, stop and raise it.

1. **No signup, no login, no email, no password.** Identity is an opaque UUID generated
   by the extension. This is a headline product promise, not an implementation detail.
2. **The OpenAI key never leaves the server.** It lives in Supabase secrets and is
   attached server-side. It must never appear in a response body, an error message, a
   log line, or anything the client can read.
3. **Page content is never stored.** It passes through the function to OpenAI and is
   discarded. Do not log it, do not persist it, do not sample it for debugging. This is
   the difference between an honest privacy policy and a dishonest one.
4. **A hard global spend cap.** The free tier must be able to shut itself off. This is
   the only real protection against abuse and it must exist before launch.
5. **BYOK stays the primary path.** The extension only calls this backend when the user
   has *no* key of their own. A backend outage must degrade the free tier, never break
   the extension for BYOK users.

---

## 3. Threat model — read this before designing anything

The identity is a client-generated UUID in `chrome.storage.local`. **A user who clears
extension storage gets a fresh allowance.** This is known, accepted, and deliberate.

Do not attempt to solve it. Specifically, do **not** add:

- Device fingerprinting — unstable in practice, actively defeated by browsers, and
  contradicts the product's privacy positioning.
- Server-issued IDs, HMAC-split identifiers, or registration tokens — these were
  designed and rejected. They stop *offline* ID minting, which nobody does, and add
  moving parts to a system whose real control is the spend cap.
- IP-based enforcement — over-blocks NAT users (offices, universities share one IP) and
  under-blocks anyone with a VPN. **Log IP for visibility, never enforce on it.**
- CAPTCHA / Cloudflare Turnstile — the right tool for *scripted* abuse, but MV3's CSP
  makes it a 2–3 day integration with a worse first-run experience. Deferred until abuse
  is actually observed in the logs.

**Why this is fine:** a manual clear-and-reinstall yields ~20 cheap requests, roughly two
cents. Costing us $10 requires ~500 manual cycles. The correct engineering response is to
bound the worst case with a spend cap, not to chase a perfect identity.

The identity's real job is **accounting, not security** — it is what makes "you have 12
of 20 requests left" a truthful statement across IP changes and network switches.

---

## 4. What the extension needs from this backend

The backend must reproduce what the extension does today against OpenAI directly. Three
call shapes, all currently built in `lib/openai.js` and `background.js` in the extension
repo. **Read those files** — they are the contract.

### 4.1 Explain / Summarize / Chat — streaming

- **OpenAI endpoint:** `POST https://api.openai.com/v1/chat/completions`
- **Streaming:** yes, SSE. The extension renders tokens as they arrive; a
  buffer-then-return proxy would visibly regress the UX.
- **Model:** `gpt-4o-mini` by default.
- The extension sends a fully-formed messages array. The backend should treat the body
  as opaque apart from the validation in §6.

### 4.2 Validate — non-streaming, with web search

- **OpenAI endpoint:** `POST https://api.openai.com/v1/responses`
- Uses the built-in `web_search` tool. One-shot, not streamed.
- **This call is 10–15× the cost of an Explain** because web search bills per search.
  See §5 on whether it belongs in the free tier at all.

### 4.3 Worth-reading — non-streaming

- Same endpoint as §4.1, `stream: false`, capped output.

### PDFs

PDF requests attach the document as a base64 file input, up to 20 MB. The Edge Function
must handle request bodies of that size or explicitly reject them with a clear error.
**Confirm Supabase Edge Function body limits before assuming this works** — if the limit
is lower, the free tier should decline PDFs with an honest message rather than failing
obscurely.

---

## 5. Open product decision — resolve before building

**Should Validate be in the free tier?**

- **Argument for excluding it:** Explain on `gpt-4o-mini` costs roughly $0.001. Validate
  with web search is 10–15× that. Twenty free Validates costs meaningfully more than
  twenty free Explains, and "bring your own key to unlock fact-checking with cited
  sources" is a clean upgrade prompt.
- **Argument for including it:** Validate is the product's differentiator and its best
  demo. Gating it means the free tier hides the reason to install Focal.

**Recommended:** free tier covers Explain and Summarize; Validate requires a user key.
Implement the quota so this is a **configuration value, not a code change** — the
decision may well be reversed after seeing real usage.

---

## 6. Functional requirements

### 6.1 Endpoint

A single Edge Function. Suggested: `POST /functions/v1/proxy`.

**Request** (from the extension):

```jsonc
{
  "install_id": "uuid-v4",        // client-generated, stable per install
  "mode": "explain",              // explain | summarize | validate | worth_reading
  "payload": { /* OpenAI request body, built by the extension */ }
}
```

**Response:** SSE stream for streaming modes; JSON for one-shot modes. Errors as JSON
with a stable machine-readable `code` (see §6.5).

### 6.2 Quota check — in this order, before spending anything

1. **Global daily spend cap.** If today's spend is at or over the ceiling, refuse with
   `service_paused`. Check this *first* — it is the control that actually protects us.
2. **Mode allowed on the free tier?** If not, refuse with `mode_requires_key`.
3. **Per-install quota.** Look up `install_id`. Create the row on first sight with the
   default allowance. If remaining is zero, refuse with `quota_exhausted`.
4. **Reserve** the request, proxy to OpenAI, then record actual usage.

### 6.3 Accounting

- Decrement on **request**, not on success. A failed OpenAI call still costs us latency
  and possibly tokens, and refund-on-error is an abuse vector.
- Record actual token usage from the OpenAI response where available, so spend tracking
  reflects reality rather than estimates.
- Streaming complicates this: usage arrives at the end of the stream, or not at all.
  **Estimate up front from the request size, reconcile afterwards if a usage figure
  arrives.** Do not skip accounting because streaming makes it awkward.

### 6.4 Quota visibility

The extension must be able to show remaining allowance without making a billable call.
Either a lightweight `GET` endpoint, or return the remaining count in a header on every
proxied response. **Prefer the header** — no extra round trip, no extra endpoint.

### 6.5 Error contract

The extension needs to distinguish these and say something useful for each. Return a
stable `code`; the extension owns the user-facing wording.

| `code` | Meaning | What the extension does |
|---|---|---|
| `quota_exhausted` | Free allowance used up | Prompt to add own API key |
| `mode_requires_key` | Mode not free (e.g. Validate) | Explain that this feature needs a key |
| `service_paused` | Global cap hit | "Free tier is temporarily unavailable — add your own key" |
| `rate_limited` | Too many requests too fast | Ask to retry shortly |
| `upstream_error` | OpenAI returned an error | Surface a sanitised message |
| `bad_request` | Malformed / oversized | Generic failure |

**Never** pass an upstream error through verbatim — OpenAI messages can include
organisation identifiers and quote our account's limits.

### 6.6 Abuse-resistant refusals

When refusing a request that looks like farming, prefer returning a **zero-quota
identity** over an explicit block. An attacker who gets a clear "you are blocked" signal
can iterate against it; one who silently receives an exhausted allowance cannot tell
whether they succeeded.

---

## 7. Data model

Keep it minimal. Every column must justify itself against §2.3 (nothing sensitive
stored).

**`installs`**

| column | type | notes |
|---|---|---|
| `install_id` | uuid, PK | client-generated |
| `created_at` | timestamptz | |
| `requests_used` | int | |
| `requests_limit` | int | default from config, per-row so it can be raised |
| `last_seen_at` | timestamptz | |
| `first_seen_ip_hash` | text, nullable | **hashed**, for abuse visibility only, never enforced |

**`usage_events`** — one row per proxied request

| column | type | notes |
|---|---|---|
| `id` | bigserial | |
| `install_id` | uuid, FK | |
| `mode` | text | |
| `created_at` | timestamptz | |
| `prompt_tokens`, `completion_tokens` | int, nullable | actual where available |
| `estimated_cost_usd` | numeric | |
| `status` | text | ok / upstream_error / refused |

**Explicitly not stored:** page content, selections, answers, URLs, page titles, raw IP
addresses. If a column would let someone reconstruct what a user was reading, it does not
belong here.

**`daily_spend`** — materialised view or table maintained by trigger, for the §6.2 cap
check. This is read on every request, so it must be cheap.

### Row Level Security

RLS on everything. **The client must never be able to write its own quota row** — that
would make the whole system decorative. The Edge Function uses the service role; the
anon key must have no write path to `installs`.

---

## 8. Configuration

All of these are runtime configuration, not constants in code:

| Setting | Suggested default | Why configurable |
|---|---|---|
| Free requests per install | 20 | Will be tuned on real data |
| Modes free | `explain`, `summarize` | §5 may be reversed |
| Global daily spend cap (USD) | Set deliberately — start low | The core safety control |
| Alert threshold | 50% and 80% of cap | |
| Per-install rate limit | e.g. 10/min | Stops runaway loops |
| Model | `gpt-4o-mini` | |

---

## 9. Operational requirements

- **Spend alerting.** We must learn about a spike from a notification, not a bill. Alert
  at 50% and 80% of the daily cap.
- **A kill switch.** One config change disables the free tier entirely, without a deploy.
- **Structured logs** with `install_id`, `mode`, token counts, latency, status. **No page
  content, no selections, no URLs.**
- **Cost dashboard** — spend per day, per mode, distinct installs, requests per install
  distribution (the last one is how identity farming becomes visible).

---

## 10. Extension-side changes (in the `focal` repo, not here)

Listed so the contract is clear. Do not implement these here.

1. Generate and persist a UUID in `chrome.storage.local` on first run.
2. Route through the proxy **only when the user has no API key**.
3. Show remaining free requests in the side panel and Options.
4. Handle every §6.5 error code with a clear message and a path to adding a key.
5. **Visibly label free-tier requests**, so it is always obvious whether the user is
   spending our credit or their own.
6. Update the privacy policy — see §11.

---

## 11. Privacy policy implications — do not skip

Today Focal can honestly say *"nothing touches our servers."* Once this ships, that is
only true for BYOK users. The policy must describe **both paths separately**:

- **With your own key:** page content goes only to OpenAI. We never see it.
- **On the free tier:** the request passes through our server to reach OpenAI. State
  exactly what is retained — an install UUID, a request count, token counts, a mode — and
  state that page content is **not** stored. Give a retention period.

Getting this wrong is worse than not shipping the free tier at all. Tracked in
`vikas-t/focal` issue #12.

---

## 12. Definition of done

- [ ] Edge Function proxies all in-scope modes, streaming preserved for chat
- [ ] Per-install quota enforced; client cannot modify its own counter (RLS verified)
- [ ] Global daily spend cap enforced and **tested by actually tripping it**
- [ ] Kill switch works without a deploy
- [ ] All §6.5 error codes returned correctly
- [ ] Remaining quota surfaced to the extension without a billable call
- [ ] No page content in any table or log line — verified by inspection, not assumption
- [ ] Spend alerting fires
- [ ] Load-tested at the expected concurrency
- [ ] OpenAI key confirmed absent from every response path and error message

---

## 13. Suggested build order

1. Schema + RLS, with the "client cannot write quota" property tested first.
2. Bare proxy for one non-streaming mode. Prove the key stays server-side.
3. Quota enforcement.
4. Global spend cap + kill switch. **Do not expose the endpoint publicly before this
   exists.**
5. Streaming.
6. Usage accounting and reconciliation.
7. Alerting and dashboard.
8. Remaining-quota header.

---

## 14. Background reading

In `github.com/vikas-t/focal`:

- **Issue #15** — the full decision history for this design, including the alternatives
  that were considered and rejected. **Read the comments**, not just the description; the
  simplification decision is in a comment and supersedes the original body.
- **`lib/openai.js`** — the exact request shapes to reproduce.
- **`background.js`** — `streamCompletion`, `answerBoxRequest`, `assessWorthReading`.
- **`CLAUDE.md`** — why Validate uses the Responses API while everything else uses Chat
  Completions. That split is deliberate; preserve it.
- **Issue #12** — privacy policy and domain work this depends on.
