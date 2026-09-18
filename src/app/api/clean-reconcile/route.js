import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== 'reconcile_fix_2026') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const primaryUserId = '5aa42527-12fc-448a-a108-70531f3c5607';

    // 1. Delete the 14,000 EGP phantom deposit and the 7 misclassified card notifications
    const idsToDelete = [
      'b3c7c5e5-9399-4ab0-bca0-943700e0a243', // 14,000 EGP phantom "Bank Card" on Sep 17
      '3aa46990-4368-4e19-bbe6-ebf3b5b5eca4', // 115 EGP
      '808f6a75-8a65-4944-88e4-f5c6bb87df10', // 165 EGP
      '5215eab6-497e-46db-a871-465a1212980c', // 40 EGP
      '1cdf4937-126d-428e-80ae-6b31c42061c0', // 740 EGP
      '7d1c8047-399e-492a-ad77-e308c3a62fbc', // 500 EGP
      '0ac0a0a8-f92a-454d-bc42-8b7c764ec761', // 750 EGP
      '24648141-44d7-43f8-be10-6cfca8e37700'  // 600 EGP
    ];

    const { error: delErr } = await supabase
      .from('transactions')
      .delete()
      .in('id', idsToDelete);

    if (delErr) {
      console.warn('Delete error:', delErr.message);
    }

    // 2. Unflag the two Aug 19 outgoings that the user did NOT forward
    const outgoingIdsToUnflag = [
      'ebf43a44-22e5-4509-8bf8-bcf287ae7075', // 302.10 EGP WE-FBB-Pre
      '19b4594c-7c2e-4d17-87e0-705a2ba0af32'  // 200.00 EGP Instapay Sent
    ];

    const { error: unflagErr } = await supabase
      .from('transactions')
      .update({ is_carried_forward: false })
      .in('id', outgoingIdsToUnflag);

    if (unflagErr) {
      console.warn('Unflag error:', unflagErr.message);
    }

    // 3. Query the resulting cycle state for validation
    const cycleStart = new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - (3 * 3600 * 1000));
    const cycleEnd = new Date(Date.UTC(2026, 8, 20, 0, 0, 0) - (3 * 3600 * 1000));
    const prevCycleStart = new Date(Date.UTC(2026, 6, 20, 0, 0, 0) - (3 * 3600 * 1000));

    const { data: allTxs, error: qErr } = await supabase
      .from('transactions')
      .select('id, user_id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward')
      .order('transaction_date', { ascending: true });

    if (qErr) {
      return NextResponse.json({ error: qErr.message }, { status: 500 });
    }

    const inCycleOut = [];
    const inCycleInc = [];
    const carriedInInc = [];
    const carriedInExp = [];
    const deferredInc = [];
    const deferredExp = [];

    (allTxs || []).forEach(t => {
      const d = new Date(t.transaction_date);
      const amt = Number(t.amount) || 0;
      const isIn = d >= cycleStart && d < cycleEnd;
      const isFromPrev = d >= prevCycleStart && d < cycleStart;
      const isCarried = !!t.is_carried_forward;

      if (isIn) {
        if (t.kind === 'outgoing') {
          if (isCarried) deferredExp.push(t);
          else inCycleOut.push(t);
        } else {
          if (isCarried) deferredInc.push(t);
          else inCycleInc.push(t);
        }
      } else if (isFromPrev && isCarried) {
        if (t.kind === 'outgoing') carriedInExp.push(t);
        else carriedInInc.push(t);
      }
    });

    const sum = list => Number(list.reduce((acc, x) => acc + (Number(x.amount) || 0), 0).toFixed(2));

    const inCycleSpend = sum(inCycleOut);
    const inCycleDirectIncome = Number((sum(inCycleInc) + sum(deferredInc)).toFixed(2));
    const deferredIncomeTotal = sum(deferredInc);
    const carriedInIncomeTotal = sum(carriedInInc);
    const carriedInExpenseTotal = sum(carriedInExp);

    const effectiveIncome = Number((inCycleDirectIncome - deferredIncomeTotal + carriedInIncomeTotal).toFixed(2));
    const effectiveSpend = Number((inCycleSpend + carriedInExpenseTotal).toFixed(2));
    const netBalance = Number((effectiveIncome - effectiveSpend).toFixed(2));

    return NextResponse.json({
      success: true,
      results: {
        inCycleDirectIncome,
        deferredIncomeTotal,
        deferredIncItems: deferredInc.map(t => ({ source: t.source_or_merchant, amount: t.amount, date: t.transaction_date })),
        carriedInIncomeTotal,
        carriedInIncItems: carriedInInc.map(t => ({ source: t.source_or_merchant, amount: t.amount, date: t.transaction_date })),
        effectiveIncome,
        inCycleDirectSpending: inCycleSpend,
        carriedInExpenseTotal,
        carriedInExpItems: carriedInExp.map(t => ({ source: t.source_or_merchant, amount: t.amount, date: t.transaction_date })),
        effectiveSpend,
        netBalance,
        inCycleIncCount: inCycleInc.length,
        inCycleIncList: inCycleInc.map(t => ({ source: t.source_or_merchant, amount: t.amount, date: t.transaction_date }))
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
