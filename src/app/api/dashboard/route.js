export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const cycleOffset = parseInt(searchParams.get('cycleOffset') || '0', 10);
    const now = new Date();
    const cycleStartDay = 20;

    // 1. Calculate Base Cycle (Offset = 0)
    let baseMonth = now.getMonth();
    let baseYear = now.getFullYear();
    if (now.getDate() < cycleStartDay) {
      baseMonth -= 1;
      if (baseMonth < 0) {
        baseMonth = 11;
        baseYear -= 1;
      }
    }

    // Helper to calculate cycle start/end dates and formatted label
    function getCycleBounds(offset) {
      let m = baseMonth + offset;
      let y = baseYear;
      while (m < 0) { m += 12; y -= 1; }
      while (m > 11) { m -= 12; y += 1; }

      let nextM = m + 1;
      let nextY = y;
      if (nextM > 11) { nextM = 0; nextY += 1; }

      const start = new Date(y, m, cycleStartDay, 0, 0, 0);
      const end = new Date(nextY, nextM, cycleStartDay, 0, 0, 0);

      const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      const shortYear = String(nextY).slice(-2);
      const label = `${monthNames[m]} / ${monthNames[nextM]} '${shortYear}`;

      return { start, end, label, startMonth: m, startYear: y, endMonth: nextM, endYear: nextY };
    }

    const currentBounds = getCycleBounds(0);
    const targetBounds = getCycleBounds(cycleOffset);
    const nextBounds = getCycleBounds(1);

    const isCurrent = cycleOffset === 0;
    const isNext = cycleOffset > 0;
    const isPast = cycleOffset < 0;

    // 2. Fetch Categories
    const { data: categories, error: catError } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true });
    if (catError) throw catError;

    // 3. Fetch All Transactions
    const { data: allTransactions, error: txError } = await supabase
      .from('transactions')
      .select('*, categories(name)')
      .order('transaction_date', { ascending: false });
    if (txError) throw txError;

    // 4. Calculate Current Active Cycle Debt & Credit Card Rollover
    // We compute this from the real current active cycle (offset = 0)
    let currentDebtPlanned = 0;
    let currentDebtPaid = 0;
    let currentNewCreditCardSpend = 0;

    const debtCatObj = categories.find(c => c.name.toLowerCase() === 'debt' || c.name.toLowerCase() === 'credit card');
    if (debtCatObj) {
      currentDebtPlanned = Number(debtCatObj.planned_amount) || 0;
    }

    allTransactions.forEach(t => {
      const tDate = new Date(t.transaction_date);
      const inCurrentCycle = tDate >= currentBounds.start && tDate < currentBounds.end;

      if (inCurrentCycle && t.kind === 'outgoing') {
        // If assigned to Debt category -> repayment toward current debt
        if (debtCatObj && t.category_id === debtCatObj.id) {
          currentDebtPaid += Number(t.amount);
        }
        // If spent via Credit Card (and not already categorized as debt payment)
        const isCC = /credit\s*card/i.test(t.source_or_merchant || '') || /credit\s*card/i.test(t.note || '');
        if (isCC && (!debtCatObj || t.category_id !== debtCatObj.id)) {
          currentNewCreditCardSpend += Number(t.amount);
        }
      }
    });

    const unpaidDebtRemainder = Math.max(0, currentDebtPlanned - currentDebtPaid);
    const nextCycleDebtTarget = unpaidDebtRemainder + currentNewCreditCardSpend;

    const debtSummary = {
      plannedDebt: currentDebtPlanned,
      paidDebt: currentDebtPaid,
      unpaidRemainder: unpaidDebtRemainder,
      isFullyPaid: currentDebtPaid >= currentDebtPlanned && currentDebtPlanned > 0,
      newCreditCardSpend: currentNewCreditCardSpend,
      nextCycleDebtTarget: nextCycleDebtTarget
    };

    // 5. Build Category Map for the Target Cycle
    const catMap = {};
    let totalPlanned = 0;

    categories.forEach(c => {
      let plannedAmount = Number(c.planned_amount) || 0;
      // If previewing NEXT cycle (offset = 1), dynamically plug in the calculated debt target!
      if (isNext && debtCatObj && c.id === debtCatObj.id) {
        plannedAmount = nextCycleDebtTarget;
      }

      catMap[c.id] = {
        row: c.id,
        name: c.name,
        planned: plannedAmount,
        actual: 0,
        remaining: plannedAmount,
        sort_order: c.sort_order ?? 0
      };

      if (c.name !== 'Uncategorized') {
        totalPlanned += plannedAmount;
      }
    });

    // 6. Process Transactions for the Target Cycle
    const outgoing = [];
    const incoming = [];
    let totalActual = 0;
    let totalIncome = 0;
    let uncatActual = 0;
    let todayTotal = 0;
    let todayIncome = 0;
    const todayStr = now.toISOString().split('T')[0];

    allTransactions.forEach(t => {
      const tDate = new Date(t.transaction_date);
      const isToday = t.transaction_date.startsWith(todayStr);

      let inScope = false;
      if (isNext) {
        // For Next Cycle preview, include carried transactions or future dated transactions
        inScope = (tDate >= targetBounds.start && tDate < targetBounds.end) || !!t.is_carried_forward;
      } else {
        inScope = tDate >= targetBounds.start && tDate < targetBounds.end;
      }

      if (inScope) {
        if (t.kind === 'outgoing') {
          const catName = (t.category_id && catMap[t.category_id])
            ? catMap[t.category_id].name
            : (t.categories ? (Array.isArray(t.categories) ? t.categories[0]?.name : t.categories.name) : null);

          if (t.category_id && catMap[t.category_id]) {
            catMap[t.category_id].actual += Number(t.amount);
            catMap[t.category_id].remaining -= Number(t.amount);
          } else {
            uncatActual += Number(t.amount);
          }

          totalActual += Number(t.amount);
          if (isCurrent && isToday) todayTotal += Number(t.amount);

          outgoing.push({
            row: t.id,
            kind: 'outgoing',
            source: t.source_or_merchant,
            date: new Date(t.transaction_date).toLocaleString(),
            amount: Number(t.amount),
            note: t.note,
            category: catName,
            is_carried_forward: !!t.is_carried_forward
          });
        } else {
          totalIncome += Number(t.amount);
          if (isCurrent && isToday) todayIncome += Number(t.amount);

          incoming.push({
            row: t.id,
            kind: 'incoming',
            source: t.source_or_merchant,
            date: new Date(t.transaction_date).toLocaleString(),
            amount: Number(t.amount),
            note: t.note,
            is_carried_forward: !!t.is_carried_forward
          });
        }
      }
    });

    // 7. Calculate Redefined Metrics
    // Net Balance: Total Income - Total Actual Spending (Live Cash in Hand)
    const netBalance = totalIncome - totalActual;
    // Available: Planned Budget - Actual Spending (Unspent Budget Allowance)
    const available = totalPlanned - totalActual;
    // Probable Savings: Total Income - Planned Budget (Projected Savings if plan kept)
    const probableSavings = totalIncome - totalPlanned;

    // Commitments: Sum of only positive remaining values
    const returnCategories = categories.map(c => catMap[c.id]).filter(Boolean);
    if (uncatActual > 0) {
      const existingUncat = returnCategories.find(c => c.name === 'Uncategorized');
      if (existingUncat) {
        existingUncat.actual += uncatActual;
        existingUncat.remaining -= uncatActual;
      } else {
        returnCategories.push({
          row: 'uncategorized',
          name: 'Uncategorized',
          planned: 0,
          actual: uncatActual,
          remaining: -uncatActual,
          sort_order: 9999
        });
      }
    }

    const commitments = returnCategories.reduce((sum, c) => sum + Math.max(0, c.remaining), 0);

    // Days Left calculation for the target cycle
    const midnightNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let daysLeft = 0;
    if (isCurrent) {
      daysLeft = Math.max(0, Math.round((targetBounds.end - midnightNow) / (1000 * 60 * 60 * 24)));
    } else if (isPast) {
      daysLeft = 0;
    } else {
      daysLeft = Math.round((targetBounds.end - targetBounds.start) / (1000 * 60 * 60 * 24));
    }

    // Historical cycle archives summary for Insights
    const historicalCycles = [];
    for (let i = 1; i <= 4; i++) {
      const hBounds = getCycleBounds(-i);
      let hOut = 0;
      let hInc = 0;
      const hCats = {};

      allTransactions.forEach(t => {
        const tDate = new Date(t.transaction_date);
        if (tDate >= hBounds.start && tDate < hBounds.end) {
          if (t.kind === 'outgoing') {
            hOut += Number(t.amount);
            const cname = (t.category_id && catMap[t.category_id])
              ? catMap[t.category_id].name
              : 'Uncategorized';
            hCats[cname] = (hCats[cname] || 0) + Number(t.amount);
          } else {
            hInc += Number(t.amount);
          }
        }
      });

      historicalCycles.unshift({
        label: hBounds.label,
        start: hBounds.start.toISOString(),
        end: hBounds.end.toISOString(),
        income: hInc,
        outgoing: hOut,
        categories: hCats
      });
    }

    return NextResponse.json({
      cycle: {
        label: targetBounds.label,
        offset: cycleOffset,
        isCurrent,
        isNext,
        isPast,
        startDate: targetBounds.start.toISOString(),
        endDate: targetBounds.end.toISOString(),
        daysLeft
      },
      dashboard: {
        outgoing,
        incoming,
        categories: categories.map(c => c.name),
        todayTotal,
        todayIncome,
        historyCycles: historicalCycles,
        debtSummary
      },
      budget: {
        metrics: {
          netBalance,        // Total Income - Actual
          available,         // Planned - Actual
          planned: totalPlanned,
          actual: totalActual,
          income: totalIncome,
          commitments,       // Sum of positive remaining
          probableSavings,   // Total Income - Planned
          days: daysLeft
        },
        categories: returnCategories
      }
    });

  } catch (err) {
    console.error('Dashboard Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
