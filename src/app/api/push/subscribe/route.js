import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAuthenticatedUser, unauthorizedResponse } from '@/lib/auth';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '';

export async function GET() {
  return NextResponse.json({ publicKey: VAPID_PUBLIC_KEY });
}

export async function POST(req) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedResponse();
  try {
    const { subscription } = await req.json();
    if (!subscription || !subscription.endpoint) {
      return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        user_id: user.id,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        created_at: new Date().toISOString()
      }, { onConflict: 'endpoint' });

    if (error) {
      console.error('Supabase push_subscriptions table error:', error.message);
      return NextResponse.json({ error: 'Subscription save failed: ' + error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Subscribe Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedResponse();
  try {
    const { endpoint } = await req.json();
    if (endpoint) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .eq('endpoint', endpoint)
        .or(`user_id.eq.${user.id},user_id.is.null`);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
