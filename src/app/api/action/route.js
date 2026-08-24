import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { evaluateAndDispatchTriggers } from '@/lib/push';
import { getAuthenticatedUser, unauthorizedResponse } from '@/lib/auth';

async function getCategoryIdByName(rawName, userId, isOwner = false) {
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
  if (isOwner) {
    exactQuery = exactQuery.or(`user_id.eq.${userId},user_id.is.null`);
  } else {
    exactQuery = exactQuery.eq('user_id', userId);
  }
  const { data: catExact } = await exactQuery.maybeSingle();
  if (catExact) return catExact.id;

  // 2. Try case-insensitive match
  let ilikeQuery = supabase.from('categories').select('id').ilike('name', clean);
  if (isOwner) {
    ilikeQuery = ilikeQuery.or(`user_id.eq.${userId},user_id.is.null`);
  } else {
    ilikeQuery = ilikeQuery.eq('user_id', userId);
  }
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
  const isOwner = user.email === 'kr.wn20@gmail.com';

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
        const catId = await getCategoryIdByName(catName, userId, isOwner);

        if (typeof reduceDebtAmount === 'number' && reduceDebtAmount > 0) {
          let debtQuery = supabase
            .from('categories')
            .select('id, planned_amount')
            .ilike('name', 'debt');

          if (isOwner) {
            debtQuery = debtQuery.or(`user_id.eq.${userId},user_id.is.null`);
          } else {
            debtQuery = debtQuery.eq('user_id', userId);
          }

          const { data: debtCat } = await debtQuery.maybeSingle();

          if (debtCat) {
            const currentPlan = Number(debtCat.planned_amount) || 0;
            const newPlan = Math.max(0, currentPlan - reduceDebtAmount);
            await supabase
              .from('categories')
              .update({ planned_amount: newPlan })
              .eq('id', debtCat.id);
          }
        }

        let updateQuery = supabase
          .from('transactions')
          .update({ category_id: catId })
          .eq('id', id);

        if (isOwner) {
          updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          updateQuery = updateQuery.eq('user_id', userId);
        }

        const { error } = await updateQuery;
        if (error) throw error;
        evaluateAndDispatchTriggers(false, userId).catch(err => console.warn('Push alert error:', err));
        return NextResponse.json({ success: true });
      }

      case 'saveNote':
      case 'saveIncomeNote': {
        const [id, note] = args;
        const cleanNote = sanitizeStr(note, 500);
        let updateQuery = supabase
          .from('transactions')
          .update({ note: cleanNote })
          .eq('id', id);

        if (isOwner) {
          updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          updateQuery = updateQuery.eq('user_id', userId);
        }

        const { error } = await updateQuery;
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'saveIncomeSource': {
        const [id, src] = args;
        const cleanSrc = sanitizeStr(src, 200);
        let updateQuery = supabase
          .from('transactions')
          .update({ source_or_merchant: cleanSrc })
          .eq('id', id);

        if (isOwner) {
          updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          updateQuery = updateQuery.eq('user_id', userId);
        }

        const { error } = await updateQuery;
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'undoTransaction': {
        const [id] = args;
        let delQuery = supabase
          .from('transactions')
          .delete()
          .eq('id', id);

        if (isOwner) {
          delQuery = delQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          delQuery = delQuery.eq('user_id', userId);
        }

        const { error } = await delQuery;
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'toggleCarryForward': {
        const [id, isCarried] = args;
        let updateQuery = supabase
          .from('transactions')
          .update({ is_carried_forward: !!isCarried })
          .eq('id', id);

        if (isOwner) {
          updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          updateQuery = updateQuery.eq('user_id', userId);
        }

        const { error } = await updateQuery;
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'addManualExpense': {
        const [rawAmount, catName, note, merchant, isCarried] = args;
        const amount = parseValidAmount(rawAmount);
        if (amount === null || amount <= 0) {
          return NextResponse.json({ error: 'Valid positive amount is required' }, { status: 400 });
        }
        const catId = await getCategoryIdByName(catName, userId, isOwner);
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
        let selectQuery = supabase
          .from('transactions')
          .select('*')
          .eq('id', id);

        if (isOwner) {
          selectQuery = selectQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          selectQuery = selectQuery.eq('user_id', userId);
        }

        const { data: orig, error: fetchErr } = await selectQuery.single();
        if (fetchErr) throw fetchErr;
        if (!orig) throw new Error('Transaction not found');

        let delQuery = supabase
          .from('transactions')
          .delete()
          .eq('id', id);

        if (isOwner) {
          delQuery = delQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          delQuery = delQuery.eq('user_id', userId);
        }

        const { error: delErr } = await delQuery;
        if (delErr) throw delErr;

        for (const p of parts) {
          const catId = await getCategoryIdByName(p.category, userId, isOwner);
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
        let updateQuery = supabase
          .from('categories')
          .update({ planned_amount: planned })
          .eq('name', name);

        if (isOwner) {
          updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          updateQuery = updateQuery.eq('user_id', userId);
        }

        const { error } = await updateQuery;
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'renameExpenseCategory': {
        const [oldName, newName] = args;
        let updateQuery = supabase
          .from('categories')
          .update({ name: newName })
          .eq('name', oldName);

        if (isOwner) {
          updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          updateQuery = updateQuery.eq('user_id', userId);
        }

        const { error } = await updateQuery;
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'deleteExpenseCategory': {
        const [name] = args;
        let delQuery = supabase
          .from('categories')
          .delete()
          .eq('name', name);

        if (isOwner) {
          delQuery = delQuery.or(`user_id.eq.${userId},user_id.is.null`);
        } else {
          delQuery = delQuery.eq('user_id', userId);
        }

        const { error } = await delQuery;
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'closeBudgetPeriodAndStartFresh': {
        const [carryItems, nextDebtAmount] = args;
        if (Array.isArray(carryItems)) {
          for (const item of carryItems) {
            let updateQuery = supabase
              .from('transactions')
              .update({ is_carried_forward: true })
              .eq('id', item.row);

            if (isOwner) {
              updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
            } else {
              updateQuery = updateQuery.eq('user_id', userId);
            }

            const { error } = await updateQuery;
            if (error) throw error;
          }
        }
        if (typeof nextDebtAmount === 'number') {
          let debtQuery = supabase
            .from('categories')
            .select('id, name')
            .ilike('name', 'debt');

          if (isOwner) {
            debtQuery = debtQuery.or(`user_id.eq.${userId},user_id.is.null`);
          } else {
            debtQuery = debtQuery.eq('user_id', userId);
          }

          const { data: debtCat } = await debtQuery.maybeSingle();

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
          let updateQuery = supabase
            .from('categories')
            .update({ sort_order: i })
            .eq('id', orderedIds[i]);

          if (isOwner) {
            updateQuery = updateQuery.or(`user_id.eq.${userId},user_id.is.null`);
          } else {
            updateQuery = updateQuery.eq('user_id', userId);
          }

          const { error } = await updateQuery;
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
