import { NextResponse } from 'next/server';
import webpush from 'web-push';
import { supabase } from '@/lib/supabase';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || 'BPnDeX4aUsrrHasl3PVoX9Cc2jWmbN9Doi1PXThwupBsJOjFWLioEWEmaXcBUAhA3Ezl3aIUFk81rYA8i3jFYXA';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '55Jm7p3LrpUYkB9OYrt6IP9qHS-7wZG0hs_w80TSz7M';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@personalfinance.app';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { type, subscription, customPayload } = body;

    // 1. Fetch subscriptions from Supabase (or use the one passed directly for instant test)
    let subs = [];
    if (subscription) {
      subs = [subscription];
    } else {
      const { data: dbSubs, error } = await supabase.from('push_subscriptions').select('*');
      if (!error && dbSubs && dbSubs.length > 0) {
        subs = dbSubs.map(s => ({
          endpoint: s.endpoint,
          keys: s.keys
        }));
      }
    }

    if (subs.length === 0) {
      return NextResponse.json({ error: 'No push subscriptions found. Please enable notifications on your device first.' }, { status: 404 });
    }

    // 2. Prepare notifications to send
    const notificationsToSend = [];

    if (type === 'test') {
      notificationsToSend.push({
        title: '🔔 Push Notifications Active!',
        body: 'Your Expenses dashboard is connected to native push alerts.',
        icon: '/icon.svg',
        url: '/index.html'
      });
    } else if (type === 'custom' && customPayload) {
      notificationsToSend.push(customPayload);
    } else {
      // 3. Evaluate Rule Triggers against live budget data
      const now = new Date();
      const cycleStartDay = 20;
      let cycleMonth = now.getMonth();
      let cycleYear = now.getFullYear();
      if (now.getDate() < cycleStartDay) {
        cycleMonth -= 1;
        if (cycleMonth < 0) { cycleMonth = 11; cycleYear -= 1; }
      }
      const startOfMonth = new Date(cycleYear, cycleMonth, cycleStartDay).toISOString();

      let nextCycleMonth = cycleMonth + 1;
      let nextCycleYear = cycleYear;
      if (nextCycleMonth > 11) { nextCycleMonth = 0; nextCycleYear += 1; }
      const endOfCycle = new Date(nextCycleYear, nextCycleMonth, cycleStartDay);
      const midnightNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const daysLeft = Math.round((endOfCycle - midnightNow) / (1000 * 60 * 60 * 24));

      const { data: categories } = await supabase.from('categories').select('*');
      const { data: transactions } = await supabase.from('transactions').select('*').gte('transaction_date', startOfMonth);

      if (categories && transactions) {
        let totalPlanned = 0;
        let totalActual = 0;
        const catMap = {};
        categories.forEach(c => {
          catMap[c.id] = { name: c.name, planned: Number(c.planned_amount), actual: 0 };
          if (c.name !== 'Uncategorized') totalPlanned += Number(c.planned_amount);
        });

        let uncatCount = 0;
        transactions.forEach(t => {
          if (t.kind === 'outgoing') {
            totalActual += Number(t.amount);
            if (t.category_id && catMap[t.category_id]) {
              catMap[t.category_id].actual += Number(t.amount);
            } else {
              uncatCount++;
            }
          }
        });

        const remainingBalance = totalPlanned - totalActual;

        // Rule 1: Category Budget Alerts (80% and >100%)
        Object.values(catMap).forEach(c => {
          if (c.planned > 0) {
            const ratio = (c.actual / c.planned) * 100;
            if (ratio >= 100) {
              notificationsToSend.push({
                title: `🚨 Over Budget: ${c.name}`,
                body: `Spent EGP ${c.actual.toLocaleString()} of EGP ${c.planned.toLocaleString()} (${Math.round(ratio)}%). Over by EGP ${(c.actual - c.planned).toLocaleString()}.`,
                icon: '/icon.svg',
                url: '/index.html'
              });
            } else if (ratio >= 80) {
              notificationsToSend.push({
                title: `⚠️ Budget Warning: ${c.name}`,
                body: `Spent EGP ${c.actual.toLocaleString()} of EGP ${c.planned.toLocaleString()} (${Math.round(ratio)}%). EGP ${(c.planned - c.actual).toLocaleString()} remaining.`,
                icon: '/icon.svg',
                url: '/index.html'
              });
            }
          }
        });

        // Rule 2: Needs Attention (5 or more items)
        if (uncatCount >= 5) {
          notificationsToSend.push({
            title: `📋 ${uncatCount} Transactions Need Attention`,
            body: `You have ${uncatCount} uncategorized transactions waiting for review. Tap to categorize.`,
            icon: '/icon.svg',
            url: '/index.html'
          });
        }

        // Rule 3: Low Balance (< 10,000 EGP)
        if (remainingBalance < 10000 && remainingBalance > 0) {
          notificationsToSend.push({
            title: `🚨 Low Balance Alert`,
            body: `Remaining cycle balance is EGP ${remainingBalance.toLocaleString()} (below EGP 10,000 threshold).`,
            icon: '/icon.svg',
            url: '/index.html'
          });
        }

        // Rule 4: Days Left Countdown (if requested as daily alert)
        if (type === 'daily_status' || notificationsToSend.length === 0) {
          notificationsToSend.push({
            title: `⏳ Cycle Status: ${daysLeft} Days Left`,
            body: `Current cycle ends in ${daysLeft} days. Spent: EGP ${totalActual.toLocaleString()} | Balance: EGP ${remainingBalance.toLocaleString()}.`,
            icon: '/icon.svg',
            url: '/index.html'
          });
        }
      }
    }

    // 4. Send all notifications to all subscriptions
    const results = [];
    for (const sub of subs) {
      for (const payload of notificationsToSend) {
        try {
          await webpush.sendNotification(sub, JSON.stringify(payload));
          results.push({ success: true, title: payload.title });
        } catch (err) {
          console.error('Failed to send push to', sub.endpoint, err.message);
          // If subscription is expired or unsubscribed (410 / 404), delete from database
          if (err.statusCode === 410 || err.statusCode === 404) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          }
          results.push({ success: false, error: err.message });
        }
      }
    }

    return NextResponse.json({
      success: true,
      sentCount: results.filter(r => r.success).length,
      notifications: notificationsToSend
    });

  } catch (err) {
    console.error('Push Send Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
