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

    // Check recent transactions for both users
    const { data: txsA } = await supabase
      .from('transactions')
      .select('id, amount, source_or_merchant, kind, transaction_date, is_carried_forward')
      .eq('user_id', '5aa42527-12fc-448a-a108-70531f3c5607')
      .order('transaction_date', { ascending: false })
      .limit(5);

    const { data: txsB } = await supabase
      .from('transactions')
      .select('id, amount, source_or_merchant, kind, transaction_date, is_carried_forward')
      .eq('user_id', '2463bf7f-f454-454f-b8bc-b8328f85069b')
      .order('transaction_date', { ascending: false })
      .limit(5);

    return NextResponse.json({
      userA_5aa: txsA,
      userB_246: txsB
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
