import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== 'reconcile_secret_99812') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // List all users from auth if service role, or check distinct user_ids
    const { data: userTokens } = await supabase.from('user_webhook_tokens').select('*');
    const { data: categories } = await supabase.from('categories').select('user_id, name');

    const { data: allTxs } = await supabase
      .from('transactions')
      .select('id, user_id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward')
      .order('transaction_date', { ascending: true });

    return NextResponse.json({
      userTokens,
      categories: Array.from(new Set((categories || []).map(c => c.user_id))),
      txUserIds: Array.from(new Set((allTxs || []).map(t => t.user_id))),
      allTxs
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
