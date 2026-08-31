export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { id_token } = body;

    if (!id_token || typeof id_token !== 'string') {
      return NextResponse.json({ error: 'id_token is required' }, { status: 400 });
    }

    // Exchange Google ID token for a Supabase session
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: id_token,
    });

    if (error || !data?.session || !data?.user) {
      console.error('signInWithIdToken error:', error?.message);
      return NextResponse.json(
        { error: error?.message || 'Authentication failed' },
        { status: 401 }
      );
    }

    const response = NextResponse.json({
      user: { id: data.user.id, email: data.user.email },
    });

    response.cookies.set('finance_access_token', data.session.access_token, {
      ...cookieOptions,
      maxAge: data.session.expires_in || 3600,
    });

    if (data.session.refresh_token) {
      response.cookies.set('finance_refresh_token', data.session.refresh_token, {
        ...cookieOptions,
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    return response;
  } catch (err) {
    console.error('Google ID Token Auth Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
