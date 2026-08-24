import webpush from 'web-push';
import { supabase } from '@/lib/supabase';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:kr.wn20@gmail.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    console.warn('VAPID setup warning:', e.message);
  }
}

/**
 * Send a notification payload to registered subscriptions in Supabase.
 * Optionally filter by userId for strict multi-user privacy.
 */
export async function sendPushToAll(payload, targetUserId = null) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.log('Push notifications skipped: VAPID keys not configured in environment.');
    return { success: true, count: 0 };
  }

  try {
    let query = supabase.from('push_subscriptions').select('*');
    if (targetUserId) {
      query = query.or(`user_id.eq.${targetUserId},user_id.is.null`);
    }

    const { data: dbSubs, error } = await query;
    if (error || !dbSubs || dbSubs.length === 0) {
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
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }

    return { success: true, count: successCount };
  } catch (err) {
    console.error('sendPush Error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Evaluate all 4 custom rules and send corresponding alerts for a user.
 */
export async function evaluateAndDispatchTriggers(forceDaily = false, targetUserId = null) {
  try {
    const now = new Date();
    const cycleStartDay = 20;
    let cycleMonth = now.getMonth();
    let cycleYear = now.getFullYear();
    if (now.getDate() < cycleStartDay) {
      cycleMonth -= 1;
      if (cycleMonth < 0) { cycleMonth = 11; cycleYear -= 1; }
    }

    let nextM = cycleMonth + 1;
    let nextY = cycleYear;
    if (nextM > 11) { nextM = 0; nextY += 1; }

    const currentCycleStart = new Date(cycleYear, cycleMonth, cycleStartDay, 0, 0, 0);
    const currentCycleEnd = new Date(nextY, nextM, cycleStartDay, 0, 0, 0);

    let prevM = cycleMonth - 1;
    let prevY = cycleYear;
    if (prevM < 0) { prevM = 11; prevY -= 1; }
    const prevCycleStart = new Date(prevY, prevM, cycleStartDay, 0, 0, 0);

    let catQuery = supabase.from('categories').select('*');
    let txQuery = supabase.from('transactions').select('*');
    if (targetUserId) {
      catQuery = catQuery.or(`user_id.eq.${targetUserId},user_id.is.null`);
      txQuery = txQuery.or(`user_id.eq.${targetUserId},user_id.is.null`);
    }

    const { data: categories } = await catQuery;
    const { data: allTransactions } = await txQuery;

    if (!categories || !allTransactions) return;

    let totalSpent = 0;
    let totalPlanned = 0;
    const catSpentMap = {};

    categories.forEach(c => {
      totalPlanned += Number(c.planned_amount) || 0;
      catSpentMap[c.id] = { name: c.name, planned: Number(c.planned_amount) || 0, spent: 0 };
    });

    let uncategorizedCount = 0;
    let uncategorizedTotal = 0;

    allTransactions.forEach(t => {
      const tDate = new Date(t.transaction_date);
      const isFromCurrent = tDate >= currentCycleStart && tDate < currentCycleEnd && !t.is_carried_forward;
      const isCarriedIntoCurrent = tDate >= prevCycleStart && tDate < currentCycleStart && t.is_carried_forward;

      if (isFromCurrent || isCarriedIntoCurrent) {
        if (t.kind === 'outgoing') {
          const amt = Number(t.amount) || 0;
          totalSpent += amt;

          if (t.category_id && catSpentMap[t.category_id]) {
            catSpentMap[t.category_id].spent += amt;
          } else {
            uncategorizedCount++;
            uncategorizedTotal += amt;
          }
        }
      }
    });

    // Rule 1: Category Budget 90%
    for (const catId in catSpentMap) {
      const cat = catSpentMap[catId];
      if (cat.planned > 0 && cat.spent >= 0.9 * cat.planned) {
        const pct = Math.round((cat.spent / cat.planned) * 100);
        await sendPushToAll({
          title: `⚠️ Budget Alert: ${cat.name}`,
          body: `You've used ${pct}% of your ${cat.name} budget (EGP ${cat.spent.toLocaleString()} / ${cat.planned.toLocaleString()}).`,
          icon: '/icon.svg',
          url: '/index.html'
        }, targetUserId);
      }
    }

    // Rule 2: Uncategorized Prompt
    if (uncategorizedCount > 0) {
      await sendPushToAll({
        title: `🏷️ Review ${uncategorizedCount} Uncategorized Expense${uncategorizedCount > 1 ? 's' : ''}`,
        body: `EGP ${uncategorizedTotal.toLocaleString()} needs a category. Tap to organize.`,
        icon: '/icon.svg',
        url: '/index.html'
      }, targetUserId);
    }

    // Rule 3: 5 Days Left Check
    const diffDays = Math.ceil((currentCycleEnd - now) / (1000 * 60 * 60 * 24));
    if (diffDays === 5 && forceDaily) {
      const remaining = Math.max(0, totalPlanned - totalSpent);
      await sendPushToAll({
        title: `⏳ 5 Days Left in Cycle`,
        body: `EGP ${remaining.toLocaleString()} remaining in your budget until reset.`,
        icon: '/icon.svg',
        url: '/index.html'
      }, targetUserId);
    }

    // Rule 4: Cycle Summary (1 day before cycle ends)
    if (diffDays === 1 && forceDaily) {
      const surplus = totalPlanned - totalSpent;
      const statusText = surplus >= 0
        ? `Surplus of EGP ${surplus.toLocaleString()} 🎉`
        : `Deficit of EGP ${Math.abs(surplus).toLocaleString()} ⚠️`;

      await sendPushToAll({
        title: `📊 Cycle Summary`,
        body: `Cycle resets tomorrow. Spent: EGP ${totalSpent.toLocaleString()} (${statusText}).`,
        icon: '/icon.svg',
        url: '/index.html'
      }, targetUserId);
    }

  } catch (err) {
    console.error('Trigger Evaluation Error:', err);
  }
}
