import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { sendPushToAll, evaluateAndDispatchTriggers } from '@/lib/push';
import { getAuthenticatedUser, unauthorizedResponse } from '@/lib/auth';

function authorizeCron(req) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'Push trigger is not configured' }, { status: 503 });
  }

  const authHeader = req.headers.get('authorization') || '';
  if (authHeader !== 'Bearer ' + cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

async function evaluateForAllUsers(forceDaily) {
  const { data: tokens, error } = await supabase.from('user_webhook_tokens').select('user_id');
  const userIds = error ? [] : [...new Set((tokens || []).map(t => t.user_id).filter(Boolean))];

  if (userIds.length === 0) {
    return await evaluateAndDispatchTriggers(forceDaily);
  }

  const results = [];
  for (const userId of userIds) {
    results.push(await evaluateAndDispatchTriggers(forceDaily, userId));
  }
  return { evaluatedUsers: userIds.length, results };
}

// Handles Vercel Cron and automated GET requests
export async function GET(req) {
  try {
    const unauthorized = authorizeCron(req);
    if (unauthorized) return unauthorized;

    const { searchParams } = new URL(req.url);
    const forceDaily = searchParams.get('daily') === 'true' || searchParams.get('cron') === 'true';
    const result = await evaluateForAllUsers(forceDaily);
    return NextResponse.json({ success: true, message: 'Automated push check completed', result });
  } catch (err) {
    console.error('GET /api/push/send Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Handles manual / test / custom POST requests
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { type, customPayload } = body;

    // Test pushes come from the logged-in dashboard UI (no cron secret there)
    if (type === 'test') {
      const user = await getAuthenticatedUser(req);
      if (!user) return unauthorizedResponse();
      const testAlert = {
        title: '🔔 Push Notifications Active!',
        body: 'Your Expenses dashboard is connected to native push alerts.',
        icon: '/icon.svg',
        url: '/index.html'
      };
      const res = await sendPushToAll(testAlert, user.id);
      return NextResponse.json({
        success: true,
        sentCount: res.count,
        total: res.total !== undefined ? res.total : null,
        errors: res.errors || [],
        debugRows: res.debugRows || null,
        vapidMissing: !!res.vapidMissing,
        notification: testAlert
      });
    }

    const unauthorized = authorizeCron(req);
    if (unauthorized) return unauthorized;

    if (type === 'custom' && customPayload) {
      const res = await sendPushToAll(customPayload);
      return NextResponse.json({ success: true, sentCount: res.count, notification: customPayload });
    }

    // Default: evaluate all rules per user
    const result = await evaluateForAllUsers(type === 'daily_status');
    return NextResponse.json({ success: true, result });
  } catch (err) {
    console.error('POST /api/push/send Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
