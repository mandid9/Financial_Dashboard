# Alpha.md — Project Review, Optimization Plan & Roadmap

> **Project:** Financial Dashboard (`finance-dashboard-next`)
> **Reviewed:** August 24, 2026
> **Scope:** Full codebase audit — web app (`src/`, `public/`), database schemas, native Android companion, docs, and deployment config.

---

## Part 1 — Project Review

### 1.1 What the project is

A Personal Finance & Budgeting Progressive Web App (PWA) tailored to Egyptian banking (EGP). It tracks income, categorized expenses, debt repayments, and billing cycles that run from the 20th of each month, with automatic transaction ingestion from bank SMS (via MacroDroid HTTP webhook or the bundled native Android app) plus Web Push budget alerts.

### 1.2 Architecture snapshot

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19.2, Turbopack |
| Frontend | Vanilla JS/HTML/CSS SPA (`public/index.html`) + Chart.js + Service Worker PWA |
| Backend | API routes: `auth`, `auth/google`, `action`, `dashboard`, `push/send`, `push/subscribe`, `webhook` |
| Database | Supabase PostgreSQL — v1 single-user schema, v2 multi-user migration with RLS |
| Notifications | web-push (VAPID), Vercel Cron daily at 18:00 |
| Mobile | Native Android companion (Java): SMS receiver → actionable notifications → WebView wrapper |
| Hosting | Vercel |

### 1.3 Strengths ✅

- **Documentation discipline** — `PROJECT_OVERVIEW_CODEX.md` is a genuine architecture reference (domain formulas, SMS formats, schema tables, milestones).
- **Security-aware details**: timing-safe webhook secret comparison (`src/app/api/webhook/route.js:14`), httpOnly/secure/sameSite cookies (`src/app/api/auth/route.js:5`), 4 KB payload limit on the webhook, security headers in `next.config.mjs`, input sanitization and amount validation in the action route.
- **Solid domain logic**: cycle math anchored to day 20, carried-forward (📌) isolation rules, debt planned-vs-paid rollover into next-cycle preview, duplicate-SMS suppression (5-minute window).
- **UX engineering**: server-side history pagination/filter/search, visibility-aware polling, stale-while-revalidate service worker that correctly bypasses `/api/`.
- **Hygiene**: meaningful commit history; `.env*` files are not tracked in git (verified).

### 1.4 Critical issues 🔴

| # | Issue | Location |
|---|---|---|
| C1 | **Hardcoded VAPID private key** committed as a code fallback. Anyone with repo access can forge pushes to all subscribers. | `src/lib/push.js:5` (also public-key fallbacks at `push.js:4`, `push/subscribe/route.js:5`) |
| C2 | **Multi-tenancy is incomplete.** All server routes use the anon-key Supabase client without attaching the user's JWT, so RLS runs as anonymous. After the v2 backfill assigns `user_id`, queries will break or silently touch `user_id IS NULL` rows owned by anyone. | `src/lib/supabase.js:15` |
| C3 | **IDOR across users.** `dashboard` fetches *all* categories/transactions with no user filter; `action` mutates/deletes rows by id or name only; `sendPushToAll` notifies every subscription regardless of owner. | `dashboard/route.js:62-73`, `action/route.js:69,94`, `lib/push.js:17` |
| C4 | **No tests at all.** Cycle math, carry-forward scoping, debt rollover, and both SMS parsers have zero automated coverage. | whole repo |
| C5 | **Non-atomic mutations.** `splitTransaction` deletes the original then inserts parts one-by-one (partial failure = data loss); `reorderCategories` issues N sequential updates. | `action/route.js:145-224` |

### 1.5 Significant concerns 🟡

- **Scalability:** dashboard loads the entire `transactions` table then filters in JS (411-line route). Push date-range filters into SQL before data grows.
- **Duplicated parsing logic** in two languages (Node webhook ↔ `BankParser.java`) — guaranteed drift over time.
- **RLS hole:** policies of the form `auth.uid() = user_id OR user_id IS NULL` let any anon request read/write unowned rows.
- **Schema hygiene:** `schema.sql` inserts `'Uncategorized'` unconditionally (not idempotent); `schema_v2_multiuser.sql` hardcodes a personal email (`kr.wn20@gmail.com`) and should not ship as-is.
- **README.md** is stock create-next-app boilerplate; real docs live only in the Codex overview.
- **Monolith SPA:** `public/index.html` is ~2,673 lines of mixed HTML/CSS/JS.
- **No TypeScript, no CI pipeline, no pre-commit hooks.**

---

## Part 2 — Optimization Plan

Ordered by priority. Each phase is independently shippable.

### Phase 0 — Security triage (do immediately, ~1 day)

1. **Rotate VAPID keys** (new keypair via `npx web-push generate-vapid-keys`). Delete all hardcoded fallbacks from `src/lib/push.js` and `push/subscribe/route.js`; fail loudly when env vars are missing instead of substituting placeholders.
2. Audit Supabase for any exposed keys and confirm `SUPABASE_SERVICE_ROLE_KEY` exists only in Vercel env vars, never client-side.
3. Add a startup check (or build-time check) that required env vars are present: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `WEBHOOK_SECRET`, `CRON_SECRET`, VAPID trio.

### Phase 1 — Correct multi-tenancy (~2–3 days)

1. Choose one model and apply it everywhere:
   - **Option A (recommended):** server routes create a per-request Supabase client carrying the user's access token, so RLS genuinely enforces isolation. Remove `OR user_id IS NULL` from policies once backfill completes.
   - **Option B:** service-role key server-side + explicit `.eq('user_id', user.id)` scoping on *every* query in `dashboard`, `action`, `webhook`, and `push`.
2. Scope `sendPushToAll` → `sendPushToUser(userId)`; keep an admin variant only for the cron job.
3. Fix the webhook fallback so the global `WEBHOOK_SECRET` path cannot guess users by "first row" — require per-user tokens once more than one user exists.
4. Make migrations idempotent and portable: remove the hardcoded email, guard default-category inserts with `ON CONFLICT DO NOTHING`.

### Phase 2 — Data integrity & performance (~2 days)

1. Replace non-atomic mutations with a single Postgres function (Supabase RPC):
   - `split_transaction(tx_id, parts jsonb)` — delete + insert inside one transaction.
   - `reorder_categories(ordered_ids uuid[])` — batch update.
2. Move transaction filtering into SQL: add composite index `(user_id, transaction_date DESC)` and pass cycle bounds to the query instead of fetching everything.
3. Cache categories in memory briefly (or use SWR-style revalidation) to cut repeated reads per request.
4. Add rate limiting to `/api/webhook` (e.g., per-token sliding window) to blunt replay abuse.

### Phase 3 — Testing & tooling (~3 days)

1. Install **Vitest**; unit-test the pure logic first:
   - `getCycleBounds` / offset math / days-left
   - carry-forward scoping rules (in-cycle, carried-from-prev, pinned-out)
   - debt rollover calculation
   - all 5+ SMS parser patterns + reversal path (extract into a shared module for testability)
2. Add integration tests for API routes against a local Supabase (or mocked client).
3. Add GitHub Actions CI: lint + test on every push; block merge on failure.
4. Add Husky pre-commit hooks (lint-staged).

### Phase 4 — Code health (ongoing)

1. Rewrite `README.md` with actual setup instructions (env vars, Supabase migration order, MacroDroid configuration, Android build).
2. Extract the SPA into modules (`public/js/api.js`, `state.js`, `charts.js`, …) or migrate to React components progressively.
3. Unify the SMS parser: define patterns once (JSON config) consumed by both Node and Android, or move parsing fully server-side and make the Android app a thin forwarder.
4. Consider TypeScript for `src/` (JSDoc types as a lighter intermediate step).

---

## Part 3 — Suggested Future Implementations

### Near term (high value, low effort)

- **Recurring transactions** — auto-log rent/subscriptions each cycle with a review prompt instead of silent insertion.
- **CSV/Excel export & import** — `xlsx` is already a dependency but unused; wire up export of history and cycle summaries.
- **Budget templates** — clone planned amounts from any previous cycle into the next preview with one tap.
- **Multi-card support** — parse and surface which card was used; per-card spend breakdowns in Insights.
- **Notification digest mode** — batch SMS alerts into an hourly summary for small transactions (< EGP 50).

### Medium term

- **Analytics page**: month-over-month category trends, savings-rate tracking, top merchants, burn-rate forecast to end of cycle.
- **Goals & envelopes**: savings goals with progress bars funded from probable-surplus projections.
- **Shared households**: invite second user to a shared ledger (builds directly on completing Phase 1 properly).
- **Offline-first writes**: queue manual entries in IndexedDB while offline, sync on reconnect (service worker already caches the shell).
- **WhatsApp/Telegram bot**: alternative ingest channel alongside SMS for receipts sent digitally.

### Longer term

- **ML-assisted categorization**: learn from past categorizations to auto-suggest categories for uncategorized transactions (start with simple merchant→category frequency mapping stored in `user_sms_rules`-style table).
- **Native iOS companion** using the same webhook/token architecture validated by the Android app.
- **Bank OAuth aggregation** (e.g., open-banking providers covering Egyptian banks) as a more reliable source than SMS parsing.
- **End-to-end encryption option** for sensitive notes, encrypted client-side before persistence.

---

## Quick Reference — File Map of Findings

```
src/lib/push.js               C1 hardcoded VAPID keys; C3 no per-user targeting
src/lib/supabase.js           C2 anon client without user context
src/app/api/dashboard/*       C2/C3 no user filter; scalability (fetch-all)
src/app/api/action/*          C3 IDOR by id/name; C5 non-atomic split/reorder
src/app/api/webhook/*         fallback user resolution; solid dup-check
schema.sql                    non-idempotent seed insert
schema_v2_multiuser.sql       hardcoded email; OR user_id IS NULL RLS hole
public/index.html             2673-line monolith SPA
README.md                     placeholder content
(no tests, no CI anywhere)
```

*Generated as part of a full project review. Update this file as phases ship.*
