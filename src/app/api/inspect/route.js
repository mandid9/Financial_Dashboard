import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const SECRET_KEY = 'cat_clean_2026_safe';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== SECRET_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. All categories
    const { data: categories } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true });

    const catMap = {};
    (categories || []).forEach(c => {
      catMap[c.id] = { ...c, count: 0, actual_in_cycle: 0, all_time_actual: 0 };
    });

    // 2. All transactions
    const { data: allTxs } = await supabase
      .from('transactions')
      .select('id, user_id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward, category_id')
      .order('transaction_date', { ascending: true });

    // Active cycle bounds (Aug 20 - Sep 20 Egypt UTC+3)
    const cycleStart = new Date(Date.UTC(2026, 7, 20, 0, 0, 0) - (3 * 3600 * 1000));
    const cycleEnd = new Date(Date.UTC(2026, 8, 20, 0, 0, 0) - (3 * 3600 * 1000));
    const prevCycleStart = new Date(Date.UTC(2026, 6, 20, 0, 0, 0) - (3 * 3600 * 1000));

    let inCycleSpendTotal = 0;
    let nullCatInCycle = 0;
    const nullCatTxsInCycle = [];
    const txsByUser = {};
    const uncatTxsAll = [];

    for (const tx of allTxs || []) {
      txsByUser[tx.user_id] = (txsByUser[tx.user_id] || 0) + 1;
      const d = new Date(tx.transaction_date);
      const amt = Number(tx.amount) || 0;
      const isInCycle = d >= cycleStart && d < cycleEnd;
      const isFromPrev = d >= prevCycleStart && d < cycleStart;
      const isCarried = !!tx.is_carried_forward;

      let inCycleOutgoing = false;
      if (isInCycle && tx.kind === 'outgoing' && !isCarried) inCycleOutgoing = true;
      if (isFromPrev && tx.kind === 'outgoing' && isCarried) inCycleOutgoing = true;

      if (tx.category_id && catMap[tx.category_id]) {
        catMap[tx.category_id].count += 1;
        catMap[tx.category_id].all_time_actual += amt;
        if (inCycleOutgoing) {
          catMap[tx.category_id].actual_in_cycle += amt;
        }
      } else {
        uncatTxsAll.push(tx);
        if (inCycleOutgoing) {
          nullCatInCycle += amt;
          nullCatTxsInCycle.push(tx);
        }
      }

      if (inCycleOutgoing) {
        inCycleSpendTotal += amt;
      }
    }

    return NextResponse.json({
      success: true,
      totalTxs: allTxs?.length || 0,
      totalCategories: categories?.length || 0,
      txsByUser,
      inCycleSpendTotal,
      nullCatInCycle,
      nullCatTxsInCycle,
      uncatTxsAllCount: uncatTxsAll.length,
      uncatTxsAll: uncatTxsAll.slice(0, 30),
      categoryBreakdown: Object.values(catMap).map(c => ({
        id: c.id,
        name: c.name,
        planned: c.planned_amount,
        sort: c.sort_order,
        count: c.count,
        actual_in_cycle: Number(c.actual_in_cycle.toFixed(2)),
        all_time_actual: Number(c.all_time_actual.toFixed(2))
      }))
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
