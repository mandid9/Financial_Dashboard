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

    // 1. Fetch all categories
    const { data: allCategories, error: catErr } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (catErr) throw catErr;

    // 2. Fetch all transactions to count category usage
    const { data: allTxs, error: txErr } = await supabase
      .from('transactions')
      .select('id, category_id, user_id, amount, source_or_merchant, transaction_date');

    if (txErr) throw txErr;

    const txCountByCat = {};
    const txSamplesByCat = {};
    for (const tx of allTxs || []) {
      if (tx.category_id) {
        txCountByCat[tx.category_id] = (txCountByCat[tx.category_id] || 0) + 1;
        if (!txSamplesByCat[tx.category_id]) txSamplesByCat[tx.category_id] = [];
        if (txSamplesByCat[tx.category_id].length < 3) {
          txSamplesByCat[tx.category_id].push({
            id: tx.id,
            amount: tx.amount,
            source: tx.source_or_merchant,
            date: tx.transaction_date,
            user_id: tx.user_id
          });
        }
      }
    }

    const categoriesWithStats = (allCategories || []).map(c => ({
      id: c.id,
      name: c.name,
      planned_amount: c.planned_amount,
      sort_order: c.sort_order,
      user_id: c.user_id,
      created_at: c.created_at,
      tx_count: txCountByCat[c.id] || 0,
      samples: txSamplesByCat[c.id] || []
    }));

    // Find distinct user_ids
    const userIdsInCats = [...new Set((allCategories || []).map(c => c.user_id))];
    const userIdsInTxs = [...new Set((allTxs || []).map(t => t.user_id))];

    return NextResponse.json({
      success: true,
      total_categories: allCategories?.length || 0,
      userIdsInCats,
      userIdsInTxs,
      categories: categoriesWithStats
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== SECRET_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { action, ids, targetUserId } = body;

    if (action === 'delete_by_ids' && Array.isArray(ids) && ids.length > 0) {
      // 1. Unlink any transactions referencing these categories first (safe)
      const { error: unlinkErr } = await supabase
        .from('transactions')
        .update({ category_id: null })
        .in('category_id', ids);

      if (unlinkErr) console.warn('Unlink error:', unlinkErr.message);

      // 2. Also unlink user_sms_rules referencing these categories
      const { error: smsRuleUnlinkErr } = await supabase
        .from('user_sms_rules')
        .update({ default_category_id: null })
        .in('default_category_id', ids);

      if (smsRuleUnlinkErr) console.warn('SMS rule unlink error:', smsRuleUnlinkErr.message);

      // 3. Delete categories
      const { data: deleted, error: delErr } = await supabase
        .from('categories')
        .delete()
        .in('id', ids)
        .select();

      if (delErr) throw delErr;

      return NextResponse.json({
        success: true,
        deleted_count: deleted?.length || 0,
        deleted
      });
    }

    if (action === 'unify_owner_categories' && targetUserId) {
      const ownerAliases = [
        targetUserId,
        '5aa42527-12fc-448a-a108-70531f3c5607',
        '2463bf7f-f454-454f-b8bc-b8328f85069b',
        '7d88ef85-b3e7-4eb5-a00d-1c61a6bb0d28'
      ];

      const { data: updatedCats, error: catUpErr } = await supabase
        .from('categories')
        .update({ user_id: targetUserId })
        .in('user_id', ownerAliases)
        .select();

      const { data: updatedNullCats, error: catNullUpErr } = await supabase
        .from('categories')
        .update({ user_id: targetUserId })
        .is('user_id', null)
        .select();

      return NextResponse.json({
        success: true,
        updatedCatsCount: (updatedCats?.length || 0) + (updatedNullCats?.length || 0)
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
