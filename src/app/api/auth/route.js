import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAuthenticatedUser, unauthorizedResponse } from '@/lib/auth';

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

export async function GET(req) {
  const user = await getAuthenticatedUser(req);
  if (!user) return unauthorizedResponse();
  return NextResponse.json({ user: { id: user.id, email: user.email } });
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });

    const response = NextResponse.json({ user: { id: data.user.id, email: data.user.email } });
    response.cookies.set('finance_access_token', data.session.access_token, { ...cookieOptions, maxAge: data.session.expires_in || 3600 });
    response.cookies.set('finance_refresh_token', data.session.refresh_token, { ...cookieOptions, maxAge: 60 * 60 * 24 * 30 });
    return response;
  } catch (error) {
    console.error('Auth Error:', error);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.set('finance_access_token', '', { ...cookieOptions, maxAge: 0 });
  response.cookies.set('finance_refresh_token', '', { ...cookieOptions, maxAge: 0 });
  return response;
}
