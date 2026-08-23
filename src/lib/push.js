import webpush from 'web-push';
import { supabase } from '@/lib/supabase';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || 'BPnDeX4aUsrrHasl3PVoX9Cc2jWmbN9Doi1PXThwupBsJOjFWLioEWEmaXcBUAhA3Ezl3aIUFk81rYA8i3jFYXA';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '55Jm7p3LrpUYkB9OYrt6IP9qHS-7wZG0hs_w80TSz7M';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@personalfinance.app';

try {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} catch (e) {
  console.warn('VAPID setup warning:', e.message);
}

/**
 * Send a notification payload to all registered subscriptions in Supabase.
 */
export async function sendPushToAll(payload) {
  try {
    const { data: dbSubs, error } = await supabase.from('push_subscriptions').select('*');
    if (error || !dbSubs || dbSubs.length === 0) {
      console.log('No push subscriptions found in database.');
      return { success: true, count: 0 };
    }

    const payloadStr = JSON.stringify(payload);
    let successCount = 0;

    for (const sub of dbSubs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payloadStr);
        successCount++;
      } catch (err) {
        console.error('Failed to send push to device:', sub.endpoint, err.message);
        // Clean up expired or unsubscribed devices
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }

    return { success: true, count: successCount };
  } catch (err) {
    console.error('sendPushToAll Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Evaluate all 4 custom rules and send corresponding alerts.
 */
export async function evaluateAndDispatchTriggers(forceDaily = false) {
  try {
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
    const daysLeft = Math.max(0, Math.round((endOfCycle - midnightNow) / (1000 * 60 * 60 * 24)));

    const { data: categories } = await supabase.from('categories').select('*');
    const { data: transactions } = await supabase.from('transactions').select('*');

    if (!categories || !transactions) return { notifications: [] };

    let totalPlanned = 0;
    let totalActual = 0;
    const catMap = {};
    categories.forEach(c => {
      catMap[c.id] = { name: c.name, planned: Number(c.planned_amount), actual: 0 };
      if (c.name !== 'Uncategorized') totalPlanned += Number(c.planned_amount);
    });

    let uncatCount = 0;
    const cycleStartDate = new Date(startOfMonth);
    let prevCycleMonth = cycleMonth - 1;
    let prevCycleYear = cycleYear;
    if (prevCycleMonth < 0) { prevCycleMonth = 11; prevCycleYear -= 1; }
    const prevCycleStartDate = new Date(prevCycleYear, prevCycleMonth, cycleStartDay);

    transactions.forEach(t => {
      const tDate = new Date(t.transaction_date);
      const isCarried = !!t.is_carried_forward;
      const isInCycle = tDate >= cycleStartDate && tDate < endOfCycle;
      const isCarriedFromPrev = isCarried && tDate >= prevCycleStartDate && tDate < cycleStartDate;

      // In scope if in cycle (and not carrying forward) OR carried into cycle from previous cycle
      const inScope = (isInCycle && !isCarried) || isCarriedFromPrev;
      if (!inScope) return;

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
    const alerts = [];

    // Rule 1: Category Budget Alerts (80% and >100%)
    Object.values(catMap).forEach(c => {
      if (c.planned > 0) {
        const ratio = (c.actual / c.planned) * 100;
        if (ratio >= 100) {
          alerts.push({
            title: `🚨 Over Budget: ${c.name}`,
            body: `Spent EGP ${c.actual.toLocaleString()} of EGP ${c.planned.toLocaleString()} (${Math.round(ratio)}%). Over by EGP ${(c.actual - c.planned).toLocaleString()}.`,
            icon: '/icon.svg',
            url: '/index.html'
          });
        } else if (ratio >= 80) {
          alerts.push({
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
      alerts.push({
        title: `📋 ${uncatCount} Transactions Need Attention`,
        body: `You have ${uncatCount} uncategorized transactions waiting for review. Tap to categorize.`,
        icon: '/icon.svg',
        url: '/index.html'
      });
    }

    // Rule 3: Low Balance Alert (< 10,000 EGP)
    if (remainingBalance < 10000) {
      alerts.push({
        title: `🚨 Low Balance Warning`,
        body: `Your remaining cycle balance is EGP ${remainingBalance.toLocaleString()} (below 10,000 EGP limit).`,
        icon: '/icon.svg',
        url: '/index.html'
      });
    }

    // Rule 4: Daily Countdown (when forceDaily is true or as fallback)
    if (forceDaily) {
      alerts.push({
        title: `⏳ Cycle Status: ${daysLeft} Days Left`,
        body: `Current cycle ends in ${daysLeft} days. Spent: EGP ${totalActual.toLocaleString()} | Balance: EGP ${remainingBalance.toLocaleString()}.`,
        icon: '/icon.svg',
        url: '/index.html'
      });
    }

    for (const alert of alerts) {
      await sendPushToAll(alert);
    }

    return { success: true, alertsSent: alerts.length, alerts };
  } catch (err) {
    console.error('evaluateAndDispatchTriggers Error:', err);
    return { success: false, error: err.message };
  }
}
