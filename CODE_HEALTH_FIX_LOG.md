# FinanceApp code-health fix log

## Starting point — 2026-09-18

- Project: `/root/Financial_Dashboard`
- Branch: `main`
- Starting commit: `23d2d48` (`docs: add CLAUDE_HANDOFF.md`)
- Worktree: clean before changes.
- Baseline checks: `npm run lint` passed; `npm run build` passed with repeated VAPID public-key configuration warnings.
- Baseline audit scope: tenant isolation, destructive/partial mutations, webhook duplicate detection, unbounded server work, client refresh/rendering duplication, and stale starter/dead code.

## Step 1 — complete

Hardened normal tenant-scoped queries by eliminating `user_id IS NULL` fallbacks from application reads/writes/deletes and push delivery. Kept legacy owner backfill isolated to the dashboard migration block, then query only the authenticated user.

Verification:

- `npm run lint` passed.
- `npm run build` passed.
- Source scan found no remaining `user_id.is.null` fallback in application code.
- `git diff --check` passed.
- Existing VAPID configuration warnings remain and are unrelated to this step.

## Step 2 — complete

Validated split structure, positive amounts, and exact cent-level total before writing. Replacement rows are now inserted as one batch before the original is deleted; if deletion fails, the newly inserted rows are cleaned up and the error is returned.

Verification:

- `git diff --check` passed.
- Static validation confirms the original delete occurs after replacement insertion.
- Full lint/build verification is recorded after the remaining fixes are complete.

## Step 3 — complete

Replaced broad 24-hour amount-only webhook deduplication with a 5-minute amount/source/time fingerprint. Direct incoming payloads now prefer the supplied idempotency key and persist it in the note marker.

Verification:

- `git diff --check` passed.
- Static review confirms both incoming and outgoing fallback windows are five minutes and include source/merchant.
- Full lint/build verification is recorded after the remaining fixes are complete.

## Step 4 — complete

Removed the second duplicate `visibilitychange` listener and guarded the interval refresh so it only runs for an authenticated, idle user.

Verification:

- `git diff --check` passed.
- Static scan now finds one `visibilitychange` listener in the client.
- Polling no longer calls the dashboard endpoint while logged out or during another load.

## Step 5 — complete

Replaced the duplicate-cleanup nested loop plus repeated `includes()` calls with a linear `Map` pass, preserving the sorted 24-hour grouping behavior. The delete now remains explicitly user-scoped and checks the database error.

Verification:

- `git diff --check` passed.
- Static complexity is now O(n) instead of O(n²).
- Full lint/build verification follows.

## Step 6 — complete

Made the browser dashboard cache user-specific using `cached_dashboard_data:<user-id>`, retained removal of the legacy global cache on logout, and replaced stale starter metadata/README heading with FinanceApp-specific information.

Verification:

- Cache reads/writes require the authenticated user ID.
- Logout removes the active user cache and legacy global key.
- `git diff --check` passed.

## Step 7 — complete

Updated `schema_v2_multiuser.sql` to fail if legacy rows remain unowned, enforce non-null ownership on categories/transactions/push subscriptions, and replace null-permitting RLS policies with strict `USING` and `WITH CHECK` ownership rules.

Verification:

- SQL text scan confirms the three main RLS policies no longer contain `OR user_id IS NULL`.
- `git diff --check` passed.
- The migration is intentionally not executed locally because no Supabase database connection is configured in the repository.

## Step 8 — complete

Removed the now-unused action-route owner flag and the unused helper parameter left behind by the strict-scoping fix.

Verification:

- No `isOwner` references remain in `src/app/api/action/route.js`.
- `git diff --check` passed.

## Final verification — complete

## Final verification — in progress

Verification completed:

- `npm run lint` passed.
- `npm run build` passed successfully.
- `git diff --check` passed.
- Targeted source invariant scan passed: no application `user_id.is.null` fallback remains, exactly one client visibility listener remains, and the old quadratic duplicate-cleanup loop is absent.
- Build still emits the pre-existing VAPID warning because the configured public key is not URL-safe Base64 without padding; this needs environment/configuration correction.

Remaining limitations deliberately not hidden by this pass:

- Split replacement is safer and compensating, but not a true database transaction. A Supabase RPC/database function is still recommended for strict atomicity under concurrent requests.
- Dashboard still loads and aggregates the full transaction set in memory; SQL-side pagination/aggregation remains future work.
- The 4,600-line static client remains a maintainability hotspot and was not structurally rewritten in this pass.
- Database RLS policies in `schema_v2_multiuser.sql` still permit null `user_id`; the deployed database migration should make these columns non-null after legacy backfill and remove the null policy branches.

## Step 9 — complete

The owner dashboard was showing legacy transactions as unhandled because the application had stopped reading the old owner alias IDs before the database backfill had been run. Restored owner-only access to the known legacy owner aliases for dashboard categories and transactions, while continuing to exclude `NULL` ownership and keeping normal users strictly scoped.

Verification:

- Owner dashboard query includes only the current owner ID and known legacy owner aliases.
- `NULL` user records are still excluded.
- Non-owner dashboard queries remain strictly scoped to their own user ID.
