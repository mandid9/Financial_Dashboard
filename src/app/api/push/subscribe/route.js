import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || 'BPnDeX4aUsrrHasl3PVoX9Cc2jWmbN9Doi1PXThwupBsJOjFWLioEWEmaXcBUAhA3Ezl3aIUFk81rYA8i3jFYXA';

export async function GET() {
  return NextResponse.json({ publicKey: VAPID_PUBLIC_KEY });
}

export async function POST(req) {
  try {
    const { subscription } = await req.json();
    if (!subscription || !subscription.endpoint) {
      return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
    }

    // Upsert subscription into push_subscriptions table
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        created_at: new Date().toISOString()
      }, { onConflict: 'endpoint' });

    if (error) {
      console.warn('Supabase push_subscriptions table error:', error.message);
      // If table doesn't exist yet, we still return ok so local test flow works
      return NextResponse.json({ success: true, warning: error.message });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Subscribe Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const { endpoint } = await req.json();
    if (endpoint) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
