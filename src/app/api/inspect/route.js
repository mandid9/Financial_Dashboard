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

    const userId = '5aa42527-12fc-448a-a108-70531f3c5607';

    // Fetch transactions
    const { data: allTransactions } = await supabase
      .from('transactions')
      .select('id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward, category_id')
      .eq('user_id', userId)
      .order('transaction_date', { ascending: false });

    const now = new Date();
    const cycleStartDay = 20;
    let baseMonth = now.getMonth();
    let baseYear = now.getFullYear();
    if (now.getDate() < cycleStartDay) {
      baseMonth -= 1;
      if (baseMonth < 0) { baseMonth = 11; baseYear -= 1; }
    }

    function getBounds(offset) {
      let m = baseMonth + offset;
      let y = baseYear;
      while (m < 0) { m += 12; y -= 1; }
      while (m > 11) { m -= 12; y += 1; }
      let nextM = m + 1;
      let nextY = y;
      if (nextM > 11) { nextM = 0; nextY += 1; }
      const start = new Date(Date.UTC(y, m, cycleStartDay, 0, 0, 0) - (3 * 3600 * 1000));
      const end = new Date(Date.UTC(nextY, nextM, cycleStartDay, 0, 0, 0) - (3 * 3600 * 1000));
      return { start, end };
    }

    function calcCycle(offset) {
      const targetBounds = getBounds(offset);
      const prevTargetBounds = getBounds(offset - 1);
      let totalIncome = 0;
      let totalActual = 0;
      const carriedIn = [];
      const carriedOut = [];
      const inList = [];

      allTransactions.forEach(t => {
        const tDate = new Date(t.transaction_date);
        const isCarried = !!t.is_carried_forward;
        const isInTarget = tDate >= targetBounds.start && tDate < targetBounds.end;
        const isFromPrev = tDate >= prevTargetBounds.start && tDate < prevTargetBounds.end;

        if (isInTarget) {
          if (isCarried) {
            carriedOut.push(t);
          } else {
            if (t.kind === 'incoming') totalIncome += Number(t.amount);
            else totalActual += Number(t.amount);
            inList.push(t);
          }
        } else if (isFromPrev && isCarried) {
          carriedIn.push(t);
          if (t.kind === 'incoming') totalIncome += Number(t.amount);
          else totalActual += Number(t.amount);
          inList.push(t);
        }
      });

      return {
        offset,
        totalIncome,
        totalActual,
        carriedInCount: carriedIn.length,
        carriedIn,
        carriedOutCount: carriedOut.length,
        carriedOut,
        activeListCount: inList.length
      };
    }

    return NextResponse.json({
      currentCycle: calcCycle(0),
      nextCycle: calcCycle(1)
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
