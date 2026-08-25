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
| **3. Android APK Keystore** | Release keystore checked in (ndroid/app/release.keystore) | Used for local debug/release building via Android Studio. Keep keystore passwords secure. |
| **4. Google OAuth Redirects** | Route at /api/auth/google | In Supabase Dashboard $\rightarrow$ Auth $\rightarrow$ URL Configuration, ensure https://finance-dashboard-next-two.vercel.app is added to Allowed Redirect URLs. |

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
