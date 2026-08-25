import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { sendPushToAll, evaluateAndDispatchTriggers } from '@/lib/push';
import { getAuthenticatedUser } from '@/lib/auth';

function getProvidedSecret(req) {
  const authorization = req.headers.get('authorization') || '';
  if (authorization.startsWith('Bearer ')) {
    return authorization.slice(7);
  }
  return req.headers.get('x-webhook-secret') || '';
}

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

async function resolveUserAndAuthorize(req) {
  const url = new URL(req.url);
  const userKey = url.searchParams.get('key') || req.headers.get('x-user-key') || req.headers.get('x-webhook-token');

  // 1. Try user-specific webhook token lookup
  if (userKey) {
    const { data: tokenData, error } = await supabase
      .from('user_webhook_tokens')
      .select('user_id')
      .eq('token', userKey)
      .maybeSingle();

    if (!error && tokenData?.user_id) {
      return { authorized: true, userId: tokenData.user_id };
    }
  }

  // 2. Try session cookies (e.g. from app WebView)
  try {
    const sessionUser = await getAuthenticatedUser(req);
    if (sessionUser?.id) {
      return { authorized: true, userId: sessionUser.id };
    }
  } catch (e) {}

  // 3. Fallback to global WEBHOOK_SECRET (Backward-compatible with existing MacroDroid setup)
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && secretsMatch(getProvidedSecret(req), expectedSecret)) {
    const { data: primaryUser } = await supabase
      .from('user_webhook_tokens')
      .select('user_id')
      .limit(1)
      .maybeSingle();

    return { authorized: true, userId: primaryUser?.user_id || null };
  }

  return { authorized: false, userId: null };
}

// GET /api/webhook - Authenticated diagnostic check
export async function GET(req) {
  const auth = await resolveUserAndAuthorize(req);
  if (!auth.authorized) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  return new NextResponse('✅ Webhook endpoint is active and ready to receive SMS transactions!', { status: 200 });
}

export async function POST(req) {
  try {
    const auth = await resolveUserAndAuthorize(req);
    if (!auth.authorized) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    const userId = auth.userId;

    const rawBody = await req.text();
    if (!rawBody || rawBody.trim() === '') return new NextResponse('No message', { status: 400 });
    if (rawBody.length > 4096) return new NextResponse('Payload too large', { status: 413 });

    let body = rawBody;
    let isPendingQueue = false;
    let customCategory = null;
    let idempotencyKey = null;

    try {
      const json = JSON.parse(rawBody);
      if (json && typeof json === 'object') {
        body = json.message || json.body || json.text || json.sms || json.content || rawBody;
        if (json.action === 'queue_pending' || json.pending === true) {
          isPendingQueue = true;
        }
        if (json.category) {
          customCategory = json.category;
        }
        if (json.idempotency_key) idempotencyKey = String(json.idempotency_key).slice(0, 160);
      }
    } catch (e) {
      if (rawBody.startsWith('body=') || rawBody.startsWith('message=')) {
        const params = new URLSearchParams(rawBody);
        body = params.get('body') || params.get('message') || rawBody;
        if (params.get('action') === 'queue_pending') isPendingQueue = true;
      }
    }

    const now = new Date().toISOString();

    // Check user-defined custom SMS rules first (if available)
    if (userId) {
      const { data: userRules } = await supabase
        .from('user_sms_rules')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true);

      if (userRules && userRules.length > 0) {
        for (const rule of userRules) {
          if (rule.contains_keyword && body.toLowerCase().includes(rule.contains_keyword.toLowerCase())) {
            const amtMatch = body.match(/EGP\s*([\d,.]+)/i) || body.match(/([\d,.]+)\s*EGP/i);
            const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : null;
            if (amount && amount > 0) {
              const merchant = rule.merchant_extractor || rule.pattern_name;
              if (isPendingQueue) {
                return await queuePending(body, amount, merchant, 'outgoing', userId, idempotencyKey);
              }
              return await insertOutgoing(amount, merchant, rule.pattern_name, now, userId, rule.default_category_id);
            }
          }
        }
      }
    }

    // 1. Salary Deposit (Arabic)
    if (/اضافة راتبك|إضافة راتبك/i.test(body)) {
      if (isPendingQueue) {
        const amtMatch = body.match(/بمبلغ\s*([\d,.]+)\s*EGP/i) || body.match(/([\d,.]+)\s*EGP/i);
        const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
        return await queuePending(body, amount, 'Bank Transfer — Salary', 'incoming', userId, idempotencyKey);
      }
      return await handleSalarySms(body, now, userId);
    }

    // 2. Instapay Transfer Sent (Outgoing Expense)
    if (/IPN transfer sent/i.test(body)) {
      const amtMatch = body.match(/amount of EGP\s*([\d,.]+)/i) || body.match(/EGP\s*([\d,.]+)/i);
      const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
      const fromMatch = body.match(/from\s+([^\s]+)/i);
      const source = `Instapay Sent${fromMatch ? ` (${fromMatch[1]})` : ''}`;
      if (isPendingQueue) return await queuePending(body, amount, source, 'outgoing', userId, idempotencyKey);
      return await handleInstapaySent(body, now, userId, customCategory);
    }

    // 3. Instapay Transfer Received (Incoming Income)
    if (/IPN transfer re(ceived|cieved)/i.test(body)) {
      const amtMatch = body.match(/amount of EGP\s*([\d,.]+)/i) || body.match(/EGP\s*([\d,.]+)/i);
      const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
      const fromMatch = body.match(/from\s+([^\s]+)/i);
      const source = `Instapay Received${fromMatch ? ` from ${fromMatch[1]}` : ''}`;
      if (isPendingQueue) return await queuePending(body, amount, source, 'incoming', userId, idempotencyKey);
      return await handleInstapayReceived(body, now, userId);
    }

    // 4. Debit Card Transaction (Outgoing Expense)
    if (/Your Debit Card/i.test(body)) {
      const cardMatch = body.match(/Debit Card\s*([^\s]+)/i);
      const cardStr = cardMatch ? `Debit Card ${cardMatch[1]}` : 'Debit Card';
      const amtMatch = body.match(/transaction of EGP\s*([\d,.]+)/i) || body.match(/EGP\s*([\d,.]+)/i);
      const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
      const merchMatch = body.match(/@([^,]+),?/);
      const merchant = merchMatch ? merchMatch[1].trim() : cardStr;
      if (isPendingQueue) return await queuePending(body, amount, merchant, 'outgoing', userId, idempotencyKey);
      return await handleDebitCardSms(body, now, userId, customCategory);
    }

    // 5. Credit Card Transaction (Outgoing Expense / Debt)
    if (/Your Credit Card/i.test(body)) {
      const cardMatch = body.match(/Credit Card\s*([^\s]+)/i);
      const cardStr = cardMatch ? `Credit Card ${cardMatch[1]}` : 'Credit Card';
      const amtMatch = body.match(/transaction of EGP\s*([\d,.]+)/i) || body.match(/EGP\s*([\d,.]+)/i);
      const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
      const merchMatch = body.match(/@([^,]+),?/);
      const merchant = merchMatch ? merchMatch[1].trim() : cardStr;
      if (isPendingQueue) return await queuePending(body, amount, merchant, 'outgoing', userId, idempotencyKey);
      return await handleCreditCardSms(body, now, userId, customCategory);
    }

    // 6. Reversals / Refunds
    if (/Reversed|Refunded|استرجاع/i.test(body)) {
      return await handleReversal(body, now, userId);
    }

    // Strictly ignore all other messages (no noise)
    return new NextResponse('Ignored: No pattern matched', { status: 200 });
  } catch (err) {
    console.error('Webhook Error:', err);
    return new NextResponse('Error: ' + err.message, { status: 500 });
  }
}

async function queuePending(rawMessage, amount, sourceOrMerchant, kind, userId, idempotencyKey = null) {
  let existingQuery = supabase.from("pending_sms").select("id").eq("user_id", userId).eq("status", "pending");
  existingQuery = idempotencyKey ? existingQuery.eq("idempotency_key", idempotencyKey) : existingQuery.eq("raw_message", rawMessage);
  const { data: existing } = await existingQuery.limit(1);
  if (existing && existing.length > 0) return new NextResponse("Already queued", { status: 200 });
  const { error } = await supabase
    .from('pending_sms')
    .insert([{
      user_id: userId,
      raw_message: rawMessage,
      amount: amount || 0,
      source_or_merchant: sourceOrMerchant || 'Pending Transaction',
      detected_kind: kind || 'outgoing',
      status: 'pending',
       idempotency_key: idempotencyKey
    }]);

  if (error) throw error;
  return new NextResponse('Success: Saved to pending queue', { status: 200 });
}

async function handleSalarySms(message, time, userId) {
  const match = message.match(/بمبلغ\s*([\d,.]+)\s*EGP/i) || message.match(/([\d,.]+)\s*EGP/i);
  if (!match) return new NextResponse('Could not parse salary amount', { status: 400 });
  const amount = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) return new NextResponse('Invalid salary amount', { status: 400 });

  const { error } = await supabase
    .from('transactions')
    .insert([{
      user_id: userId,
      kind: 'incoming',
      amount: amount,
      source_or_merchant: 'Bank Transfer — Salary',
      note: 'Paycheck Deposit',
      transaction_date: time
    }]);

  if (error) throw error;

  await sendPushToAll({
    title: `🎉 Salary Received: EGP ${Number(amount).toLocaleString()}`,
    body: `Paycheck deposited into your account.`,
    icon: '/icon.svg',
    url: '/index.html'
  }, userId).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success: Salary logged', { status: 200 });
}

async function handleInstapaySent(message, time, userId, customCategory) {
  const amtMatch = message.match(/amount of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Instapay sent amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const fromMatch = message.match(/from\s+([^\s]+)/i);
  const fromAcc = fromMatch ? ` (${fromMatch[1]})` : '';
  const source = `Instapay Sent${fromAcc}`;

  return await insertOutgoing(amount, source, null, time, userId, customCategory);
}

async function handleInstapayReceived(message, time, userId) {
  const amtMatch = message.match(/amount of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Instapay received amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const fromMatch = message.match(/from\s+([^\s]+)/i);
  const fromAcc = fromMatch ? ` from ${fromMatch[1]}` : '';
  const source = `Instapay Received${fromAcc}`;

  const { error } = await supabase
    .from('transactions')
    .insert([{
      user_id: userId,
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
  }, userId).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success: Instapay income logged', { status: 200 });
}

async function handleDebitCardSms(message, time, userId, customCategory) {
  const cardMatch = message.match(/Debit Card\s*([^\s]+)/i);
  const cardStr = cardMatch ? `Debit Card ${cardMatch[1]}` : 'Debit Card';

  const amtMatch = message.match(/transaction of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Debit card amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const merchMatch = message.match(/@([^,]+),?/);
  const merchant = merchMatch ? merchMatch[1].trim() : cardStr;

  return await insertOutgoing(amount, merchant, cardStr, time, userId, customCategory);
}

async function handleCreditCardSms(message, time, userId, customCategory) {
  const cardMatch = message.match(/Credit Card\s*([^\s]+)/i);
  const cardStr = cardMatch ? `Credit Card ${cardMatch[1]}` : 'Credit Card';

  const amtMatch = message.match(/transaction of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Credit card amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const merchMatch = message.match(/@([^,]+),?/);
  const merchant = merchMatch ? merchMatch[1].trim() : cardStr;

  return await insertOutgoing(amount, merchant, cardStr, time, userId, customCategory);
}

async function insertOutgoing(amount, sourceOrMerchant, note, time, userId, categoryId = null) {
  // Duplicate check (within 5 min window)
  let query = supabase
    .from('transactions')
    .select('id, amount, transaction_date')
    .eq('kind', 'outgoing')
    .order('created_at', { ascending: false })
    .limit(10);

  if (userId) query = query.eq('user_id', userId);
  const { data: recent } = await query;

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
      user_id: userId,
      kind: 'outgoing',
      amount: amount,
      category_id: categoryId,
      source_or_merchant: sourceOrMerchant,
      note: note,
      transaction_date: time
    }]);

  if (error) throw error;

  await sendPushToAll({
    title: `💸 EGP ${Number(amount).toLocaleString()} Spent`,
    body: `${sourceOrMerchant} • Needs category. Tap to review.`,
    icon: '/icon.svg',
    url: '/index.html'
  }, userId).catch(e => console.warn('Push error:', e));

  await evaluateAndDispatchTriggers(false, userId).catch(e => console.warn('Trigger error:', e));

  return new NextResponse('Success: Expense logged', { status: 200 });
}

async function handleReversal(message, time, userId) {
  const amtMatch = message.match(/EGP\s*([\d,.]+)/i) || message.match(/([\d,.]+)\s*EGP/i);
  if (!amtMatch) return new NextResponse('Could not parse reversal amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  let query = supabase
    .from('transactions')
    .select('id, note')
    .eq('kind', 'outgoing')
    .eq('amount', amount)
    .order('transaction_date', { ascending: false })
    .limit(1);

  if (userId) query = query.eq('user_id', userId);
  const { data: matches } = await query;

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
      user_id: userId,
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
  }, userId).catch(e => console.warn('Push error:', e));

  return new NextResponse('Success: Reversal logged', { status: 200 });
}

