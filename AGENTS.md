<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues (`mandid9/Financial_Dashboard`). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.

## Hard rules (learned from production incidents — do not violate)

### Secret & keypair generation must be atomic

Never split a keypair/secret across multiple shell invocations. Each run of a generator
(e.g. `npx web-push generate-vapid-keys`) produces **unrelated** values; capturing the
public key from one run and the private key from another yields a silently mismatched
pair that only fails at delivery time with opaque provider errors (e.g. FCM 403
`permission denied: invalid JWT provided`).

Correct pattern:

```bash
OUT=$(npx web-push generate-vapid-keys)
PUB=$(echo "$OUT" | grep -A1 "Public Key" | tail -1)
PRIV=$(echo "$OUT" | grep -A1 "Private Key" | tail -1)   # same $OUT, one generation
```

Then verify pairing before shipping: sign-and-verify locally, or confirm the public key
served by `/api/push/subscribe` matches the pair used by `src/lib/push.js`.

### Other incident rules

- VAPID keys, `CRON_SECRET`, `WEBHOOK_SECRET` live in Vercel env vars only — never as code
  fallbacks in `src/lib/push.js` or route files.
- Push send failures are surfaced to the client (`errors`, `statusCode`, `body`), not
  swallowed; the UI test button authenticates via session cookie, cron paths via
  `Authorization: Bearer CRON_SECRET`.
- The service worker serves pages network-first (`public/sw.js`, cache v3+). Never revert
  HTML to stale-first caching; UI updates must reach devices on first reload.
- DB migrations: apply schema BEFORE deploying code that queries new columns. Safe path:
  `docs/migrate_v2_safe.sql`. Do not enable RLS until routes use per-request authenticated
  clients (anon client + RLS = invisible rows).
