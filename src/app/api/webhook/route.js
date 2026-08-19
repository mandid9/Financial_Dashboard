import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { sendPushToAll, evaluateAndDispatchTriggers } from '@/lib/push';

// GET /api/webhook - Quick diagnostic test in browser
export async function GET(req) {
  return new NextResponse('✅ Webhook endpoint is active and ready to receive SMS transactions!', { status: 200 });
}

export async function POST(req) {
  try {
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

    // 1. Salary Deposit (Arabic)
    if (/اضافة راتبك|إضافة راتبك/i.test(body)) {
      return await handleSalarySms(body, now);
    }

    // 2. Instapay Transfer Sent (Outgoing Expense)
    if (/IPN transfer sent/i.test(body)) {
      return await handleInstapaySent(body, now);
    }

    // 3. Instapay Transfer Received (Incoming Income)
    if (/IPN transfer re(ceived|cieved)/i.test(body)) {
      return await handleInstapayReceived(body, now);
    }

    // 4. Debit Card Transaction (Outgoing Expense)
    if (/Your Debit Card/i.test(body)) {
      return await handleDebitCardSms(body, now);
    }

    // 5. Credit Card Transaction (Outgoing Expense / Debt)
    if (/Your Credit Card/i.test(body)) {
      return await handleCreditCardSms(body, now);
    }

    // Optional: Reversals / Refunds
    if (/Reversed|Refunded|استرجاع/i.test(body)) {
      return await handleReversal(body, now);
    }

    // Strictly ignore all other messages (no noise)
    return new NextResponse('Ignored: No pattern matched', { status: 200 });
  } catch (err) {
    console.error('Webhook Error:', err);
    return new NextResponse('Error: ' + err.message, { status: 500 });
  }
}

// Handler 1: Salary
async function handleSalarySms(message, time) {
  // Extract amount after بمبلغ, e.g. "بمبلغ \n 24980EGP"
  const match = message.match(/بمبلغ\s*([\d,.]+)\s*EGP/i) || message.match(/([\d,.]+)\s*EGP/i);
  if (!match) return new NextResponse('Could not parse salary amount', { status: 400 });
  const amount = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) return new NextResponse('Invalid salary amount', { status: 400 });

  const { error } = await supabase
    .from('transactions')
    .insert([{
      kind: 'incoming',
      amount: amount,
      source_or_merchant: 'Bank Transfer \u2014 Salary',
      note: 'Paycheck Deposit',
      transaction_date: time
    }]);

  if (error) throw error;

  await sendPushToAll({
    title: `🎉 Salary Received: EGP ${Number(amount).toLocaleString()}`,
    body: `Paycheck deposited into your account.`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success: Salary logged', { status: 200 });
}

// Handler 2: Instapay Transfer Sent
async function handleInstapaySent(message, time) {
  // "amount of EGP 180.00 from 8472"
  const amtMatch = message.match(/amount of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Instapay sent amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const fromMatch = message.match(/from\s+([^\s]+)/i);
  const fromAcc = fromMatch ? ` (${fromMatch[1]})` : '';
  const source = `Instapay Sent${fromAcc}`;

  return await insertOutgoing(amount, source, null, time);
}

// Handler 3: Instapay Transfer Received
async function handleInstapayReceived(message, time) {
  // "amount of EGP 180.00 from 8472"
  const amtMatch = message.match(/amount of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Instapay received amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const fromMatch = message.match(/from\s+([^\s]+)/i);
  const fromAcc = fromMatch ? ` from ${fromMatch[1]}` : '';
  const source = `Instapay Received${fromAcc}`;

  const { error } = await supabase
    .from('transactions')
    .insert([{
      kind: 'incoming',
      amount: amount,
      source_or_merchant: source,
      note: 'IPN Transfer',
      transaction_date: time
    }]);

  if (error) throw error;

  await sendPushToAll({
    title: `💰 EGP ${Number(amount).toLocaleString()} Income Received`,
    body: `${source}`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success: Instapay income logged', { status: 200 });
}

// Handler 4: Debit Card
async function handleDebitCardSms(message, time) {
  // "Your Debit Card **4739 had a Successful transaction of EGP 79.00 @MOHAMED ABD ELSATTAR ABD"
  const cardMatch = message.match(/Debit Card\s*([^\s]+)/i);
  const cardStr = cardMatch ? `Debit Card ${cardMatch[1]}` : 'Debit Card';

  const amtMatch = message.match(/transaction of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Debit card amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const merchMatch = message.match(/@([^,]+),?/);
  const merchant = merchMatch ? merchMatch[1].trim() : cardStr;

  return await insertOutgoing(amount, merchant, cardStr, time);
}

// Handler 5: Credit Card
async function handleCreditCardSms(message, time) {
  // "Your Credit Card ****9350 had a Successful transaction of EGP 78 @MOHAMED ABD ELSATTAR ABD"
  const cardMatch = message.match(/Credit Card\s*([^\s]+)/i);
  const cardStr = cardMatch ? `Credit Card ${cardMatch[1]}` : 'Credit Card';

  const amtMatch = message.match(/transaction of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Credit card amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const merchMatch = message.match(/@([^,]+),?/);
  const merchant = merchMatch ? merchMatch[1].trim() : cardStr;

  return await insertOutgoing(amount, merchant, cardStr, time);
}

// Helper: Insert Outgoing Expense & Dispatch Alerts
async function insertOutgoing(amount, sourceOrMerchant, note, time) {
  // Duplicate check (within 5 min window)
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
      source_or_merchant: sourceOrMerchant,
      note: note,
      transaction_date: time
    }]);

  if (error) throw error;

  await sendPushToAll({
    title: `💸 EGP ${Number(amount).toLocaleString()} Spent`,
    body: `${sourceOrMerchant} \u2022 Needs category. Tap to review.`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  await evaluateAndDispatchTriggers(false).catch(e => console.warn('Trigger error:', e));

  return new NextResponse('Success: Expense logged', { status: 200 });
}

// Helper: Refund / Reversal
async function handleReversal(message, time) {
  const amtMatch = message.match(/EGP\s*([\d,.]+)/i) || message.match(/([\d,.]+)\s*EGP/i);
  if (!amtMatch) return new NextResponse('Could not parse reversal amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

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

  const { error } = await supabase
    .from('transactions')
    .insert([{
      kind: 'incoming',
      amount: amount,
      source_or_merchant: 'Reversal / Refund',
      note: matches && matches.length > 0 ? 'Original matched' : 'Reversed transaction',
      transaction_date: time
    }]);

  if (error) throw error;

  await sendPushToAll({
    title: `🔄 Refund / Reversal: EGP ${Number(amount).toLocaleString()}`,
    body: `Transaction reversed and credited back.`,
    icon: '/icon.svg',
    url: '/index.html'
  }).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success: Reversal logged', { status: 200 });
}
