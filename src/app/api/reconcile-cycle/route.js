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

    const cycleStart = new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - (3 * 3600 * 1000));
    const cycleEnd = new Date(Date.UTC(2026, 8, 20, 0, 0, 0) - (3 * 3600 * 1000));
    const prevCycleStart = new Date(Date.UTC(2026, 6, 20, 0, 0, 0) - (3 * 3600 * 1000));

    const inCycle = [];
    const carriedIn = [];
    const carriedOut = [];
    const outOfCycle = [];

    let rawOutgoingSum = 0;
    let effectiveOutgoingSum = 0;
    let rawIncomingSum = 0;
    let effectiveIncomingSum = 0;

    (txs || []).forEach(t => {
      const d = new Date(t.transaction_date);
      const amt = Number(t.amount) || 0;
      const isIn = d >= cycleStart && d < cycleEnd;
      const isFromPrev = d >= prevCycleStart && d < cycleStart;
      const isCarried = !!t.is_carried_forward;

      const item = {
        id: t.id,
        kind: t.kind,
        amount: amt,
        source: t.source_or_merchant,
        note: t.note,
        date: t.transaction_date,
        is_carried: isCarried
      };

      if (isIn) {
        inCycle.push(item);
        if (t.kind === 'outgoing') {
          rawOutgoingSum += amt;
          if (isCarried) {
            carriedOut.push(item);
          } else {
            effectiveOutgoingSum += amt;
          }
        } else {
          rawIncomingSum += amt;
          if (!isCarried) {
            effectiveIncomingSum += amt;
          } else {
            carriedOut.push(item);
          }
        }
      } else if (isFromPrev && isCarried) {
        carriedIn.push(item);
        if (t.kind === 'outgoing') {
          effectiveOutgoingSum += amt;
        } else {
          effectiveIncomingSum += amt;
        }
      } else {
        outOfCycle.push(item);
      }
    });

    return NextResponse.json({
      success: true,
      totalTxsInDb: txs?.length || 0,
      cycleBounds: {
        start: cycleStart.toISOString(),
        end: cycleEnd.toISOString()
      },
      summary: {
        inCycleCount: inCycle.length,
        rawOutgoingSum: Number(rawOutgoingSum.toFixed(2)),
        effectiveOutgoingSum: Number(effectiveOutgoingSum.toFixed(2)),
        rawIncomingSum: Number(rawIncomingSum.toFixed(2)),
        effectiveIncomingSum: Number(effectiveIncomingSum.toFixed(2)),
        carriedInCount: carriedIn.length,
        carriedOutCount: carriedOut.length
      },
      inCycleOutgoings: inCycle.filter(t => t.kind === 'outgoing'),
      inCycleIncomings: inCycle.filter(t => t.kind !== 'outgoing'),
      carriedIn,
      carriedOut
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
