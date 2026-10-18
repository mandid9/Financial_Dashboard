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

    const { data: recentTxs, error: txErr } = await supabase
      .from('transactions')
      .select('id, user_id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward, category_id')
      .order('transaction_date', { ascending: false })
      .limit(20);

    return NextResponse.json({
      recentTxs,
      txErr: txErr ? txErr.message : null
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
