# FinanceApp remaining-fix plan

Created: 2026-09-18

This plan covers the remaining items from the code-health audit. The completed fixes and verification history are in `CODE_HEALTH_FIX_LOG.md`.

## Priority 0 — protect financial data

### 1. Make transaction splitting truly atomic

Current state: the application inserts replacement rows, then deletes the original, with compensating cleanup if deletion fails. This is safer than the old delete-first flow but is not a database transaction.

Work:

- Add a Supabase/Postgres function that validates ownership, validates the split total, inserts all replacement rows, and deletes the original inside one transaction.
- Call the function from `splitTransaction`.
- Keep the current application fallback disabled once the migration is confirmed installed.

Acceptance:

- A failed split leaves the original transaction unchanged.
- A successful split creates all parts and removes the original.
- A user cannot split another user’s transaction.

Dependency: run the new SQL function migration in Supabase before switching the route fully to RPC.

### 2. Finish database ownership hardening

Current state: legacy owner records were migrated successfully; the strict schema migration is prepared but has not been confirmed as executed.

Work:

- Confirm `user_id` is non-null for categories, transactions, and push subscriptions.
- Apply strict RLS policies with `USING` and `WITH CHECK` ownership checks.
- Confirm the server’s Supabase access model remains compatible with the deployed RLS setup.

Acceptance:

- No unowned rows remain.
- A test user cannot read or mutate another user’s rows.
- Dashboard, webhook, and push flows still work after RLS is enabled.

## Priority 1 — performance and reliability

### 3. Move dashboard aggregation into SQL

Current state: normal dashboard requests are date-limited, but calculations still happen in JavaScript and all rows in the selected range are loaded into memory.

Work:

- Add indexes for `(user_id, transaction_date)`, `(user_id, kind, transaction_date)`, and category ownership lookups.
- Move totals, category spending, history counts, and historical summaries into database functions or aggregate queries.
- Keep the response shape unchanged so the frontend does not need a large rewrite.

Acceptance:

- Dashboard response time remains stable with 10,000+ transactions.
- Database returns only the aggregates and page rows needed by the request.
- Current, next, past, and all-time views produce the same totals as before.

### 4. Add request cancellation and refresh control

Current state: polling is guarded, but multiple navigation/actions can still create overlapping requests.

Work:

- Add an `AbortController` for dashboard requests.
- Cancel stale requests when changing cycle, filters, or logging out.
- Keep one refresh scheduler and one visibility handler.

Acceptance:

- No stale response can overwrite newer dashboard state.
- Logout cancels active requests.
- Returning to the app triggers at most one refresh.

### 5. Complete production push configuration

Current state: redacted local VAPID placeholders are handled correctly; production needs a real URL-safe public key and matching private key.

Work:

- Set a real matching VAPID key pair in deployment environment variables.
- Verify push subscription, test push, expired-subscription cleanup, and daily evaluation.
- Remove any remaining placeholder values from deployment configuration.

Acceptance:

- Production build has no VAPID warning.
- Browser subscription succeeds.
- Test notification reaches the intended user only.

## Priority 2 — maintainability and test coverage

### 6. Split the 4,600-line browser file

Current state: `public/index.html` contains markup, global state, API calls, rendering, modals, charts, push, Android bridge, and SMS reconciliation.

Work:

- Move the inline script into modules under `public/js/` or migrate the UI to React components incrementally.
- First extract API/auth/state, then transaction/category UI, then push/SMS features.
- Preserve the existing global bridge functions until all inline handlers are migrated.

Acceptance:

- No behavior change in login, dashboard, transaction editing, SMS import, or Android bridge.
- Each feature can be linted and tested independently.
- Inline script is reduced to bootstrapping only.

### 7. Add automated regression tests

Current state: lint and production build pass, but there is no meaningful test suite.

Work:

- Add Node tests for cycle boundaries, amount validation, duplicate detection, and split-total validation.
- Add API integration tests with Supabase mocks for ownership rules and webhook authentication.
- Add browser tests for login, dashboard loading, categorization, clean duplicates, and SMS import.

Acceptance:

- Tests fail for the original bugs and pass after fixes.
- Tests cover both owner and non-owner access.
- Tests run in CI before deployment.

### 8. Remove silent error handling

Current state: several frontend `catch` blocks discard errors or leave the UI ambiguous.

Work:

- Replace empty catches with user-visible error states or structured logging.
- Restore button state after failed requests.
- Add retry behavior only for safe idempotent reads.

Acceptance:

- Every failed mutation gives the user a clear result.
- No action reports success when the server failed.
- Sensitive data is not written to logs.

### 9. Clean documentation and obsolete files

Work:

- Update architecture documentation to match the actual `public/index.html` entry point.
- Review `check.js`, `seed.js`, `port_ui.js`, and old migration/schema files.
- Mark historical files clearly or remove them after confirming they are unused.
- Document the required Supabase migrations and deployment environment variables.

Acceptance:

- A new developer can run, test, migrate, and deploy the app using the repository docs.
- No documentation describes removed routes or obsolete architecture.

## Suggested execution order

1. Confirm strict Supabase ownership/RLS state.
2. Add and deploy the atomic split function.
3. Add database indexes and move dashboard aggregates into SQL.
4. Add request cancellation and refresh tests.
5. Configure and test production push.
6. Add regression and browser tests.
7. Split the frontend incrementally.
8. Clean documentation and obsolete files.

## Definition of done

- Lint, build, unit tests, API tests, and browser tests pass.
- No cross-user reads or writes are possible.
- Split operations are database-atomic.
- Dashboard performance is measured with a realistic transaction dataset.
- Production push notifications work with no configuration warnings.
- The remaining audit findings are either fixed or explicitly documented with an owner and next action.
