export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAuthenticatedUser, unauthorizedResponse } from '@/lib/auth';

export async function GET(req) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedResponse();
  try {
    const { searchParams } = new URL(req.url);
    const cycleOffset = parseInt(searchParams.get('cycleOffset') || '0', 10);
    const requestedHistoryPage = parseInt(searchParams.get('historyPage') || '1', 10);
    const historyPage = Number.isFinite(requestedHistoryPage) ? Math.max(1, requestedHistoryPage) : 1;
    const requestedHistoryPageSize = parseInt(searchParams.get('historyPageSize') || '50', 10);
    const historyPageSize = Number.isFinite(requestedHistoryPageSize) ? Math.min(100, Math.max(1, requestedHistoryPageSize)) : 50;
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
      .select('id, name, planned_amount, sort_order')
      .order('sort_order', { ascending: true });
    if (catError) throw catError;

    // 3. Fetch Transactions
    const { data: allTransactions, error: txError } = await supabase
      .from('transactions')
      .select('id, kind, amount, source_or_merchant, note, transaction_date, is_carried_forward, category_id, categories(name)')
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
      const inCurrentCycle = tDate >= currentBounds.start && tDate < currentBounds.end && !t.is_carried_forward;

      if (inCurrentCycle && t.kind === 'outgoing') {
        // If assigned to Debt category -> repayment toward current debt
        if (debtCatObj && t.category_id === debtCatObj.id) {
          currentDebtPaid += Number(t.amount);
        }
      }
    });

    const unpaidDebtRemainder = Math.max(0, currentDebtPlanned - currentDebtPaid);
    const nextCycleDebtTarget = unpaidDebtRemainder;

    const debtSummary = {
      plannedDebt: currentDebtPlanned,
      paidDebt: currentDebtPaid,
      unpaidRemainder: unpaidDebtRemainder,
      isFullyPaid: currentDebtPaid >= currentDebtPlanned && currentDebtPlanned > 0,
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
      const isCarried = !!t.is_carried_forward;

      const isInTargetCycle = tDate >= targetBounds.start && tDate < targetBounds.end;
      const isFromPast = tDate < targetBounds.start;
      const isFromCurrent = tDate >= currentBounds.start && tDate < currentBounds.end;

      let inScope = false;
      let countInCalculations = false;
      let isCarryingToNext = false;

      if (isCurrent) {
        // Current active cycle:
        if (isInTargetCycle) {
          inScope = true;
          if (isCarried) {
            // Pinned in current cycle to be carried to next cycle -> do not count in current calculations
            countInCalculations = false;
            isCarryingToNext = true;
          } else {
            countInCalculations = true;
          }
        } else if (isFromPast && isCarried) {
          // Transaction was carried forward from a past cycle into this newly active cycle!
          inScope = true;
          countInCalculations = true;
          isCarryingToNext = false;
        }
      } else if (isNext) {
        // Next cycle preview:
        if (isInTargetCycle) {
          inScope = true;
          countInCalculations = true;
        } else if (isFromCurrent && isCarried) {
          inScope = true;
          countInCalculations = true;
          isCarryingToNext = true;
        }
      } else {
        // Historical archives:
        if (isInTargetCycle && !isCarried) {
          inScope = true;
          countInCalculations = true;
        }
      }

      if (inScope) {
        if (t.kind === 'outgoing') {
          const catName = (t.category_id && catMap[t.category_id])
            ? catMap[t.category_id].name
            : (t.categories ? (Array.isArray(t.categories) ? t.categories[0]?.name : t.categories.name) : null);

          if (countInCalculations) {
            if (t.category_id && catMap[t.category_id]) {
              catMap[t.category_id].actual += Number(t.amount);
              catMap[t.category_id].remaining -= Number(t.amount);
            } else {
              uncatActual += Number(t.amount);
            }

            totalActual += Number(t.amount);
            if (isCurrent && isToday) todayTotal += Number(t.amount);
          }

          outgoing.push({
            row: t.id,
            kind: 'outgoing',
            source: t.source_or_merchant,
            date: new Date(t.transaction_date).toLocaleString(),
            timestamp: t.transaction_date,
            amount: Number(t.amount),
            note: t.note,
            category: catName,
            is_carried_forward: isCarryingToNext
          });
        } else {
          if (countInCalculations) {
            totalIncome += Number(t.amount);
            if (isCurrent && isToday) todayIncome += Number(t.amount);
          }

          incoming.push({
            row: t.id,
            kind: 'incoming',
            source: t.source_or_merchant,
            date: new Date(t.transaction_date).toLocaleString(),
            amount: Number(t.amount),
            note: t.note,
            is_carried_forward: isCarryingToNext
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

    const carriedTransactions = allTransactions
      .filter(t => t.is_carried_forward)
      .map(t => {
        const catName = (t.category_id && catMap[t.category_id])
          ? catMap[t.category_id].name
          : (t.categories ? (Array.isArray(t.categories) ? t.categories[0]?.name : t.categories.name) : 'Uncategorized');
        return {
          row: t.id,
          kind: t.kind,
          source: t.source_or_merchant,
          date: new Date(t.transaction_date).toLocaleString(),
          amount: Number(t.amount),
          note: t.note,
          category: catName,
          is_carried_forward: true
        };
      });

    const requestedHistoryFilter = searchParams.get('historyFilter') || 'all';
    const historyFilter = ['all', 'today', 'week', 'month'].includes(requestedHistoryFilter) ? requestedHistoryFilter : 'all';
    const historySearch = (searchParams.get('historySearch') || '').trim().toLowerCase();
    let filteredHistoryItems = [...outgoing, ...incoming];
    const historyNow = new Date();
    if (historyFilter === 'today') {
      filteredHistoryItems = filteredHistoryItems.filter(item => {
        const date = new Date(item.timestamp);
        return date.toDateString() === historyNow.toDateString();
      });
    } else if (historyFilter === 'week') {
      const startOfWeek = new Date(historyNow);
      startOfWeek.setHours(0, 0, 0, 0);
      startOfWeek.setDate(historyNow.getDate() - historyNow.getDay());
      filteredHistoryItems = filteredHistoryItems.filter(item => new Date(item.timestamp) >= startOfWeek);
    } else if (historyFilter === 'month') {
      let month = historyNow.getMonth();
      let year = historyNow.getFullYear();
      if (historyNow.getDate() < 20) month -= 1;
      if (month < 0) { month = 11; year -= 1; }
      const startOfMonth = new Date(year, month, 20);
      filteredHistoryItems = filteredHistoryItems.filter(item => new Date(item.timestamp) >= startOfMonth);
    }
    if (historySearch) {
      filteredHistoryItems = filteredHistoryItems.filter(item => {
        const haystack = [item.source, item.note, item.category, item.amount].map(value => String(value || '').toLowerCase());
        return haystack.some(value => value.includes(historySearch));
      });
    }
    const historyItems = filteredHistoryItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const historyTotal = historyItems.length;
    const historyStart = (historyPage - 1) * historyPageSize;
    const historyPageItems = historyItems.slice(historyStart, historyStart + historyPageSize);
    const pagedOutgoing = historyPageItems.filter(item => item.kind === 'outgoing');
    const pagedIncoming = historyPageItems.filter(item => item.kind === 'incoming');

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
        outgoing: pagedOutgoing,
        incoming: pagedIncoming,
        history: {
          page: historyPage,
          pageSize: historyPageSize,
          total: historyTotal,
          hasMore: historyStart + historyPageItems.length < historyTotal
        },
        categories: categories.map(c => c.name),
        todayTotal,
        todayIncome,
        historyCycles: historicalCycles,
        debtSummary,
        carriedTransactions
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
    }, {
      headers: {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate'
      }
    });

  } catch (err) {
    console.error('Dashboard Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
