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

    const testId = searchParams.get('test_id') || 'cc8b850b-f984-4d64-8231-fff14e554b9a';
    const setCarry = searchParams.get('carry') === 'true';

    // Test update exactly like action/route.js does
    const { data, error } = await supabase
      .from('transactions')
      .update({ is_carried_forward: setCarry })
      .eq('id', testId)
      .select();

    return NextResponse.json({
      updated: data,
      error: error ? error.message : null
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
