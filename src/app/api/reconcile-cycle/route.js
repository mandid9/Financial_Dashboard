import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== 'reconcile_secret_99812') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const primaryUserId = '5aa42527-12fc-448a-a108-70531f3c5607';
    const otherOwnerIds = ['2463bf7f-f454-454f-b8bc-b8328f85069b', '7d88ef85-b3e7-4eb5-a00d-1c61a6bb0d28'];

    // 1. Delete confirmed anomalies and duplicate notifications
    const idsToDelete = [
      '30bcf8f6-37ed-43ae-aaab-c1b94dca0eef', // 250,000 EGP anomaly
      '6099954b-6fca-4a94-b2d7-533bd899f029', // 415 EGP duplicate OTP
      '1a21f48d-5183-4c0c-9177-2891847a4557', // 97.02 EGP duplicate receipt
      '1a88858a-c2ed-4e85-966e-c041c68641ba'  // 200.50 EGP duplicate notification
    ];

    const { error: delErr } = await supabase
      .from('transactions')
      .delete()
      .in('id', idsToDelete);

    if (delErr) {
      console.warn('Delete error:', delErr.message);
    }

    // 2. Unify all transactions to primary user ID
    const { error: updateErr } = await supabase
      .from('transactions')
      .update({ user_id: primaryUserId })
      .in('user_id', otherOwnerIds);

    if (updateErr) {
      console.warn('Update error:', updateErr.message);
    }

    const { error: nullUpdateErr } = await supabase
      .from('transactions')
      .update({ user_id: primaryUserId })
      .is('user_id', null);

    // 3. Query the unified cycle
    const cycleStart = new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - (3 * 3600 * 1000));
    const cycleEnd = new Date(Date.UTC(2026, 8, 20, 0, 0, 0) - (3 * 3600 * 1000));

    const { data: cleanTxs, error: qErr } = await supabase
      .from('transactions')
      .select('id, user_id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward')
      .eq('user_id', primaryUserId)
      .order('transaction_date', { ascending: true });

    if (qErr) {
      return NextResponse.json({ error: qErr.message }, { status: 500 });
    }

    let outgoingSum = 0;
    let incomingSum = 0;
    const inCycleOut = [];
    const inCycleInc = [];

    (cleanTxs || []).forEach(t => {
      const d = new Date(t.transaction_date);
      const amt = Number(t.amount) || 0;
      if (d >= cycleStart && d < cycleEnd) {
        if (t.kind === 'outgoing') {
          if (!t.is_carried_forward) outgoingSum += amt;
          inCycleOut.push(t);
        } else {
          if (!t.is_carried_forward) incomingSum += amt;
          inCycleInc.push(t);
        }
      }
    });

    return NextResponse.json({
      success: true,
      message: 'Unification and clean-up completed successfully.',
      totalTransactions: cleanTxs?.length || 0,
      currentCycle: {
        outgoingCount: inCycleOut.length,
        outgoingSpend: Number(outgoingSum.toFixed(2)),
        incomingCount: inCycleInc.length,
        incomingSum: Number(incomingSum.toFixed(2))
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
