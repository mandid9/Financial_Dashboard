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

    const { data: usersData, error: uErr } = await supabase.auth.admin.listUsers();
    const users = (usersData?.users || []).map(u => ({ id: u.id, email: u.email }));

    // Get the salary transaction
    const { data: salaryTx } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', 'cc8b850b-f984-4d64-8231-fff14e554b9a')
      .maybeSingle();

    return NextResponse.json({
      users,
      uErr: uErr ? uErr.message : null,
      salaryTx
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
