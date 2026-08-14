export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  try {
    const now = new Date();
    const cycleStartDay = 20;
    
    let cycleMonth = now.getMonth();
    let cycleYear = now.getFullYear();
    if (now.getDate() < cycleStartDay) {
      cycleMonth -= 1;
      if (cycleMonth < 0) {
        cycleMonth = 11;
        cycleYear -= 1;
      }
    }
    const startOfMonth = new Date(cycleYear, cycleMonth, cycleStartDay).toISOString();
    
    let lastCycleMonth = cycleMonth - 1;
    let lastCycleYear = cycleYear;
    if (lastCycleMonth < 0) {
      lastCycleMonth = 11;
      lastCycleYear -= 1;
    }
    const startOfLastMonth = new Date(lastCycleYear, lastCycleMonth, cycleStartDay).toISOString();
    
    // 1. Fetch categories
    const { data: categories, error: catError } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true });
    if (catError) throw catError;

    // 2. Fetch all transactions (History tab needs them all, Home tab filters by isToday, etc.)
    const { data: currentTx, error: txError } = await supabase
      .from('transactions')
      .select('*, categories(name)')
      .order('transaction_date', { ascending: false });
    if (txError) throw txError;
    
    const historicalCycles = [];
    for (let i = 1; i <= 4; i++) {
      let m = cycleMonth - i;
      let y = cycleYear;
      while (m < 0) { m += 12; y -= 1; }
      
      let nextM = cycleMonth - i + 1;
      let nextY = cycleYear;
      while (nextM < 0) { nextM += 12; nextY -= 1; }
      
      const start = new Date(y, m, cycleStartDay).toISOString();
      const end = new Date(nextY, nextM, cycleStartDay).toISOString();
      
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const label = `${monthNames[m]} ${cycleStartDay}`;
      
      historicalCycles.unshift({
        label,
        start,
        end,
        income: 0,
        outgoing: 0,
        categories: {}
      });
    }

    // Process budget metrics
    let totalPlanned = 0;
    let totalActual = 0;
    let uncatActual = 0;
    const catMap = {};
    
    categories.forEach(c => {
      catMap[c.id] = {
        row: c.id,
        name: c.name,
        planned: Number(c.planned_amount),
        actual: 0,
        remaining: Number(c.planned_amount),
        sort_order: c.sort_order ?? 0
      };
      if (c.name !== 'Uncategorized') totalPlanned += Number(c.planned_amount);
    });

    const outgoing = [];
    const incoming = [];
    let todayTotal = 0;
    let todayIncome = 0;
    const todayStr = now.toISOString().split('T')[0];

    currentTx.forEach(t => {
      const isToday = t.transaction_date.startsWith(todayStr);
      const isCurrentMonth = t.transaction_date >= startOfMonth;
      
      if (t.kind === 'outgoing') {
        const catName = (t.category_id && catMap[t.category_id]) 
          ? catMap[t.category_id].name 
          : (t.categories ? (Array.isArray(t.categories) ? t.categories[0]?.name : t.categories.name) : null);
        
        // Count towards budget if it's in the current month
        if (isCurrentMonth) {
          if (t.category_id && catMap[t.category_id]) {
            catMap[t.category_id].actual += Number(t.amount);
            catMap[t.category_id].remaining -= Number(t.amount);
          } else {
            uncatActual += Number(t.amount);
          }
          totalActual += Number(t.amount);
        }
        
        if (isCurrentMonth && isToday) todayTotal += Number(t.amount);
        
        outgoing.push({
          row: t.id,
          kind: 'outgoing',
          source: t.source_or_merchant,
          date: new Date(t.transaction_date).toLocaleString(),
          amount: Number(t.amount),
          note: t.note,
          category: catName
        });
      } else {
        if (isCurrentMonth && isToday) todayIncome += Number(t.amount);
        incoming.push({
          row: t.id,
          kind: 'incoming',
          source: t.source_or_merchant,
          date: new Date(t.transaction_date).toLocaleString(),
          amount: Number(t.amount),
          note: t.note
        });
      }
      
      if (!isCurrentMonth) {
        for (const hc of historicalCycles) {
          if (t.transaction_date >= hc.start && t.transaction_date < hc.end) {
            if (t.kind === 'outgoing') {
              hc.outgoing += Number(t.amount);
              const cname = (t.category_id && catMap[t.category_id]) 
                ? catMap[t.category_id].name 
                : (t.categories ? (Array.isArray(t.categories) ? t.categories[0]?.name : t.categories.name) : 'Uncategorized');
              hc.categories[cname] = (hc.categories[cname] || 0) + Number(t.amount);
            } else {
              hc.income += Number(t.amount);
            }
            break;
          }
        }
      }
    });

    let nextCycleMonth = cycleMonth + 1;
    let nextCycleYear = cycleYear;
    if (nextCycleMonth > 11) {
      nextCycleMonth = 0;
      nextCycleYear += 1;
    }
    const endOfCycle = new Date(nextCycleYear, nextCycleMonth, cycleStartDay);
    const midnightNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysLeft = Math.round((endOfCycle - midnightNow) / (1000 * 60 * 60 * 24));
    
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

    return NextResponse.json({
      dashboard: {
        outgoing,
        incoming,
        categories: categories.map(c => c.name),
        todayTotal,
        todayIncome,
        historyCycles: historicalCycles
      },
      budget: {
        metrics: {
          planned: totalPlanned,
          actual: totalActual,
          balance: totalPlanned - totalActual,
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
