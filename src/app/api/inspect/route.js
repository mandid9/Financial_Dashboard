import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const SECRET_KEY = 'diag_2026_inspect';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== SECRET_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: tokens } = await supabase
      .from('user_webhook_tokens')
      .select('*');

    // Also get distinct user_ids from transactions
    const { data: txUsers } = await supabase
      .from('transactions')
      .select('user_id')
      .order('transaction_date', { ascending: false })
      .limit(100);

    const userCounts = {};
    (txUsers || []).forEach(t => {
      userCounts[t.user_id] = (userCounts[t.user_id] || 0) + 1;
    });

    return NextResponse.json({
      tokens,
      userCounts
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
