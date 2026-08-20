# 💰 Personal Finance Dashboard — Comprehensive Codex Reference

> **Document Purpose**: This document serves as the complete architectural, technical, and domain reference for AI coding agents (such as **Codex**) and human developers working on this codebase.

---

## 🧭 1. Executive Project Overview

A high-performance, real-time **Personal Finance & Budgeting Progressive Web App (PWA)** customized for Egyptian banking workflows (EGP). It tracks income, categorized expenses, debt repayments, and cycle budgets with live SMS ingestion from an Android phone (via MacroDroid) and Web Push notifications.

### 🛠️ Technology Stack
- **Framework**: Next.js 16 (App Router with Turbopack).
- **Frontend**: Lightweight, high-performance vanilla JS/HTML/CSS SPA (public/index.html) running as a standalone PWA with Service Worker (public/sw.js) and Chart.js.
- **Database**: Supabase PostgreSQL (@supabase/supabase-js).
- **Hosting & Deployment**: Vercel Serverless Functions (/api/*).
- **SMS Automation**: MacroDroid (Android) → HTTP POST to /api/webhook.
- **Push Notifications**: web-push (VAPID protocol) with automated budget alerts.

---

## 🗂️ 2. Project Directory Structure

`	ext
finance-dashboard-next/
├── public/
│   ├── index.html        # Main PWA UI (Single-Page App, vanilla JS, Chart.js)
│   ├── sw.js             # Service Worker (Stale-While-Revalidate caching, Push events)
│   ├── manifest.json     # PWA manifest (standalone mode, theme colors)
│   └── icon.svg          # Dashboard vector logo
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── action/route.js        # Transaction mutations (save, split, category edits)
│   │   │   ├── dashboard/route.js     # Cycle data aggregation, math, and debt metrics
│   │   │   ├── push/
│   │   │   │   ├── send/route.js      # Automated push trigger evaluation / cron endpoint
│   │   │   │   └── subscribe/route.js # Web Push subscription registration
│   │   │   └── webhook/route.js       # Bank SMS webhook ingest (5 exact formats)
│   │   ├── layout.js                  # Root Next.js layout
│   │   └── page.js                    # Next.js entrypoint (redirects to /index.html)
│   └── lib/
│       ├── push.js                    # Web Push notification dispatcher & rule engine
│       └── supabase.js                # Supabase client initializer
├── next.config.mjs                    # Next.js configuration & HTTP security headers
├── package.json                       # Dependencies & build scripts
├── schema.sql                         # Supabase database schema, tables & indexes
└── PROJECT_OVERVIEW_CODEX.md          # This Codex documentation
`

---

## 📐 3. Core Business & Domain Logic

### 🗓️ A. Billing Cycle (20th of the Month)
- The user's financial month runs from the **20th of Month M** to the **20th of Month M+1** (e.g. AUG / SEP '26 starts Aug 20, 00:00:00 and ends Sep 20, 00:00:00).
- Handled dynamically via getCycleBounds(offset) in src/app/api/dashboard/route.js:
  - offset = 0 → Current Active Cycle.
  - offset = 1 → Next Cycle Preview.
  - offset < 0 → Historical Cycle Archives (Read-Only).

### 📊 B. Financial Metrics & Formulas
1. **Live Net Balance (Cash in Hand)**:
   \text{Live Net Balance} = \text{Total Income} - \text{Total Actual Spending}
2. **Available Budget (Unspent Allowance)**:
   \text{Available Budget} = \text{Total Planned Budget} - \text{Total Actual Spending}
3. **Probable Savings (Projected Surplus)**:
   \text{Probable Savings} = \text{Total Income} - \text{Total Planned Budget}
4. **Commitments**:
   \text{Commitments} = \sum \max(0, \text{Category Planned} - \text{Category Actual})

---

### 💳 C. Debt & Credit Card Logic
- Identified by category name matching Debt or Credit Card (categories.name).
- **Planned vs Payed Universal Selector**:
  - **📈 Planned (Liability Target)**: Directly increments the liability ceiling (categories.planned_amount) in Supabase.
  - **💵 Payed (Repayment)**: Logs an actual outgoing transaction linked to the Debt category, reducing the remaining debt.
- **Unpaid Debt Rollover**:
  \text{Next Cycle Debt Target} = \max(0, \text{Current Planned Debt} - \text{Current Paid Debt})
  When viewing Next Cycle Preview (offset = 1), Debt.planned_amount automatically inherits this remainder.
- **Uncategorizing Debt Reversion**: Moving a transaction out of Debt prompts the user to shrink planned_amount back by the transaction amount to preserve budget accuracy.

---

### 📌 D. Carried-Forward (is_carried_forward) Lifecycle & Isolation
Transactions can be carried forward into the next month by clicking 📌:
1. **In Current Cycle (offset = 0)**:
   - A transaction pinned *in the current cycle* has is_carried_forward = true.
   - **Isolation**: It is **100% excluded** from the current cycle's Live Net Balance, Total Income, Total Actual Spend, Available Budget, and category spend.
   - It remains visible in History with a highlighted 📌 badge.
2. **In Next Cycle Preview (offset = 1)**:
   - Pinned transactions appear in the Next Cycle Preview card and are counted toward next month's projections.
3. **Automatic Arrival on Day 20 (New Cycle Start)**:
   - When the date reaches the 20th, the new cycle activates.
   - Carried-over transactions from previous cycles are automatically pulled into the newly active cycle as active items:
     - Categorized items deduct from that category's budget and show in History.
     - Uncategorized items appear in **Needs Attention** for review.
     - Incoming items count toward **Live Net Balance** and **Total Income**.

---

## 📥 4. Webhook & Bank SMS Parsing Engine (/api/webhook)

Accepts raw text or JSON POST requests from **MacroDroid** on Android without noise or false triggers.

### 📋 The 5 Exact Supported SMS Formats:
1. **Salary Deposit (Arabic)**:
   - *Pattern*: /اضافة راتبك|إضافة راتبك/i
   - *Example*: عزيزى العميل تم اضافة راتبك بمبلغ \n 24980EGP \n ورصيدك  45060.80EGP
   - *Action*: Extracts 24980, logs incoming (Salary), ignores balance 45060.80.
2. **Instapay Sent (Outgoing Expense)**:
   - *Pattern*: /IPN transfer sent/i
   - *Example*: IPN transfer sent with amount of EGP 180.00 from 8472 on 19/08 at 02:35 PM...
   - *Action*: Extracts 180.00, logs outgoing under *Needs Attention*.
3. **Instapay Received (Incoming Income)**:
   - *Pattern*: /IPN transfer re(ceived|cieved)/i
   - *Example*: IPN transfer received with amount of EGP 180.00 from 8472 on 19/08 at 02:35 PM...
   - *Action*: Extracts 180.00, logs incoming (Instapay Received).
4. **Debit Card (Outgoing Expense)**:
   - *Pattern*: /Your Debit Card/i
   - *Example*: Your Debit Card **4739 had a Successful transaction of EGP 79.00 @MERCHANT,your available bal...
   - *Action*: Extracts 79.00 and @MERCHANT, logs outgoing.
5. **Credit Card (Outgoing Expense)**:
   - *Pattern*: /Your Credit Card/i
   - *Example*: Your Credit Card ****9350 had a Successful transaction of EGP 78 @MERCHANT, your available bal...
   - *Action*: Extracts 78 and @MERCHANT, logs outgoing.

*All other messages return 200 Ignored: No pattern matched with zero noise.*

---

## 🗄️ 5. Database Schema Reference (Supabase PostgreSQL)

### Tables:

#### categories
| Column | Type | Description |
| :--- | :--- | :--- |
| id | uuid (PK) | Unique Category ID |
| 
ame | 	ext (Unique) | Category Name (e.g. Food & Groceries, Debt) |
| planned_amount | 
umeric | Monthly planned budget in EGP |
| sort_order | integer | Drag-and-drop / custom order |
| created_at | 	imestamptz | Creation timestamp |

#### 	ransactions
| Column | Type | Description |
| :--- | :--- | :--- |
| id | uuid (PK) | Unique Transaction ID |
| kind | 	ext | 'outgoing' or 'incoming' |
| mount | 
umeric | Transaction value in EGP |
| source_or_merchant | 	ext | Bank card, Instapay account, or store merchant |
| 
ote | 	ext | User notes or sub-details |
| 	ransaction_date | 	imestamptz | Date when expense/income occurred |
| category_id | uuid (FK) | Reference to categories.id (nullable for Needs Attention) |
| is_carried_forward | oolean | 	rue if pinned to carry to next billing cycle |
| created_at | 	imestamptz | Record creation timestamp |

#### push_subscriptions
| Column | Type | Description |
| :--- | :--- | :--- |
| id | uuid (PK) | Unique Subscription ID |
| endpoint | 	ext (Unique)| Browser push endpoint URL |
| keys | jsonb | { p256dh, auth } encryption keys |
| created_at | 	imestamptz | Subscription creation timestamp |

---

## 🔔 6. Web Push & Budget Triggers (src/lib/push.js)

Automated notifications evaluate the following rules:
- **80% Warning**: Triggered when a category reaches ≥ 80% of its planned budget.
- **100% Over-Budget Alert**: Triggered when a category exceeds its planned limit.
- **Needs Attention Alert**: Triggered when 5 or more uncategorized transactions are pending.
- **Low Balance Alert**: Triggered when remaining budget balance falls below 10,000 EGP.
- **Instant SMS Transaction Alert**: Fired the second an SMS is received via the webhook.

---

## 📜 7. Summary of Changes & Milestones

1. **Ported from Google Apps Script / Google Sheets to Next.js + Supabase**:
   - Replaced Google Sheets with Supabase PostgreSQL.
   - Built a high-performance standalone PWA.
2. **Simplified Debt Action Modal**:
   - Streamlined prompts across all entry points (Manual Add, Needs Attention, History change, Splits) to clear **📈 Planned** vs **💵 Payed** choices.
3. **Carried Forward Pin Persistence & Rollover Fix**:
   - Switched from browser storage to persistent database field is_carried_forward.
   - Resolved the cycle boundary bug: carried transactions now seamlessly arrive in the active cycle on day 20.
4. **Performance & Security Upgrades**:
   - Added Stale-While-Revalidate service worker caching (0ms launch).
   - Visibility-aware polling to eliminate battery drain when the screen is off.
   - Added security headers (X-Frame-Options, 
osniff, Referrer-Policy).
5. **MacroDroid Webhook Standardization**:
   - Locked webhook parsing strictly to the 5 official bank SMS templates with zero noise.
   - Tested and verified live production endpoint: https://finance-dashboard-next-two.vercel.app/api/webhook.

---

## 🚀 8. Developer Quick Reference & Commands

`ash
# Install dependencies
npm install

# Run local development server
npm run dev

# Build for production
npm run build

# Deploy to Vercel production
npx vercel --prod
git push origin main
`

### 🔐 Webhook Authentication
- `/api/webhook` requires the `WEBHOOK_SECRET` Vercel environment variable.
- MacroDroid must send either `Authorization: Bearer <WEBHOOK_SECRET>` or `x-webhook-secret: <WEBHOOK_SECRET>`.
- Requests return `503` when the server secret is not configured and `401` when the supplied secret is invalid.
- The secret must not be committed to the repository or sent as a URL query parameter.