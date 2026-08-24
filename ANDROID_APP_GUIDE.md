# Financial Dashboard — Native Android App & Multi-User Architecture Guide

This document explains the complete architecture, implementation details, and operational workflows for the **Financial Dashboard Android App** and **Multi-User Backend (v2.0)**.

---

## 1. System Architecture Overview

The solution combines three powerful layers into a unified ecosystem:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Android APK Architecture                          │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. NATIVE BACKGROUND SMS ENGINE (Replaces MacroDroid)                 │
│     ├── BroadcastReceiver (`SmsReceiver.java`)                        │
│     ├── Built-in Regex Parser (`BankParser.java`)                      │
│     ├── Heads-Up Interactive Notification:                             │
│     │   [ 💸 EGP 180.00 Spent @ Starbucks ]                            │
│     │   [ ✅ Confirm ]  [ 🛒 Groceries ]  [ 🍔 Dining ]  [ ❌ Dismiss ] │
│     │               │                                                  │
│     │               ├── Tapped ──► Background HTTP POST /api/webhook   │
│     │               └── Untapped > 5 min ──► Queued to Pending Inbox   │
│     │                                                                  │
│  2. HARDWARE-ACCELERATED APP CONTAINER                                 │
│     ├── Fullscreen WebView with native SwipeRefreshLayout              │
│     ├── JavaScript Bridge for Haptic Feedback (`window.AndroidApp`)    │
│     └── Loads live production UI (`https://finance-dashboard-next-two.vercel.app`)
│                                                                        │
│  3. MULTI-USER CLOUD BACKEND (Supabase + Next.js Vercel)               │
│     ├── Row-Level Security (RLS) on all user data                      │
│     ├── Personal Data Safe: Assigned to `kr.wn20@gmail.com`            │
│     ├── New User Auto-Provisioning (General default categories)        │
│     ├── `pending_sms` Inbox Table (For review & later confirmation)    │
│     └── `user_sms_rules` (Customizable SMS pattern matching)           │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Native SMS Trigger & Notification Workflow (No MacroDroid Needed)

### A. How Transactions Are Detected
1. **SMS Arrival**: When an SMS from a bank or payment service (e.g. CIB, NBE, Banque Misr, InstaPay, Vodafone Cash) arrives, Android fires the `SmsReceiver`.
2. **Regex Parsing (`BankParser.java`)**:
   - **Salary Deposits**: `اضافة راتبك|إضافة راتبك` -> extracts amount as income.
   - **InstaPay Sent**: `IPN transfer sent` -> extracts amount and source account.
   - **InstaPay Received**: `IPN transfer received` -> extracts amount and sender.
   - **Debit Cards**: `Your Debit Card **XXXX` -> extracts amount and `@Merchant`.
   - **Credit Cards**: `Your Credit Card ****XXXX` -> extracts amount and `@Merchant`.
   - **Refunds / Reversals**: `Reversed|Refunded|استرجاع` -> matches original outgoing expense and credits refund.
   - **Custom Rules**: Evaluates user-defined keywords from `user_sms_rules`.

### B. Interactive Heads-Up Notification
Upon detection, a high-priority Android notification is posted:
- **`[✅ Confirm]`**: Immediately sends the expense to your private dashboard.
- **`[🛒 Groceries]`**: Auto-assigns to *Groceries & Supermarket* and logs in 1 tap.
- **`[🍔 Dining]`**: Auto-assigns to *Food & Dining* and logs in 1 tap.
- **`[❌ Dismiss]`**: Clears the notification without logging.

### C. The 5-Minute Safety Timeout (Pending Inbox)
If you are busy or your phone is locked and you do not interact with the notification within **5 minutes**:
- The notification is dismissed automatically.
- The transaction is securely queued into the **`pending_sms`** table in Supabase.
- When you open the app later, a **"Pending Transactions Inbox"** banner appears so you can confirm or categorize them at your convenience. Nothing is ever lost or logged without your consent.

---

## 3. Multi-User Database & Safe Data Migration

### A. Protecting Your Existing Personal Data (`kr.wn20@gmail.com`)
- A non-destructive database migration script (`schema_v2_multiuser.sql`) adds `user_id` columns with foreign keys to `auth.users(id)`.
- All pre-existing transactions, categories, budgets, debt rollover targets, and historical cycle snapshots are linked directly to `kr.wn20@gmail.com`.
- Row-Level Security (RLS) guarantees complete privacy.

### B. General Category Template for New Users
When any other user signs up in the future, the database trigger (`handle_new_user()`) automatically seeds their workspace with standardized, general categories:
1. 🍔 **Food & Dining**
2. 🛒 **Groceries & Supermarket**
3. 🚗 **Transportation & Fuel**
4. 💡 **Bills & Utilities**
5. 🏠 **Housing & Rent**
6. 🛍️ **Shopping & Personal**
7. 💊 **Health & Medical**
8. 💳 **Debt & Credit Card**
9. 🎯 **Savings & Investments**
10. ❓ **Uncategorized**

---

## 4. Android Project Structure

The native Android project is strictly isolated under [`/android`](file:///root/Financial_Dashboard/android) to ensure the live Next.js web application and Vercel deployments are never disrupted:

```
android/
├── app/
│   ├── build.gradle
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/finance/dashboard/
│       │   ├── MainActivity.java               (Fullscreen hardware-accelerated WebView & JS bridge)
│       │   ├── BankParser.java                 (Egyptian banks & InstaPay SMS parser)
│       │   ├── SmsReceiver.java                (Background broadcast receiver & heads-up alerts)
│       │   ├── NotificationActionReceiver.java (Async HTTP webhook dispatcher for button taps)
│       │   ├── TimeoutReceiver.java            (5-minute pending queue scheduler)
│       │   └── BootReceiver.java               (Boot listener for continuous background readiness)
│       └── res/
│           ├── layout/activity_main.xml        (SwipeRefreshLayout + WebView + ProgressBar)
│           ├── values/colors.xml
│           ├── values/strings.xml
│           ├── values/styles.xml
│           └── xml/network_security_config.xml
├── build.gradle
├── gradle.properties
└── settings.gradle
```

---

## 5. How to Build & Install the APK

### Building with Gradle:
```bash
cd /root/Financial_Dashboard/android
./gradlew assembleRelease
# The compiled APK is generated at:
# app/build/outputs/apk/release/app-release-unsigned.apk (or app-debug.apk)
```

### Installing on Android Device:
1. Transfer the `.apk` file to your Android phone (via USB cable, Google Drive, or direct link).
2. Open the file on your device and tap **Install** (allow *Install from Unknown Sources* if prompted).
3. Open **Financial Dashboard** and grant **SMS** & **Notification** permissions when prompted.
4. All future bank SMS messages will now trigger instant, actionable notifications with 1-tap logging!

---

## 6. Live Web Application Boundary

- **Production URL**: [https://finance-dashboard-next-two.vercel.app](https://finance-dashboard-next-two.vercel.app)
- **GitHub Repository**: [https://github.com/mandid9/Financial_Dashboard.git](https://github.com/mandid9/Financial_Dashboard.git)
- The web app remains fully active, performant, and responsive across both desktop browsers and mobile web.
