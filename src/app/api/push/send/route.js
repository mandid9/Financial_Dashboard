import { NextResponse } from 'next/server';
import { sendPushToAll, evaluateAndDispatchTriggers } from '@/lib/push';

// Handles Vercel Cron and automated GET requests
export async function GET(req) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = req.headers.get('authorization');
      const querySecret = new URL(req.url).searchParams.get('secret');
      if (authHeader !== `Bearer ${cronSecret}` && querySecret !== cronSecret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const { searchParams } = new URL(req.url);
    const forceDaily = searchParams.get('daily') === 'true' || searchParams.get('cron') === 'true';
    const result = await evaluateAndDispatchTriggers(forceDaily || true);
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

    if (type === 'test') {
      const testAlert = {
        title: '🔔 Push Notifications Active!',
        body: 'Your Expenses dashboard is connected to native push alerts.',
        icon: '/icon.svg',
        url: '/index.html'
      };
      const res = await sendPushToAll(testAlert);
      return NextResponse.json({ success: true, sentCount: res.count, notification: testAlert });
    }

    if (type === 'custom' && customPayload) {
      const res = await sendPushToAll(customPayload);
      return NextResponse.json({ success: true, sentCount: res.count, notification: customPayload });
    }

    // Default: evaluate all 4 rules
    const result = await evaluateAndDispatchTriggers(type === 'daily_status');
    return NextResponse.json({ success: true, result });
  } catch (err) {
    console.error('POST /api/push/send Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
