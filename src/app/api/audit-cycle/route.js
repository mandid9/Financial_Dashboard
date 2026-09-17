import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== 'cycle_audit_key_98234') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: user, error: uErr } = await supabase
      .from('users')
      .select('id, email')
      .eq('email', 'kr.wn20@gmail.com')
      .maybeSingle();

    if (uErr || !user) {
      return NextResponse.json({ error: 'User not found', detail: uErr?.message });
    }

    const { data: txs, error: txErr } = await supabase
      .from('transactions')
      .select('id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward, category_id')
      .or(`user_id.eq.${user.id},user_id.is.null`)
      .order('transaction_date', { ascending: true });

    if (txErr) {
      return NextResponse.json({ error: 'Query failed', detail: txErr.message });
    }

    const startCycle = new Date('2026-08-20T00:00:00.000Z');
    const endCycle = new Date('2026-09-20T00:00:00.000Z');
    const prevStartCycle = new Date('2026-07-20T00:00:00.000Z');

    const inCycleOutgoings = [];
    const inCycleIncomings = [];
    const carriedInOutgoings = [];
    const carriedOutOutgoings = [];
    const priorCycleOutgoings = [];
    const otherTxs = [];

    let rawInCycleOutgoingSum = 0;
    let effectiveOutgoingSum = 0;

    (txs || []).forEach(t => {
      const tDate = new Date(t.transaction_date);
      const amt = Number(t.amount) || 0;
      const isInCycle = tDate >= startCycle && tDate < endCycle;
      const isFromPrevCycle = tDate >= prevStartCycle && tDate < startCycle;

      const item = {
        id: t.id,
        kind: t.kind,
        amount: amt,
        source: t.source_or_merchant,
        note: t.note,
        date: t.transaction_date,
        is_carried: !!t.is_carried_forward
      };

      if (isInCycle) {
        if (t.kind === 'outgoing') {
          inCycleOutgoings.push(item);
          rawInCycleOutgoingSum += amt;
          if (t.is_carried_forward) {
            carriedOutOutgoings.push(item);
          } else {
            effectiveOutgoingSum += amt;
          }
        } else {
          inCycleIncomings.push(item);
        }
      } else if (isFromPrevCycle) {
        if (t.kind === 'outgoing') {
          priorCycleOutgoings.push(item);
          if (t.is_carried_forward) {
            carriedInOutgoings.push(item);
            effectiveOutgoingSum += amt;
          }
        }
      } else {
        otherTxs.push(item);
      }
    });

    return NextResponse.json({
      success: true,
      user: user.email,
      totalCount: txs?.length || 0,
      cycle: {
        start: startCycle.toISOString(),
        end: endCycle.toISOString()
      },
      summary: {
        rawInCycleOutgoingCount: inCycleOutgoings.length,
        rawInCycleOutgoingSum,
        carriedOutOutgoingCount: carriedOutOutgoings.length,
        carriedInOutgoingCount: carriedInOutgoings.length,
        effectiveOutgoingSum,
        inCycleIncomingCount: inCycleIncomings.length
      },
      inCycleOutgoings,
      carriedInOutgoings,
      carriedOutOutgoings,
      inCycleIncomings,
      priorCycleOutgoings
    });
  } catch (err) {
    return NextResponse.json({ error: err.message });
  }
}
