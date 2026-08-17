import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { evaluateAndDispatchTriggers } from '@/lib/push';

async function getCategoryIdByName(rawName) {
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
  const { data: catExact } = await supabase.from('categories').select('id').eq('name', clean).maybeSingle();
  if (catExact) return catExact.id;

  // 2. Try case-insensitive match
  const { data: catIlike } = await supabase.from('categories').select('id').ilike('name', clean).maybeSingle();
  if (catIlike) return catIlike.id;

  return null;
}

export async function POST(req) {
  try {
    const { action, args } = await req.json();

    switch (action) {
      case 'saveCategory': {
        const [id, catName, reduceDebtAmount] = args;
        const catId = await getCategoryIdByName(catName);

        if (typeof reduceDebtAmount === 'number' && reduceDebtAmount > 0) {
          const { data: debtCat } = await supabase.from('categories').select('id, planned_amount').ilike('name', 'debt').maybeSingle();
          if (debtCat) {
            const currentPlan = Number(debtCat.planned_amount) || 0;
            const newPlan = Math.max(0, currentPlan - reduceDebtAmount);
            await supabase.from('categories').update({ planned_amount: newPlan }).eq('id', debtCat.id);
          }
        }

        const { error } = await supabase.from('transactions').update({ category_id: catId }).eq('id', id);
        if (error) throw error;
        evaluateAndDispatchTriggers(false).catch(err => console.warn('Push alert error:', err));
        return NextResponse.json({ success: true });
      }
      
      case 'saveNote':
      case 'saveIncomeNote': {
        const [id, note] = args;
        const { error } = await supabase.from('transactions').update({ note }).eq('id', id);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'saveIncomeSource': {
        const [id, src] = args;
        const { error } = await supabase.from('transactions').update({ source_or_merchant: src }).eq('id', id);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'undoTransaction': {
        const [id] = args;
        const { error } = await supabase.from('transactions').delete().eq('id', id);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'toggleCarryForward': {
        const [id, isCarried] = args;
        const { error } = await supabase.from('transactions').update({ is_carried_forward: !!isCarried }).eq('id', id);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'addManualExpense': {
        const [amount, catName, note, merchant, isCarried] = args;
        const catId = await getCategoryIdByName(catName);
        const { error } = await supabase.from('transactions').insert([{
          kind: 'outgoing',
          amount,
          category_id: catId,
          note: note || '',
          source_or_merchant: merchant,
          is_carried_forward: !!isCarried,
          transaction_date: new Date().toISOString()
        }]);
        if (error) throw error;
        evaluateAndDispatchTriggers(false).catch(err => console.warn('Push alert error:', err));
        return NextResponse.json({ success: true });
      }

      case 'addManualIncome': {
        const [amount, source, note, extra, isCarried] = args;
        const { error } = await supabase.from('transactions').insert([{
          kind: 'incoming',
          amount,
          source_or_merchant: source,
          note: note || '',
          is_carried_forward: !!isCarried,
          transaction_date: new Date().toISOString()
        }]);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'splitTransaction': {
        const [id, parts] = args; // parts: [{amount, category}]
        // 1. Fetch original
        const { data: orig, error: fetchErr } = await supabase.from('transactions').select('*').eq('id', id).single();
        if (fetchErr) throw fetchErr;
        if (!orig) throw new Error('Transaction not found');
        
        // 2. Delete original
        const { error: delErr } = await supabase.from('transactions').delete().eq('id', id);
        if (delErr) throw delErr;
        
        // 3. Insert parts
        for (const p of parts) {
          const catId = await getCategoryIdByName(p.category);
          const { error: insErr } = await supabase.from('transactions').insert([{
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
        const { error } = await supabase.from('categories').insert([{ name, planned_amount: planned }]);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'updateCategoryBudget': {
        const [name, planned] = args;
        const { error } = await supabase.from('categories').update({ planned_amount: planned }).eq('name', name);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'renameExpenseCategory': {
        const [oldName, newName] = args;
        const { error } = await supabase.from('categories').update({ name: newName }).eq('name', oldName);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'deleteExpenseCategory': {
        const [name] = args;
        const { error } = await supabase.from('categories').delete().eq('name', name);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case 'closeBudgetPeriodAndStartFresh': {
        const [carryItems, nextDebtAmount] = args;
        if (Array.isArray(carryItems)) {
          for (const item of carryItems) {
            const { error } = await supabase.from('transactions').update({ is_carried_forward: true }).eq('id', item.row);
            if (error) throw error;
          }
        }
        if (typeof nextDebtAmount === 'number') {
          const { data: debtCat } = await supabase.from('categories').select('id, name').ilike('name', 'debt').maybeSingle();
          if (debtCat) {
            await supabase.from('categories').update({ planned_amount: nextDebtAmount }).eq('id', debtCat.id);
          }
        }
        return NextResponse.json({ openingBalance: 0, backupUrl: 'Supabase auto-backups enabled' });
      }

      case 'reorderCategories': {
        const [orderedIds] = args; // array of category IDs in desired order
        for (let i = 0; i < orderedIds.length; i++) {
          const { error } = await supabase.from('categories').update({ sort_order: i }).eq('id', orderedIds[i]);
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
