import { createClient } from '@supabase/supabase-js';

function formatSupabaseUrl(raw) {
  if (!raw || typeof raw !== 'string' || raw.includes('[SENSITIVE]')) return 'https://placeholder.supabase.co';
  let url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

const supabaseUrl = formatSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
const rawAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseAnonKey = (rawAnon && typeof rawAnon === 'string' && !rawAnon.includes('[SENSITIVE]')) ? rawAnon.trim() : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

