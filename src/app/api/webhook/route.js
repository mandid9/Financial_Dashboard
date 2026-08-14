import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import webpush from 'web-push';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || 'BPnDeX4aUsrrHasl3PVoX9Cc2jWmbN9Doi1PXThwupBsJOjFWLioEWEmaXcBUAhA3Ezl3aIUFk81rYA8i3jFYXA';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '55Jm7p3LrpUYkB9OYrt6IP9qHS-7wZG0hs_w80TSz7M';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@personalfinance.app';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function notifySubscribers(payload) {
  try {
    const { data: subs } = await supabase.from('push_subscriptions').select('*');
    if (!subs || subs.length === 0) return;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload));
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        }
      }
    }
  } catch (err) {
    console.warn('Push notify error in webhook:', err);
  }
}

export async function POST(req) {
  try {
    const body = await req.text();
    if (!body) return new NextResponse('No message', { status: 400 });

    const now = new Date().toISOString();

    if (/Reversed|Refunded/i.test(body)) return await handleReversal(body, now);
    if (/IPN transfer sent/i.test(body) || /(Debit|Credit)\s+Card/i.test(body)) return await logExpense(body, now);
    if (/IPN transfer re(ceived|cieved)/i.test(body)) return await logIncome(body, now, 'IPN Received', '');
    if (/اضافة راتبك/.test(body)) return await logSalary(body, now);

    return new NextResponse('Ignored: No pattern matched', { status: 200 });
  } catch (err) {
    console.error('Webhook Error:', err);
    return new NextResponse('Error', { status: 500 });
  }
}

async function logExpense(message, time) {
  const amount = parseEgp(message) || 0;
  const source = detectOutgoingSource(message);
  const merchant = ((message.match(/@([^,]+),/)||[])[1]||'').trim();

  // Check duplicate (last 10 transactions in 5 mins)
  const { data: recent } = await supabase
    .from('transactions')
    .select('*')
    .eq('kind', 'outgoing')
    .order('created_at', { ascending: false })
    .limit(10);

  if (recent) {
    const win = 5 * 60000;
    const isDup = recent.some(t => {
      const d = new Date(time) - new Date(t.transaction_date);
      return Number(t.amount) === Number(amount) && d >= 0 && d <= win;
    });
    if (isDup) return new NextResponse('Duplicate ignored', { status: 200 });
  }

  const { error } = await supabase
    .from('transactions')
    .insert([{
      kind: 'outgoing',
      amount: amount,
      source_or_merchant: merchant || source,
      note: merchant ? '' : null,
      transaction_date: time
    }]);

  if (error) throw error;

  // Count unhandled
  const { count } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .eq('kind', 'outgoing')
    .is('category_id', null);

  if (count && count >= 5) {
    await notifySubscribers({
      title: `📋 ${count} Transactions Need Attention`,
      body: `You have ${count} uncategorized transactions waiting for review. Tap to categorize.`,
      icon: '/icon.svg',
      url: '/index.html'
    });
  }

  return new NextResponse(`Success | Unhandled: ${count}`, { status: 200 });
}

async function logIncome(message, time, type, note) {
  const amount = parseEgp(message);
  if (!amount) return new NextResponse('Could not parse amount', { status: 400 });

  const { error } = await supabase
    .from('transactions')
    .insert([{
      kind: 'incoming',
      amount: amount,
      source_or_merchant: type,
      note: note,
      transaction_date: time
    }]);

  if (error) throw error;
  return new NextResponse('Success', { status: 200 });
}

async function logSalary(message, time) {
  const match = message.match(/([\d,.]+)\s*EGP/i);
  if (!match) return new NextResponse('Could not parse salary', { status: 400 });
  const amount = match[1].replace(/,/g, '');
  
  const { error } = await supabase
    .from('transactions')
    .insert([{
      kind: 'incoming',
      amount: Number(amount),
      source_or_merchant: 'Bank Transfer — Salary',
      note: 'Paycheck',
      transaction_date: time
    }]);

  if (error) throw error;
  return new NextResponse('Success', { status: 200 });
}

async function handleReversal(message, time) {
  const amount = parseEgp(message);
  if (!amount) return new NextResponse('Could not parse reversal', { status: 400 });

  // Find exact match
  const { data: matches } = await supabase
    .from('transactions')
    .select('*')
    .eq('kind', 'outgoing')
    .eq('amount', amount)
    .order('transaction_date', { ascending: false })
    .limit(1);

  if (matches && matches.length > 0) {
    const match = matches[0];
    const newNote = 'REVERSED' + (match.note ? ' | ' + match.note : '');
    await supabase
      .from('transactions')
      .update({ note: newNote })
      .eq('id', match.id);
  }

  return await logIncome(message, time, 'Reversal/Refund', matches && matches.length > 0 ? 'Original matched' : '');
}

function parseEgp(t) {
  const match = String(t).match(/EGP\s+([\d,.]+)/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function detectOutgoingSource(message) {
  if (/IPN transfer sent/i.test(message)) return 'Instapay Transfer';
  if (/Debit\s+Card/i.test(message)) return 'Debit Card';
  if (/Credit\s+Card/i.test(message)) return 'Credit Card';
  return 'Outgoing Expense';
}
