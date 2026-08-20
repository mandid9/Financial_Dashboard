import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

function getCookie(req, name) {
  const cookies = req.headers.get('cookie') || '';
  const match = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : '';
}

function getAccessToken(req) {
  const authorization = req.headers.get('authorization') || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return getCookie(req, 'finance_access_token');
}

export async function getAuthenticatedUser(req) {
  const accessToken = getAccessToken(req);
  if (accessToken) {
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (!error && data.user) return data.user;
  }

  const refreshToken = getCookie(req, 'finance_refresh_token');
  if (refreshToken) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (!error && data.user) return data.user;
  }

  return null;
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
}
