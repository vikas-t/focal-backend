# Backend issues found in testing

Found while integrating the Focal extension against the deployed function
(`eqhjcimwtmcyqwdzhwvk`) on 2026-08-27. Only the significant ones are listed; minor
nits are omitted deliberately.

Overall the backend works: all four modes proxy correctly, the quota header is present,
rate limiting behaves exactly as configured, error codes are well-formed, and streaming
preserves SSE. The issues below are about the quota being bypassable and about a policy
gap, not about the proxy being broken.

---

## 1. Quota is bypassable with concurrent requests — 10 calls for 2 units

**Severity: high.** This makes the per-install allowance close to decorative.

`quota.ts` step 6 reserves the request with a read-modify-write in application code:

```ts
await db.from("installs").update({
  requests_used: inst.requests_used + 1,   // value read earlier in this function
  ...
}).eq("install_id", installId);
```

`inst.requests_used` was read at step 3. Concurrent invocations all read the same value
and all write `value + 1`, so every update but the last is lost. Nothing in the statement
is atomic and there is no optimistic-concurrency guard.

### Reproduced against the deployed function

Ten concurrent requests for one fresh install id, well within the 10/min rate limit:

```
successful OpenAI calls : 10
remaining values seen   : 19,19,19,19,19,19,18,19,19,19
quota actually consumed : 2 of 20
```

**Ten real, billed OpenAI calls cost two quota units.** A second run with 8 concurrent
requests consumed 2 units. The multiplier scales with concurrency, and the rate limit does
not prevent it — 10 parallel requests are exactly at the configured limit, not over it.

This is not the accepted "clear storage for a fresh allowance" leak from
`REQUIREMENTS.md` §3. That one costs an attacker manual effort per 20 requests. This costs
nothing and needs no new identity.

### Fix

Do the increment in SQL so the read and write are one atomic operation — either inside the
existing `upsert_install` RPC or a dedicated `consume_quota` function:

```sql
update installs
   set requests_used = requests_used + 1,
       last_seen_at  = now()
 where install_id = p_install_id
   and requests_used < requests_limit
returning requests_used, requests_limit;
```

Returning no row then means "quota exhausted", and the check and the increment can no
longer disagree. This also collapses steps 4 and 6 into one round trip.

---

## 2. The global spend cap has the same race, and it is the only hard guarantee

**Severity: high**, because `REQUIREMENTS.md` §2.4 makes this the control that everything
else rests on.

The cap is checked with a read (`select total_usd from daily_spend`) and enforced in
application code, while spend is written later by the `usage_events` trigger. Between the
check and the write, any number of concurrent requests all see the same
under-the-cap value and all proceed.

The window is wider than for the quota, because the spend figure only lands *after* the
OpenAI call completes — so a burst of concurrent requests is checked against a spend total
that predates every one of them.

**Consequence:** the daily cap is a floor, not a ceiling. With `daily_spend_cap_usd = 3.00`
the real ceiling is 3.00 plus whatever a maximally concurrent burst adds. For Explain that
overshoot is small; for `validate` at ~$0.025 per web search it is not.

### Fix

Reserve estimated spend *before* the upstream call and reconcile after, rather than
reading a total that lags. At minimum, make the check-and-reserve a single atomic
statement in the same style as issue 1. `REQUIREMENTS.md` §6.3 already specifies the
estimate-then-reconcile shape; the current code reconciles but does not reserve.

---

## 3. `mode_requires_key` is never returned — Validate is free

**Severity: medium.** A policy gap rather than a bug, but a costly one.

`mode_requires_key` is declared in `types.ts` and given a status in `errors.ts`, but no
code path returns it. There is no `free_modes` config key and no per-mode gating anywhere
in `quota.ts` or `proxy/index.ts`.

**Verified:** `validate` succeeds on the free tier and returns cited sources, confirmed
through the extension against the deployed function.

`REQUIREMENTS.md` §5 recommended excluding Validate from the free tier precisely because
web search makes it **10–15× the cost** of an Explain — the backend's own
`accounting.ts` prices it at `$0.025` per call versus roughly `$0.002` for a fallback
Explain. Twenty free Validates is about $0.50 per install; twenty free Explains is about
$0.04.

Combined with issue 1, the concurrency bypass is most valuable on exactly the most
expensive mode.

### Fix

Add a `free_modes` config key (§8 lists it as configuration, not a constant, since the
decision is expected to be revisited) and return `mode_requires_key` for anything outside
it. The extension already handles the code and shows "This feature needs your own OpenAI
API key."

If Validate on the free tier was a deliberate reversal of §5, update `REQUIREMENTS.md` so
the doc and the deployment agree — right now they contradict each other.

---

## 4. `quota_exhausted` responses omit `X-Quota-Remaining`

**Severity: low-medium.** Worth fixing because it is one line and it makes clients wrong.

The header is set from `quotaHeaders`, which is built *after* `checkQuota` returns — so
every refusal path returns without it. For `rate_limited` that is arguably fine, but for
`quota_exhausted` the client is left with whatever count it last cached, and the
extension's options page would keep showing "5 free requests left" to a user who has none.

**Verified** against the deployed function: a spent install returns 403 with no
`X-Quota-Remaining`.

Worked around on the extension side (the refusal code is now treated as authoritative and
records zero), but the backend is the right place to fix it: any other client would hit
the same trap.

### Fix

Set the header on refusals too — `0` for `quota_exhausted`, and the true remaining value
for `rate_limited`, which does not consume quota.

---

## Not issues — checked and correct

Recorded so they are not re-investigated:

- **Accounting order.** Quota is reserved before the upstream call with no refund on
  failure, exactly as `REQUIREMENTS.md` §6.3 requires.
- **Streaming usage capture.** `stream_options: { include_usage: true }` is set and the
  final usage event is parsed, so streamed calls are not silently unmetered.
- **Responses API vs Chat Completions.** The `validate` split is preserved, and usage is
  read from both shapes (`prompt_tokens`/`input_tokens`).
- **Model override.** `payload.model` is overwritten server-side, so a client cannot ask
  for an expensive model.
- **PDF rejection.** Not in the requirements but a sensible call given Edge Function
  memory; the message is written for the user and reads well.
- **Proxy fidelity.** Validate output is byte-identical between BYOK and free tier.

---

## Suggested order

1. **Issue 1** — atomic quota increment. Highest impact, smallest change.
2. **Issue 2** — same treatment for the spend cap. This is the guarantee everything rests on.
3. **Issue 3** — decide Validate's status and make the doc and deployment agree.
4. **Issue 4** — one-line header fix.
