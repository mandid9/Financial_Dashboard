import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { evaluateAndDispatchTriggers } from '@/lib/push';
import { getAuthenticatedUser, unauthorizedResponse } from '@/lib/auth';

async function getCategoryIdByName(rawName, userId = null) {
  if (!rawName) return null;
  const clean = String(rawName)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();

  if (!clean || clean.toLowerCase() === 'uncategorized') return null;

  // 1. Try exact match
  let exactQuery = supabase.from('categories').select('id').eq('name', clean);
  if (userId) exactQuery = exactQuery.or(`user_id.eq.${userId},user_id.is.null`);
  const { data: catExact } = await exactQuery.maybeSingle();
  if (catExact) return catExact.id;

  // 2. Try case-insensitive match
  let ilikeQuery = supabase.from('categories').select('id').ilike('name', clean);
  if (userId) ilikeQuery = ilikeQuery.or(`user_id.eq.${userId},user_id.is.null`);
  const { data: catIlike } = await ilikeQuery.maybeSingle();
  if (catIlike) return catIlike.id;

  return null;
}

function sanitizeStr(val, maxLen = 500) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

function parseValidAmount(val) {
  const num = Number(val);
  if (isNaN(num) || !isFinite(num) || num < 0 || num > 100000000) return null;
  return Math.round(num * 100) / 100;
}

export async function POST(req) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedResponse();
  const userId = user.id;

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { action, args } = body;
    if (!action || !Array.isArray(args)) {
      return NextResponse.json({ error: 'Action and args array are required' }, { status: 400 });
    }

    switch (action) {
      case 'saveCategory': {
        const [id, catName, reduceDebtAmount] = args;
        const catId = await getCategoryIdByName(catName, userId);

        if (typeof reduceDebtAmount === 'number' && reduceDebtAmount > 0) {
          const { data: debtCat } = await supabase
            .from('categories')
            .select('id, planned_amount')
            .ilike('name', 'debt')
            .or(`user_id.eq.${userId},user_id.is.null`)
            .maybeSingle();

          if (debtCat) {
            const currentPlan = Number(debtCat.planned_amount) || 0;
            const newPlan = Math.max(0, currentPlan - reduceDebtAmount);
            await supabase
              .from('categories')
              .update({ planned_amount: newPlan })
              .eq('id', debtCat.id);
          }
        }

        const { error } = await supabase
          .from('transactions')
          .update({ category_id: catId })
          .eq('id', id)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        evaluateAndDispatchTriggers(false, userId).catch(err => console.warn('Push alert error:', err));
        return NextResponse.json({ success: true });
      }

      case 'saveNote':
      case 'saveIncomeNote': {
        const [id, note] = args;
        const cleanNote = sanitizeStr(note, 500);
        const { error } = await supabase
          .from('transactions')
          .update({ note: cleanNote })
          .eq('id', id)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'saveIncomeSource': {
        const [id, src] = args;
        const cleanSrc = sanitizeStr(src, 200);
        const { error } = await supabase
          .from('transactions')
          .update({ source_or_merchant: cleanSrc })
          .eq('id', id)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'undoTransaction': {
        const [id] = args;
        const { error } = await supabase
          .from('transactions')
          .delete()
          .eq('id', id)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'toggleCarryForward': {
        const [id, isCarried] = args;
        const { error } = await supabase
          .from('transactions')
          .update({ is_carried_forward: !!isCarried })
          .eq('id', id)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'addManualExpense': {
        const [rawAmount, catName, note, merchant, isCarried] = args;
        const amount = parseValidAmount(rawAmount);
        if (amount === null || amount <= 0) {
          return NextResponse.json({ error: 'Valid positive amount is required' }, { status: 400 });
        }
        const catId = await getCategoryIdByName(catName, userId);
        const { error } = await supabase.from('transactions').insert([{
          user_id: userId,
          kind: 'outgoing',
          amount,
          category_id: catId,
          note: sanitizeStr(note, 500),
          source_or_merchant: sanitizeStr(merchant, 200) || 'Manual Expense',
          is_carried_forward: !!isCarried,
          transaction_date: new Date().toISOString()
        }]);
        if (error) throw error;
        evaluateAndDispatchTriggers(false, userId).catch(err => console.warn('Push alert error:', err));
        return NextResponse.json({ success: true });
      }

      case 'addManualIncome': {
        const [rawAmount, source, note, extra, isCarried] = args;
        const amount = parseValidAmount(rawAmount);
        if (amount === null || amount <= 0) {
          return NextResponse.json({ error: 'Valid positive amount is required' }, { status: 400 });
        }
        const { error } = await supabase.from('transactions').insert([{
          user_id: userId,
          kind: 'incoming',
          amount,
          source_or_merchant: sanitizeStr(source, 200) || 'Manual Income',
          note: sanitizeStr(note, 500),
          is_carried_forward: !!isCarried,
          transaction_date: new Date().toISOString()
        }]);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'splitTransaction': {
        const [id, parts] = args;
        const { data: orig, error: fetchErr } = await supabase
          .from('transactions')
          .select('*')
          .eq('id', id)
          .or(`user_id.eq.${userId},user_id.is.null`)
          .single();

        if (fetchErr) throw fetchErr;
        if (!orig) throw new Error('Transaction not found');

        const { error: delErr } = await supabase
          .from('transactions')
          .delete()
          .eq('id', id)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (delErr) throw delErr;

        for (const p of parts) {
          const catId = await getCategoryIdByName(p.category, userId);
          const { error: insErr } = await supabase.from('transactions').insert([{
            user_id: userId,
            kind: orig.kind,
            amount: p.amount,
            source_or_merchant: orig.source_or_merchant,
            note: 'Split | ' + (orig.note || ''),
            transaction_date: orig.transaction_date,
            category_id: catId
          }]);
          if (insErr) throw insErr;
        }
        return NextResponse.json({ success: true });
      }

      case 'addExpenseCategory': {
        const [name, planned] = args;
        const { error } = await supabase.from('categories').insert([{
          user_id: userId,
          name,
          planned_amount: planned
        }]);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'updateCategoryBudget': {
        const [name, planned] = args;
        const { error } = await supabase
          .from('categories')
          .update({ planned_amount: planned })
          .eq('name', name)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'renameExpenseCategory': {
        const [oldName, newName] = args;
        const { error } = await supabase
          .from('categories')
          .update({ name: newName })
          .eq('name', oldName)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'deleteExpenseCategory': {
        const [name] = args;
        const { error } = await supabase
          .from('categories')
          .delete()
          .eq('name', name)
          .or(`user_id.eq.${userId},user_id.is.null`);

        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'closeBudgetPeriodAndStartFresh': {
        const [carryItems, nextDebtAmount] = args;
        if (Array.isArray(carryItems)) {
          for (const item of carryItems) {
            const { error } = await supabase
              .from('transactions')
              .update({ is_carried_forward: true })
              .eq('id', item.row)
              .or(`user_id.eq.${userId},user_id.is.null`);

            if (error) throw error;
          }
        }
        if (typeof nextDebtAmount === 'number') {
          const { data: debtCat } = await supabase
            .from('categories')
            .select('id, name')
            .ilike('name', 'debt')
            .or(`user_id.eq.${userId},user_id.is.null`)
            .maybeSingle();

          if (debtCat) {
            await supabase
              .from('categories')
              .update({ planned_amount: nextDebtAmount })
              .eq('id', debtCat.id);
          }
        }
        return NextResponse.json({ openingBalance: 0, backupUrl: 'Supabase auto-backups enabled' });
      }

      case 'reorderCategories': {
        const [orderedIds] = args;
        for (let i = 0; i < orderedIds.length; i++) {
          const { error } = await supabase
            .from('categories')
            .update({ sort_order: i })
            .eq('id', orderedIds[i])
            .or(`user_id.eq.${userId},user_id.is.null`);

          if (error) throw error;
        }
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
  } catch (err) {
    console.error('Action Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
