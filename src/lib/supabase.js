import { createClient } from '@supabase/supabase-js';

function formatSupabaseUrl(raw) {
  if (!raw || typeof raw !== 'string') return 'https://placeholder.supabase.co';
  let url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

const supabaseUrl = formatSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim()) || 'placeholder-anon-key';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

