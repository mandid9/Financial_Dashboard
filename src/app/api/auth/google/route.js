export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req) {
  try {
    const origin = req.nextUrl.origin;
    const redirectTo = `${origin}/index.html`;

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo,
        queryParams: {
          access_type: 'offline',
          prompt: 'select_account',
        }
      }
    });

    if (error) throw error;
    if (data?.url) {
      return NextResponse.redirect(data.url, { status: 302 });
    }

    return NextResponse.json({ error: 'Could not generate Google OAuth URL' }, { status: 500 });
  } catch (err) {
    console.error('Google Auth Init Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
