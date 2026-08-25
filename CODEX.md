# 🤖 CODEX Architecture & Engineering Reference: Personal Finance Dashboard v2.0

> **Status**: Synchronized with GitHub origin/main (Commit 130e576).  
> **Target Audience**: AI Coding Assistants (Codex / Antigravity), Core Engineers, and Maintainers.

---

## 🧭 1. Executive Summary & Architecture

The **Personal Finance Dashboard** is a multi-tenant, real-time budgeting application built with Next.js 16 (Turbopack) and Supabase PostgreSQL. It features an automated SMS ingestion pipeline for Egyptian bank messages (EGP), a native Android companion app with biometric app lock, Web Push notifications via VAPID, and an Apple/Linear dark-tech aesthetic PWA.

`	ext
finance-dashboard-next/
├── android/                         # Native Android Studio Project (Java/Android SDK 34)
│   └── app/src/main/java/com/finance/dashboard/
│       ├── MainActivity.java        # Webview container, Biometrics / Fingerprint lock
│       ├── SmsReceiver.java         # Native SMS BroadcastReceiver
│       ├── BankParser.java          # On-device Egyptian Bank regex & fuzzy parser
│       ├── NotificationActionReceiver.java # Interactive notification quick-actions
│       ├── TransactionBackupStore.java     # SQLite offline persistence & retry queue
│       └── TimeoutReceiver.java     # Session inactivity auto-lock
├── public/
│   ├── index.html                   # High-taste Vanilla JS/CSS PWA with Chart.js
│   ├── sw.js                        # Service Worker (Stale-While-Revalidate + Web Push)
│   ├── manifest.json                # PWA Standalone Manifest
│   └── icon.svg                     # Vector App Icon
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── action/route.js      # User-scoped mutations (split, save, categories, carry)
│   │   │   ├── auth/
│   │   │   │   ├── route.js         # Email/password authentication with HTTP-only cookies
│   │   │   │   └── google/route.js  # Google OAuth initiation & callback
│   │   │   ├── dashboard/route.js   # Cycle bounds, 100% metrics math, paged history
│   │   │   ├── push/
│   │   │   │   ├── send/route.js    # Authorized daily cron / push dispatch
│   │   │   │   └── subscribe/route.js # Token-based VAPID push subscription
│   │   │   └── webhook/route.js     # User-scoped bank SMS webhook ingestion
│   │   ├── layout.js                # Root layout
│   │   └── page.js                  # Entry redirect to /index.html
│   └── lib/
│       ├── auth.js                  # User extraction & HTTP cookie helpers
│       ├── push.js                  # Push notification dispatcher & rule engine
│       └── supabase.js              # Supabase client with auth scoping
├── docs/
│   ├── migrate_v2_safe.sql          # Safe non-destructive multi-user migration SQL
│   └── agents/                      # ADRs and agent guidelines
├── schema.sql                       # v1 Base schema
├── schema_v2_multiuser.sql          # v2 Multi-tenant schema with RLS & dynamic rules
├── ANDROID_APP_GUIDE.md             # Native Android build & APK installation guide
├── OPTIMIZATIONS_REPORT.md          # Benchmark and optimization audit
└── CODEX.md                         # This system documentation
`

---

## 🆕 2. Report on New Changes (Recent 25 Commits)

### 📱 A. Native Android Companion App (/android)
1. **Direct On-Device SMS Catching (SmsReceiver.java)**:
   - Listens for SMS_RECEIVED events with priority 999.
   - Parses Egyptian bank SMS on-device using BankParser.java and sends authenticated POST requests to /api/webhook.
2. **Offline Resilience (TransactionBackupStore.java)**:
   - If network connectivity fails, un-synced transactions are queued in local SQLite and automatically flushed when the connection is restored.
3. **Actionable Notification Quick-Actions (NotificationActionReceiver.java)**:
   - Notifications contain quick-action buttons: **Categorize**, **Mark Debt**, or **Dismiss**.
4. **Biometric / Fingerprint App Lock (MainActivity.java)**:
   - Integrates ndroidx.biometric.BiometricPrompt.
   - Settings toggle: **Fingerprint App Lock** with auto-lock on screen timeout or app switch.

---

### 👥 B. Multi-Tenant Architecture & Authentication (v2.0)
1. **Strict User Isolation**:
   - Added user_id UUID REFERENCES auth.users(id) across categories, 	ransactions, push_subscriptions, and sms_rules.
   - Primary data safely scoped to kr.wn20@gmail.com with multi-tenant RLS policies (schema_v2_multiuser.sql).
2. **Google OAuth Integration (/api/auth/google)**:
   - Supports 1-click **Sign in with Google** alongside email/password authentication.
   - Sets secure HTTP-only cookies (inance_access_token and inance_refresh_token).

---

### 🧩 C. Dynamic / Hybrid Visual SMS Rule Builder
1. **Interactive Visual Rule Manager**:
   - Added UI in Settings/Hub to view, test, create, and edit custom fuzzy bank SMS matching rules.
   - Dynamic regex rules are persisted in the sms_rules table and evaluated dynamically per-user.
2. **Sender Dropdown & Smart Fuzzy Matching**:
   - Automatically detects sender IDs (e.g. CIB, NBE, Instapay, Banque Misr, QNB, AlexBank, HSBC, BDC, FABMISR, Valu).

---

### 🎨 D. UI/UX & Design Overhaul (Apple / Linear Dark-Tech Aesthetic)
1. **High-Contrast Light Theme & Dark Theme**:
   - Implemented smooth theme switching with dedicated CSS token mapping (data-theme=light / dark).
2. **Universal Privacy Mode**:
   - Toggle to blur sensitive balances and transaction values for safe use in public environments.
3. **Dedicated Categories Page**:
   - Standalone tab with drag-and-drop / custom sort order management, budget progress bars, and creation modal.
4. **SVG Donut Chart**:
   - Interactive SVG donut chart with hover effects and corrected label rotation.
5. **Micro-Interactions & Form Polish**:
   - Double-submit protection with button loading states.
   - Split Modal remaining balance calculation and 1-click quick-fill helpers.
   - Carry-forward (📌) confirmation modal to eliminate accidental cycle moves.
   - Keyboard focus trapping and Escape modal closing.

---

### 🔔 E. Hardened Push Notification Pipeline
1. **Matched VAPID Pair & Self-Healing Pruning**:
   - Enforces valid VAPID public/private key pairs.
   - Stale/expired browser push endpoints (410 Gone / 404) are automatically purged from the database upon delivery failure.
2. **User-Scoped Automated Cron (/api/push/send)**:
   - Validates CRON_SECRET and executes budget rule evaluation scoped per user.

---

## 📐 3. Core Business Formulas & Domain Rules

### 🗓️ A. Monthly Cycle Boundaries
- Standard cycle runs from **Day 20 of Month $** to **Day 20 of Month +1$**.
- getCycleBounds(offset) calculates:
  - offset = 0: Current Active Cycle (isCurrent).
  - offset = 1: Next Cycle Preview (isNext).
  - offset < 0: Historical Read-Only Archives (isPast).

### 📊 B. Financial Formulas
1. **Live Net Balance**:
   \text{Live Net Balance} = \text{Total Income} - \text{Total Actual Outgoing Spending}
2. **Available Budget**:
   \text{Available Budget} = \text{Total Planned Budget} - \text{Total Actual Outgoing Spending}
3. **Probable Savings**:
   \text{Probable Savings} = \text{Total Income} - \text{Total Planned Budget}
4. **Commitments**:
   \text{Commitments} = \sum \max(0, \text{Category Planned} - \text{Category Actual})
5. **Next Cycle Debt Target**:
   \text{Next Cycle Debt Target} = \max(0, \text{Current Planned Debt} - \text{Current Paid Debt})

### 📌 C. Carried-Forward (is_carried_forward) Lifecycle
- **When pinned in Current Cycle**:
  - countInCalculations = false: 100% isolated from current cycle cash balance, total spending, and budget deductions.
- **When Next Cycle Activates (Day 20 arrives)**:
  - Automatically transitions into the newly active cycle as an active transaction.
  - Categorized items deduct from that category's budget; uncategorized items appear in **Needs Attention**; incoming items add to **Live Net Balance**.

---

## ⚠️ 4. Current Issues, Risks & Architectural Checklist

| Area | Current Status | Risk / Recommended Action |
| :--- | :--- | :--- |
| **1. Database Schema Migration** | Multi-user schema defined in schema_v2_multiuser.sql | If you have not yet executed docs/migrate_v2_safe.sql in your Supabase SQL Editor, run it once to ensure user_id and sms_rules columns/tables exist. |
| **2. Environment Variables** | Vercel production deployment | Ensure NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, WEBHOOK_SECRET, and CRON_SECRET are set in Vercel Environment Variables. |
| **3. Android APK Keystore** | Removed from repository | Release signing requires FINANCE_KEYSTORE* environment variables; never restore the keystore or passwords to source control. |
| **4. Google OAuth Redirects** | Shared by browser and Android WebView | Allow production, preview, and local origins deliberately in Supabase; Android currently uses the web origin through WebView, not a native redirect URI. |

---

## 🚀 5. Quick Commands Reference

`ash
# Install dependencies
npm install

# Run local development server
npm run dev

# Verify Next.js build
npm run build

# Deploy to Vercel production
npx vercel --prod
git push origin main
`

---

## 🧭 6. Codex Agent Handoff — Android Stabilization (2026-08-25)

### Current state
- Completed: SMS receiver now creates a local pending item and presents Confirm/Categorize/Dismiss notification actions.
- Completed: Five-minute timeout alarm sends untouched items to pending_sms.
- Completed: Boot retry, header-based webhook token transport, strict webhook authorization, WebView mixed-content/navigation restrictions, biometric resume gating, and environment-only release signing.
- Completed: Tracked android/app/release.keystore removed from the working tree and ignored going forward.
- Validation: backend route syntax check and npm run lint pass.
- Known limitation: Android build is not yet verified because the repository has no Gradle wrapper and no system Gradle executable.

### Remaining work — execute in order
1. Replace the SharedPreferences JSON backup with a transactional SQLite/Room queue. Preserve old JSON records through a one-time migration.
2. Add stable idempotency keys to the DB migration and webhook inserts; make confirm, retry, and timeout operations safe under duplicate delivery.
3. Align Android custom-rule fields with user_sms_rules (pattern_name, contains_keyword, default_category_id) and resolve category names/IDs consistently.
4. Add Android unit tests for Arabic/English bank SMS parsing, notification action payloads, timeout transitions, retry state changes, and duplicate messages.
5. Add the Gradle wrapper or document the required Gradle/Android SDK versions, then run debug and release builds.
6. Update this section after every phase with files changed, validation results, and any blocker.

### Agent instructions
- Read this section before changing Android or webhook code.
- Keep this section current during work so another agent can resume without reconstructing context.
- Do not restore or commit signing keys/passwords.

### Checkpoint — SQLite queue phase
- Staged: TransactionBackupStore now uses SQLiteOpenHelper with indexed status queries.
- Staged: Existing finance_tx_backup/saved_transactions JSON is migrated once into SQLite and then removed.
- Staged: Confirmation, dismissal, timeout, and retry paths use local record IDs.
- Next: add pending queue idempotency schema/API fields, align custom-rule category contracts, then add tests/build tooling.

### Checkpoint — idempotency phase
- Staged: pending_sms migration now adds idempotency_key plus a per-user unique partial index.
- Staged: Android timeout/retry/confirm payloads carry the local queue ID.
- Staged: webhook pending insertion accepts idempotency_key and rejects repeated pending requests.
- Discovered: custom-rule UI used category while action API expected categoryId; this is being aligned now.

### Checkpoint — current completion state
- Applied: SQLiteOpenHelper offline queue with indexed status storage and one-time legacy JSON migration.
- Applied: local record IDs now drive confirm/dismiss/timeout/retry status updates.
- Applied: pending_sms idempotency_key migration and unique per-user partial index in both schema files.
- Applied: Android timeout and retry payloads include idempotency_key; webhook rejects repeated pending inserts.
- Applied: custom-rule UI now sends categoryId as well as category.
- Applied: BankParserTest.java covers debit expense, Arabic salary, and unrelated SMS cases.
- Validation pending: npm lint after final edits; Android Gradle test/build remains blocked because gradle and gradlew are unavailable.


### Final checkpoint — 2026-08-25
- Validation passed: node --check on webhook route and npm run lint.
- Added but not executed: Android JUnit BankParserTest; execution requires Android/Gradle toolchain.
- Android build blocker confirmed: no android/gradlew, no system gradle command, and no psql command for live migration verification.
- Required deployment follow-up: run docs/migrate_v2_safe.sql in Supabase before using idempotency_key; provide CI/local FINANCE_KEYSTORE, FINANCE_KEYSTORE_PASSWORD, FINANCE_KEY_PASSWORD, and FINANCE_KEY_ALIAS only outside source control.
- Working tree changes are intentionally uncommitted for human review.

---

## 🔐 7. Google OAuth / Browser–Android Session Audit (2026-08-25)

### Verified architecture
There is currently one Google OAuth implementation shared by both surfaces:

1. Browser and Android WebView display the same login UI in public/index.html.
2. Both call GET /api/auth/google.
3. src/app/api/auth/google/route.js starts Supabase Google OAuth with redirect origin/index.html.
4. The callback is handled in the page hash by handleOAuthHashCallback().
5. The page posts the Supabase access/refresh tokens to POST /api/auth.
6. src/app/api/auth/route.js validates the access token and sets finance_access_token and finance_refresh_token HTTP-only cookies.
7. Android has no native Google OAuth SDK, client ID, custom scheme, app link, or OAuth callback activity. It loads the web flow in MainActivity's WebView.

### Decision
Keep one Supabase identity and one web OAuth flow. Do not add a separate native Google identity flow unless the app is later converted from a WebView container to a fully native client. Separate native and web OAuth flows would create avoidable redirect, account-linking, token-storage, and logout inconsistencies.

### Organization plan
- Treat browser and Android WebView as two clients of the same web session contract.
- Centralize authentication documentation in this section and keep redirect URLs/environment settings in one deployment checklist.
- Add an explicit auth-client marker for diagnostics only (browser vs Android WebView); never use it to create separate users.
- Verify Google redirect allowlists for production, preview, local development, and Android WebView origins.
- Add session-refresh cookie rotation: when refreshSession succeeds, update both HTTP-only cookies in the response.
- Add an OAuth callback error state and clear URL fragment/query data after success or failure.
- Test four paths: browser login, Android WebView login, browser logout followed by Android access, and Android logout followed by browser access.
- Retain email/password as a fallback, but keep all providers mapped to the same Supabase user account.

### Current conclusion
The old web Google OAuth logic is still active and is also the Android app's effective Google OAuth path. No duplicate native OAuth implementation was found.


---

## 🧩 8. SMS Rules Organization Audit — Started (2026-08-25)

Scope: reconcile Sender detection, SMS content matching, what-to-catch behavior, rule persistence, Android parser behavior, backend webhook behavior, and the Hub UI/UX. No implementation changes are authorized from this audit until the proposed plan is reviewed.

### Audit findings
- The UI calls the field “Bank Sender / Keyword”; one value is used for two different concepts.
- Detected senders are seeded from a hardcoded list and transaction history source labels, not the original SMS originating address. Merchants and card labels can therefore appear as “senders.”
- Runtime matching is only normalized substring matching. The UI calls it fuzzy matching, but there is no sender-aware or structured content rule.
- The UI preview, Android BankParser, and backend webhook each implement different amount, direction, merchant, and currency logic.
- Browser localStorage is the practical rule source for the UI and Android bridge. Existing DB rules are not loaded back into localStorage/Android on startup.
- New UI rules use local rule_Date IDs, while deleteSmsRule deletes by the database UUID; DB deletion can silently miss the intended rule.
- addSmsRule and deleteSmsRule swallow Supabase errors and return success, so the UI can report success when persistence failed.
- There is no edit action, enable/disable control, priority/order, match statistics, last-seen data, or clear “catch/ignore” policy.
- Custom rules default to outgoing in the backend/Android path unless the entire SMS matches a separate income pattern; the rule model cannot explicitly declare direction.
- The schema stores contains_keyword, merchant_extractor, and default_category_id, but the UI does not provide a real extractor or structured content/action configuration.

### Recommended target model
Each rule should have one stable database UUID and these explicit concerns:
1. Sender match: exact sender ID plus optional normalized aliases.
2. Content match: contains, regex, or sample-derived pattern; never silently treat a sender label as message content.
3. Transaction interpretation: catch mode, direction, amount extractor, merchant extractor, and category.
4. Safety/lifecycle: active flag, priority, confirmation policy, created/updated timestamps, and match counters.
5. Device distribution: versioned DB rules synced to Android; local cache is only a read-through/offline cache.

### Proposed UX
Use a four-step “Create SMS rule” flow:
1. Choose or paste the sender ID.
2. Paste a real sample SMS and show highlighted sender, amount, merchant, and direction.
3. Choose what to catch: expense, income, refund, or ignore; choose category and confirmation mode.
4. Review the exact rule summary and save/test it.

The rules list should be grouped by sender and show Active/Paused, direction, category, sample match, last matched, and actions: Test, Edit, Pause, Delete. Keep fuzzy sender suggestions as an assisted input feature only; runtime matching should be deterministic and auditable.

### Implementation plan
1. Define one Rule JSON/schema contract and migrate existing rules into it.
2. Fix UUID ownership and persistence: return inserted DB rows, use UUIDs in the UI, load DB rules at login, and surface mutation errors.
3. Add sender provenance to SMS ingestion and store the originating address separately from merchant/source.
4. Create one shared matching/extraction contract consumed by backend and Android; add explicit direction and catch/ignore behavior.
5. Replace the current Hub panel with the four-step wizard and grouped rule management list.
6. Add safe preview/test fixtures for Egyptian bank, wallet, Arabic, English, promotion, and unrelated SMS messages.
7. Add audit logging/match counters and verify browser, Android WebView, offline cache, and multi-user isolation.
8. Update this section after each implementation phase before handing work to another agent.

### SMS rules implementation — Phase 1 started
- Goal: establish one rule contract and make database UUIDs/persistence authoritative.
- Planned files: schema_v2_multiuser.sql, docs/migrate_v2_safe.sql, src/app/api/action/route.js, src/app/api/webhook/route.js, public/index.html, Android rule bridge/parser.
- Safety: preserve existing local rules through normalization; do not delete rules during migration.
- This phase is active; update this section at each checkpoint.
\n## SMS Rules Organization - Implementation Checkpoint (2026-08-25)\n\nImplemented the approved reorganization:\n- Added shared rule fields and safe migration columns for sender, content, match type, direction, catch mode, priority, confirmation, and timestamps.\n- Made API-created/updated rules return authoritative database rows; delete now requires a database UUID and errors are surfaced.\n- Dashboard now loads smsRules from the authenticated user database; browser local storage is cache/fallback only after server load.\n- Replaced the unstructured SMS form with Sender, Sample SMS, Content, Direction/Catch, and Category/Confirmation sections with server-backed edit/pause/delete controls.\n- Removed transaction-history labels from sender suggestions to avoid confusing merchants with SMS origins.\n- Added sender-aware matching to Android and webhook paths, including sender-only rules and ignore rules.\n- Preserved sender provenance through Android offline SQLite migration v2, retries, and notification actions.\n\nValidation: web JavaScript/API syntax checks pass; npm run lint passes; git diff --check passes after EOF normalization. Android Gradle compilation remains pending because the checkout contains no gradlew wrapper and no system Gradle executable was available.\n\nNext handoff: run the SQL migration in the deployed Supabase project, then verify add/edit/pause/delete and sender/content matching on web and Android with representative SMS fixtures.\n
## Android WebView Dashboard Load Incident - 2026-08-25

Diagnosis:
- The deployed dashboard URL returned HTTP 200 from the host during verification; browser delivery is healthy.
- MainActivity restored saved WebView state after relaunch, so a previously aborted page could remain blank.
- onReceivedError retried only once after 1.2 seconds, reused the same URL/cache, then hid progress without a recovery affordance.

Applied fix:
- Android startup now uses a cache-bypassing dashboard load and does not restore stale failed WebView state.
- Main-frame WebView failures are logged and retried up to five times with exponential backoff, cache bypass, and a timestamp query.
- Pull-to-refresh uses the same recovery path and resets retry state.
- Successful loads restore normal cache mode and clear retry state.

Validation pending: Java structural checks and web lint/syntax checks; Android Gradle build remains unavailable because this checkout has no gradlew wrapper or system Gradle executable.
