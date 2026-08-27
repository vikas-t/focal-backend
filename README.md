# focal-backend

Supabase backend for the [Focal](https://github.com/vikas-t/focal) Chrome extension.

Its single job: let a new user try Focal without an OpenAI account. It holds our OpenAI
key, meters a small free allowance per install, and proxies requests to OpenAI. When the
allowance runs out the extension reverts to the user's own key.

**Nothing is built yet.** Start with [REQUIREMENTS.md](REQUIREMENTS.md) — it carries the
scope, the constraints, the threat model, and the build order.

Three things worth knowing before reading anything else:

- Identity is a **client-generated UUID**. There is no signup, no login, no email. A user
  who clears storage gets a fresh allowance — this is known and accepted, and §3 explains
  why chasing it is the wrong move.
- The **global daily spend cap** is the real safety control, not the identity scheme. It
  must exist before the endpoint is public.
- **Page content is never stored or logged.** This is what keeps the privacy policy
  honest.
