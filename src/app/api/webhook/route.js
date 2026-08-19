import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { sendPushToAll, evaluateAndDispatchTriggers } from '@/lib/push';

// GET /api/webhook - Quick diagnostic test in browser
export async function GET(req) {
  const rawExpected = process.env.WEBHOOK_SECRET;
  const cleanExpected = rawExpected ? rawExpected.trim().replace(/^["']|["']$/g, '') : '';
  
  if (cleanExpected) {
    const url = new URL(req.url);
    const rawQuery = url.searchParams.get('secret') || '';
    const cleanQuery = rawQuery.trim().replace(/^["']|["']$/g, '');
    const decodedQuery = decodeURIComponent(rawQuery).trim().replace(/^["']|["']$/g, '');

    const matches = cleanQuery === cleanExpected || 
                    decodedQuery === cleanExpected || 
                    cleanQuery.toLowerCase() === cleanExpected.toLowerCase() ||
                    decodedQuery.toLowerCase() === cleanExpected.toLowerCase();

    if (!matches) {
      return new NextResponse('❌ Unauthorized: Secret mismatch. The secret in URL does not match WEBHOOK_SECRET.', { status: 401 });
    }
  }

  return new NextResponse('✅ Webhook endpoint is active and ready to receive SMS transactions!', { status: 200 });
}

export async function POST(req) {
  try {
    // 1. Optional Secret Verification (MacroDroid compatible)
    const rawExpected = process.env.WEBHOOK_SECRET;
    const cleanExpected = rawExpected ? rawExpected.trim().replace(/^["']|["']$/g, '') : '';
    
    if (cleanExpected) {
      const url = new URL(req.url);
      const rawQuery = url.searchParams.get('secret') || '';
      const cleanQuery = rawQuery.trim().replace(/^["']|["']$/g, '');
      const decodedQuery = decodeURIComponent(rawQuery).trim().replace(/^["']|["']$/g, '');
      
      const rawHeader = req.headers.get('x-webhook-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
      const cleanHeader = rawHeader.trim().replace(/^["']|["']$/g, '');

      const matches = cleanQuery === cleanExpected || 
                      decodedQuery === cleanExpected || 
                      cleanHeader === cleanExpected ||
                      cleanQuery.toLowerCase() === cleanExpected.toLowerCase() ||
                      decodedQuery.toLowerCase() === cleanExpected.toLowerCase() ||
                      cleanHeader.toLowerCase() === cleanExpected.toLowerCase();

      if (!matches) {
        console.warn('Webhook Unauthorized attempt: secret mismatch');
        return new NextResponse('Unauthorized: Secret mismatch', { status: 401 });
      }
    }

    // 2. Read and bound body payload
    const rawBody = await req.text();
    if (!rawBody || rawBody.trim() === '') return new NextResponse('No message', { status: 400 });
    if (rawBody.length > 4096) return new NextResponse('Payload too large', { status: 413 });

    // 3. Unwrap JSON or Form data if sent by MacroDroid
    let body = rawBody;
    try {
      const json = JSON.parse(rawBody);
      if (json && typeof json === 'object') {
        body = json.message || json.body || json.text || json.sms || json.content || rawBody;
      }
    } catch (e) {
      // Not JSON, check if application/x-www-form-urlencoded (e.g. body=... or message=...)
      if (rawBody.startsWith('body=') || rawBody.startsWith('message=')) {
        const params = new URLSearchParams(rawBody);
        body = params.get('body') || params.get('message') || rawBody;
      }
    }

    const now = new Date().toISOString();

    if (/Reversed|Refunded|استرجاع|الغاء/i.test(body)) return await handleReversal(body, now);
    if (/IPN transfer sent|transfer sent|تم تحويل|خصم|شراء|(Debit|Credit)\s+Card|Card ending|Purchase with|POS purchase|Online transaction|بطاقة|سحب/i.test(body)) return await logExpense(body, now);
    if (/IPN transfer re(ceived|cieved)|transfer received|تم استلام|تم استحقاق|تم الايداع|إيداع/i.test(body)) return await logIncome(body, now, 'IPN Received', '');
    if (/اضافة راتبك|salary|راتب/i.test(body)) return await logSalary(body, now);

    // Fallback: If amount is present in SMS, log it as an expense rather than dropping it
    const fallbackAmount = parseEgp(body);
    if (fallbackAmount && fallbackAmount > 0) {
      return await logExpense(body, now);
    }

    return new NextResponse('Ignored: No pattern matched', { status: 200 });
  } catch (err) {
    console.error('Webhook Error:', err);
    return new NextResponse('Error: ' + err.message, { status: 500 });
  }
}

async function logExpense(message, time) {
  const amount = parseEgp(message) || 0;
  if (amount <= 0) {
    return new NextResponse('Could not parse amount from expense message', { status: 400 });
  }
  
  const source = detectOutgoingSource(message);
  const merchant = ((message.match(/@([^,]+),/)||[])[1] || (message.match(/(?:at|لدى|عند)\s+([^,.\n]+)/i)||[])[1] || '').trim();

  // Check duplicate (last 10 transactions in 5 mins)
  const { data: recent } = await supabase
    .from('transactions')
    .select('id, amount, transaction_date')
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

  // Instant notification for logged transaction
  await sendPushToAll({
    title: `💸 EGP ${Number(amount).toLocaleString()} Spent`,
    body: `${merchant || source} \u2022 Needs category. Tap to review.`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  // Evaluate budget rules
  await evaluateAndDispatchTriggers(false).catch(e => console.warn('Trigger error:', e));

  return new NextResponse('Success', { status: 200 });
}

async function logIncome(message, time, type, note) {
  const amount = parseEgp(message);
  if (!amount || amount <= 0) return new NextResponse('Could not parse amount', { status: 400 });

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

  await sendPushToAll({
    title: `💰 EGP ${Number(amount).toLocaleString()} Income Received`,
    body: `${type} \u2022 ${note || 'Income logged'}`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success', { status: 200 });
}

async function logSalary(message, time) {
  const amount = parseEgp(message);
  if (!amount || amount <= 0) return new NextResponse('Could not parse salary', { status: 400 });
  
  const { error } = await supabase
    .from('transactions')
    .insert([{
      kind: 'incoming',
      amount: Number(amount),
      source_or_merchant: 'Bank Transfer \u2014 Salary',
      note: 'Paycheck',
      transaction_date: time
    }]);

  if (error) throw error;

  await sendPushToAll({
    title: `🎉 Salary Received: EGP ${Number(amount).toLocaleString()}`,
    body: `Paycheck deposited into your account.`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success', { status: 200 });
}

async function handleReversal(message, time) {
  const amount = parseEgp(message);
  if (!amount || amount <= 0) return new NextResponse('Could not parse reversal', { status: 400 });

  // Find exact match
  const { data: matches } = await supabase
    .from('transactions')
    .select('id, note')
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

  const res = await logIncome(message, time, 'Reversal/Refund', matches && matches.length > 0 ? 'Original matched' : '');

  await sendPushToAll({
    title: `🔄 Refund / Reversal: EGP ${Number(amount).toLocaleString()}`,
    body: `Transaction reversed and credited back.`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  return res;
}

function parseEgp(t) {
  const str = String(t || '');
  let match = str.match(/EGP\s*([\d,.]+)/i);
  if (!match) match = str.match(/([\d,.]+)\s*EGP/i);
  if (!match) match = str.match(/LE\s*([\d,.]+)/i);
  if (!match) match = str.match(/([\d,.]+)\s*LE/i);
  if (!match) match = str.match(/([\d,.]+)\s*(?:ج\.م|جنيه)/);
  if (!match) match = str.match(/(?:مبلغ|قيمة|بمبلغ|بقيمة|amount)\s*:?\s*([\d,.]+)/i);
  
  if (match) {
    const val = parseFloat(match[1].replace(/,/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }
  return null;
}

function detectOutgoingSource(message) {
  if (/IPN transfer sent|Instapay|تحويل/i.test(message)) return 'Instapay Transfer';
  if (/Debit\s+Card|خصم مباشر/i.test(message)) return 'Debit Card';
  if (/Credit\s+Card|ائتمان/i.test(message)) return 'Credit Card';
  return 'Outgoing Expense';
}
