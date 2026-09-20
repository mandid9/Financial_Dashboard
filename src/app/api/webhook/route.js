import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { sendPushToAll, evaluateAndDispatchTriggers } from '@/lib/push';
import { getAuthenticatedUser } from '@/lib/auth';

// In-memory concurrency locks and dedup cache to eliminate sub-second race conditions
const inFlightLocks = new Set();
const recentDedupCache = new Map();

function pruneDedupCache() {
  const cutoff = Date.now() - 60000;
  for (const [k, ts] of recentDedupCache.entries()) {
    if (ts < cutoff) recentDedupCache.delete(k);
  }
}

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

  // 3. Fallback to global WEBHOOK_SECRET: Only allowed if WEBHOOK_DEFAULT_USER_ID is set
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && secretsMatch(getProvidedSecret(req), expectedSecret)) {
    const targetUserId = process.env.WEBHOOK_DEFAULT_USER_ID;
    if (targetUserId) {
      return { authorized: true, userId: targetUserId };
    }
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
    let sender = '';
    let idempotencyKey = null;
    let directAmount = null;
    let directMerchant = null;
    let directKind = null;
    let directNote = null;

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
        if (json.sender) sender = String(json.sender).slice(0, 160);
        if (json.idempotency_key) {
          idempotencyKey = String(json.idempotency_key).slice(0, 160);
        }
        if (json.amount && Number(json.amount) > 0) {
          directAmount = Number(json.amount);
          directMerchant = json.merchant || 'Bank Transaction';
          directKind = json.kind === 'incoming' ? 'incoming' : 'outgoing';
          directNote = json.note || 'Bank SMS';
        }
      }
    } catch (e) {
      if (rawBody.startsWith('body=') || rawBody.startsWith('message=')) {
        const params = new URLSearchParams(rawBody);
        body = params.get('body') || params.get('message') || rawBody;
        if (params.get('action') === 'queue_pending') isPendingQueue = true;
      }
    }

    // Determine accurate transaction timestamp
    let txDate = new Date().toISOString();
    try {
      const parsedJson = JSON.parse(rawBody);
      if (parsedJson?.timestamp) {
        const parsedTs = Number(parsedJson.timestamp);
        if (!isNaN(parsedTs) && parsedTs > 1000000000000) {
          txDate = new Date(parsedTs).toISOString();
        } else {
          const d = new Date(parsedJson.timestamp);
          if (!isNaN(d.getTime())) txDate = d.toISOString();
        }
      }
    } catch (e) {}

    // Fast in-memory deduplication check (catches sub-second duplicate webhook posts)
    const dedupFingerprint = idempotencyKey 
      ? `idemp_${userId}_${idempotencyKey}`
      : `fp_${userId}_${directAmount || 'raw'}_${directKind || 'any'}_${Math.round(new Date(txDate).getTime() / 15000)}`;

    pruneDedupCache();
    if (recentDedupCache.has(dedupFingerprint)) {
      console.log(`[Webhook] Duplicate ignored by memory cache: ${dedupFingerprint}`);
      return new NextResponse('Duplicate ignored (cache)', { status: 200 });
    }
    if (inFlightLocks.has(dedupFingerprint)) {
      console.log(`[Webhook] Duplicate ignored by in-flight lock: ${dedupFingerprint}`);
      return new NextResponse('Duplicate in-flight ignored', { status: 200 });
    }
    inFlightLocks.add(dedupFingerprint);

    try {
      // Reject Promotional, Carrier Airtime/Call Tone, Balance Inquiry, and OTP SMS
      const isPromo = /عرض خاص|اشحن|احصل على|خصم يصل|لفترة محدودة|كود الخصم|مبروك|وفر مع|استمتع بـ|استمتع بخصم|اشترك الآن|اشترك الان|شحنتك|كول تون|رنة المتصل|رنتلي|تجديد رنة|رصيدك الحالي|رصيدك المتاح|متبقي من باقتك|رصيد محفظتك|كود التأكيد|رمز التحقق|رمز الأمان|لا تشارك|استبدل نقاطك|صندوق الهدايا|كاش باك|على النوتة|سلفة|فليكسات|فليكس 80|فليكس 70|فليكس 100|فليكس 200|promo|offer|discount up to|special offer|recharge now|win up to|subscribe now|voucher code|coupon|get free|valid until|call tone|current.*balance|balance is|available balance|otp[:\s]|verification code|one-time password|reward points/i.test(body);
      if (isPromo) {
        return new NextResponse('Ignored: Promotional/Carrier message detected', { status: 200 });
      }

      // 0. If already parsed by Android Companion App, insert directly with deduplication!
      if (directAmount && directAmount > 0) {
        if (directKind === 'incoming') {
          // 1. Idempotency key check
          if (idempotencyKey) {
            const { data: idempExists } = await supabase
              .from('transactions')
              .select('id')
              .eq('user_id', userId)
              .ilike('note', `%idempotency:${idempotencyKey}%`)
              .limit(1);
            if (idempExists && idempExists.length > 0) {
              console.log(`[Webhook] Duplicate incoming ignored by idempotency_key: ${idempotencyKey}`);
              recentDedupCache.set(dedupFingerprint, Date.now());
              return new NextResponse('Duplicate incoming ignored (idempotency)', { status: 200 });
            }
          }

          // 2. Short window check
          const txTimeMs = new Date(txDate).getTime();
          const win = 5 * 60 * 1000;
          const minDate = new Date(txTimeMs - win).toISOString();
          const maxDate = new Date(txTimeMs + win).toISOString();

          let duplicateQuery = supabase
            .from('transactions')
            .select('id')
            .eq('kind', 'incoming')
            .eq('user_id', userId)
            .eq('amount', Number(directAmount))
            .eq('source_or_merchant', String(directMerchant))
            .gte('transaction_date', minDate)
            .lte('transaction_date', maxDate);

          const { data: existingInc } = await duplicateQuery.limit(1);

          if (existingInc && existingInc.length > 0) {
            console.log(`[Webhook] Duplicate incoming ignored: ${directAmount} EGP on ${txDate}`);
            recentDedupCache.set(dedupFingerprint, Date.now());
            return new NextResponse('Duplicate incoming ignored', { status: 200 });
          }

          const fullNote = idempotencyKey 
            ? (directNote ? `idempotency:${idempotencyKey} | ${directNote}` : `idempotency:${idempotencyKey}`)
            : directNote;

          const { error } = await supabase
            .from('transactions')
            .insert([{
              user_id: userId,
              kind: 'incoming',
              amount: directAmount,
              source_or_merchant: directMerchant,
              note: fullNote,
              transaction_date: txDate
            }]);
          if (error) throw error;

          // 3. Post-insert self-healing collision check
          try {
            const { data: collisions } = await supabase
              .from('transactions')
              .select('id, created_at')
              .eq('user_id', userId)
              .eq('kind', 'incoming')
              .eq('amount', Number(directAmount))
              .eq('source_or_merchant', String(directMerchant))
              .eq('transaction_date', txDate)
              .order('created_at', { ascending: true });

            if (collisions && collisions.length > 1) {
              const duplicateIds = collisions.slice(1).map(c => c.id);
              await supabase.from('transactions').delete().in('id', duplicateIds).eq('user_id', userId);
              console.warn(`[Webhook] Auto-healed incoming collision: removed duplicate IDs ${duplicateIds.join(', ')}`);
            }
          } catch (cleanErr) {
            console.warn('[Webhook] Incoming collision check warning:', cleanErr.message);
          }

          recentDedupCache.set(dedupFingerprint, Date.now());
          await sendPushToAll({
            title: `💰 EGP ${Number(directAmount).toLocaleString()} Income Logged`,
            body: `${directMerchant}`,
            icon: '/icon.svg',
            url: '/index.html'
          }, userId).catch(() => {});
          return new NextResponse('Success: Direct income logged', { status: 200 });
        } else {
          const res = await insertOutgoing(directAmount, directMerchant, directNote, txDate, userId, customCategory, idempotencyKey);
          recentDedupCache.set(dedupFingerprint, Date.now());
          return res;
        }
      }

    // Normalize Eastern Arabic numerals: ٠-٩ -> 0-9
    body = body
      .replace(/٠/g, '0').replace(/١/g, '1').replace(/٢/g, '2')
      .replace(/٣/g, '3').replace(/٤/g, '4').replace(/٥/g, '5')
      .replace(/٦/g, '6').replace(/٧/g, '7').replace(/٨/g, '8')
      .replace(/٩/g, '9').replace(/،/g, ',');

    // Check user-defined custom SMS rules first (Strict sender AND content matching)
    if (userId) {
      const { data: userRules } = await supabase
        .from('user_sms_rules')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true);

      if (userRules && userRules.length > 0) {
        for (const rule of userRules) {
          const contentPattern = (rule.content_pattern || rule.contains_keyword || '').trim().toLowerCase();
          const senderPattern = (rule.sender_pattern || '').trim().toLowerCase();

          if (!senderPattern && !contentPattern) continue;

          let senderMatches = true;
          if (senderPattern) {
            senderMatches = sender ? sender.toLowerCase().includes(senderPattern) : false;
          }

          let contentMatches = true;
          if (contentPattern) {
            contentMatches = body.toLowerCase().includes(contentPattern);
          }

          if (senderMatches && contentMatches) {
            if (rule.catch_mode === 'ignore') {
              return new NextResponse('Ignored by user rule', { status: 200 });
            }

            const amtMatch = body.match(/(?:EGP|LE|L\.E|ج\.م|جنيه|مبلغ)\s*([\d,.]+)/i) ||
                             body.match(/([\d,.]+)\s*(?:EGP|LE|L\.E|ج\.م|جنيه)/i) ||
                             body.match(/amount of\s*([\d,.]+)/i);
            const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : null;
            if (amount && amount > 0) {
              const merchant = rule.merchant_extractor || rule.pattern_name;
              const kind = rule.direction === 'incoming' ? 'incoming' : 'outgoing';
              if (isPendingQueue) {
                return await queuePending(body, amount, merchant, kind, userId, idempotencyKey);
              }
              if (kind === 'incoming') {
                const { error } = await supabase.from('transactions').insert([{
                  user_id: userId,
                  kind: 'incoming',
                  amount: amount,
                  source_or_merchant: merchant,
                  note: rule.pattern_name || 'Custom Rule',
                  transaction_date: txDate
                }]);
                if (error) throw error;
                return new NextResponse('Success: Income logged', { status: 200 });
              }
              return await insertOutgoing(amount, merchant, rule.pattern_name, txDate, userId, rule.default_category_id);
            }
          }
        }
      }
    }

    // 1. Salary Deposit (Arabic & English)
    if (/اضافة راتبك|إضافة راتبك|تم ايداع الراتب|مرتب|Salary|payroll/i.test(body)) {
      if (isPendingQueue) {
        const amtMatch = body.match(/(?:بمبلغ|مبلغ)?\s*([\d,.]+)\s*(?:EGP|LE|L\.E|ج\.م|جنيه)/i);
        const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
        return await queuePending(body, amount, 'Bank Transfer — Salary', 'incoming', userId, idempotencyKey);
      }
      return await handleSalarySms(body, txDate, userId);
    }

      // 2. Instapay Transfer Sent (Outgoing Expense)
      if (/IPN transfer sent|تحويل عبر انستاباي/i.test(body)) {
        const amtMatch = body.match(/(?:amount of\s*)?(?:EGP|LE|ج\.م|جنيه)?\s*([\d,.]+)\s*(?:EGP|LE|ج\.م|جنيه)?/i);
        const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
        const fromMatch = body.match(/(?:from|to|إلى)\s+([^\s,]+)/i);
        const source = `Instapay Sent${fromMatch ? ` (${fromMatch[1]})` : ''}`;
        if (isPendingQueue) return await queuePending(body, amount, source, 'outgoing', userId, idempotencyKey);
        const res = await handleInstapaySent(body, txDate, userId, customCategory, idempotencyKey);
        recentDedupCache.set(dedupFingerprint, Date.now());
        return res;
      }

      // 3. Instapay Transfer Received (Incoming Income)
      if (/IPN transfer re(ceived|cieved)|استلام تحويل.*انستاباي/i.test(body)) {
        const amtMatch = body.match(/(?:amount of\s*)?(?:EGP|LE|ج\.م|جنيه)?\s*([\d,.]+)\s*(?:EGP|LE|ج\.م|جنيه)?/i);
        const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
        const fromMatch = body.match(/(?:from|من)\s+([^\s,]+)/i);
        const source = `Instapay Received${fromMatch ? ` from ${fromMatch[1]}` : ''}`;
        if (isPendingQueue) return await queuePending(body, amount, source, 'incoming', userId, idempotencyKey);
        const res = await handleInstapayReceived(body, txDate, userId);
        recentDedupCache.set(dedupFingerprint, Date.now());
        return res;
      }

      // 4. Card Purchases (NBE, CIB, Banque Misr, QNB, etc.)
      if (/Your (?:Debit|Credit) Card|تم (?:تنفيذ |إجراء )?حركة|مشتريات|حركة شراء|حركة خصم|تمت معاملة|Purchase (?:of|transaction)|Card (?:ending|used)/i.test(body)) {
        const amtMatch = body.match(/(?:EGP|LE|L\.E|ج\.م|جنيه|مبلغ|بمبلغ)\s*([\d,.]+)/i) ||
                         body.match(/([\d,.]+)\s*(?:EGP|LE|L\.E|ج\.م|جنيه)/i) ||
                         body.match(/transaction of\s*(?:EGP|LE)?\s*([\d,.]+)/i);
        const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;

        let merchant = 'Bank Card';
        const merchMatch = body.match(/@([^,.\n]+)/) || body.match(/(?:at|لدى|عند)\s+([^,.\n]+)/i);
        if (merchMatch) merchant = merchMatch[1].trim();

        if (amount > 0) {
          if (isPendingQueue) return await queuePending(body, amount, merchant, 'outgoing', userId, idempotencyKey);
          const res = await insertOutgoing(amount, merchant, 'Card Purchase', txDate, userId, customCategory, idempotencyKey);
          recentDedupCache.set(dedupFingerprint, Date.now());
          return res;
        }
      }

      // 5. Mobile Wallets (Vodafone Cash, Etisalat, Orange, WE Pay)
      if (/Vodafone Cash|فودافون كاش|اورنچ كاش|اتصالات كاش|وي باي|تم (?:تحويل|دفع|استلام|خصم) مبلغ/i.test(body)) {
        const amtMatch = body.match(/(?:مبلغ|بمبلغ|EGP|LE|ج\.م)\s*([\d,.]+)/i) || body.match(/([\d,.]+)\s*(?:ج\.م|EGP|LE)/i);
        const amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
        const isIncoming = /استلام|إيداع|received|deposit/i.test(body);
        const merchant = isIncoming ? 'Wallet Received' : 'Wallet Payment';
        if (amount > 0) {
          if (isIncoming) {
            const { error } = await supabase.from('transactions').insert([{
              user_id: userId,
              kind: 'incoming',
              amount: amount,
              source_or_merchant: merchant,
              note: idempotencyKey ? `idempotency:${idempotencyKey} | Mobile Wallet` : 'Mobile Wallet',
              transaction_date: txDate
            }]);
            if (error) throw error;
            recentDedupCache.set(dedupFingerprint, Date.now());
            return new NextResponse('Success: Wallet incoming logged', { status: 200 });
          }
          const res = await insertOutgoing(amount, merchant, 'Mobile Wallet', txDate, userId, customCategory, idempotencyKey);
          recentDedupCache.set(dedupFingerprint, Date.now());
          return res;
        }
      }

      // 6. Reversals / Refunds
      if (/Reversed|Refunded|استرجاع|رد مبلغ/i.test(body)) {
        const res = await handleReversal(body, txDate, userId);
        recentDedupCache.set(dedupFingerprint, Date.now());
        return res;
      }

      // 7. Universal Smart Fallback (Any message with an amount & financial keyword)
      const genericMatch = body.match(/(?:EGP|LE|L\.E|ج\.م|جنيه|مبلغ|بمبلغ)\s*([\d,.]+)/i) ||
                           body.match(/([\d,.]+)\s*(?:EGP|LE|L\.E|ج\.م|جنيه)/i);
      if (genericMatch) {
        const amount = parseFloat(genericMatch[1].replace(/,/g, ''));
        const isFinancial = /purchase|payment|spent|transfer|debit|credit|pos|atm|cash|withdraw|invoice|order|paid|bill|wallet|card|خصم|شراء|مشتريات|سحب|دفع|تحويل|بطاقة|كارت|فاتورة|محفظة|معاملة|حركة/i.test(body);

        if (amount > 0 && isFinancial) {
          const isIncoming = /received|deposit|salary|refund|reversed|cashback|ايداع|إيداع|استلام|اضافة|إضافة|راتب|مرتب|استرجاع|وارد/i.test(body);
          let merchant = 'Bank Transaction';
          const merchMatch = body.match(/@([^,.\n]+)/) || body.match(/(?:at|لدى|عند|إلى|to)\s+([^,.\n]+)/i);
          if (merchMatch) merchant = merchMatch[1].trim();

          if (isIncoming) {
            const { error } = await supabase.from('transactions').insert([{
              user_id: userId,
              kind: 'incoming',
              amount: amount,
              source_or_merchant: merchant,
              note: idempotencyKey ? `idempotency:${idempotencyKey} | Bank SMS` : 'Bank SMS',
              transaction_date: txDate
            }]);
            if (error) throw error;
            recentDedupCache.set(dedupFingerprint, Date.now());
            return new NextResponse('Success: Fallback incoming logged', { status: 200 });
          }
          const res = await insertOutgoing(amount, merchant, 'Bank SMS', txDate, userId, customCategory, idempotencyKey);
          recentDedupCache.set(dedupFingerprint, Date.now());
          return res;
        }
      }

      // Strictly ignore all other non-financial messages
      return new NextResponse('Ignored: No pattern matched', { status: 200 });
    } finally {
      inFlightLocks.delete(dedupFingerprint);
    }
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

async function handleInstapaySent(message, time, userId, customCategory, idempotencyKey = null) {
  const amtMatch = message.match(/amount of EGP\s*([\d,.]+)/i) || message.match(/EGP\s*([\d,.]+)/i);
  if (!amtMatch) return new NextResponse('Could not parse Instapay sent amount', { status: 400 });
  const amount = parseFloat(amtMatch[1].replace(/,/g, ''));

  const fromMatch = message.match(/from\s+([^\s]+)/i);
  const fromAcc = fromMatch ? ` (${fromMatch[1]})` : '';
  const source = `Instapay Sent${fromAcc}`;

  return await insertOutgoing(amount, source, null, time, userId, customCategory, idempotencyKey);
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

async function insertOutgoing(amount, sourceOrMerchant, note, time, userId, categoryId = null, idempotencyKey = null) {
  // 1. Check idempotency key if provided
  if (idempotencyKey && userId) {
    const { data: idempDups } = await supabase
      .from('transactions')
      .select('id')
      .eq('user_id', userId)
      .ilike('note', `%idempotency:${idempotencyKey}%`)
      .limit(1);

    if (idempDups && idempDups.length > 0) {
      console.log(`[Webhook] Duplicate outgoing ignored (idempotency: ${idempotencyKey})`);
      return new NextResponse('Duplicate ignored (idempotency)', { status: 200 });
    }
  }

  // 2. Short amount/source/time window fallback check
  const txTimeMs = new Date(time).getTime();
  const win = 5 * 60 * 1000;
  const minDate = new Date(txTimeMs - win).toISOString();
  const maxDate = new Date(txTimeMs + win).toISOString();

  let query = supabase
    .from('transactions')
    .select('id, amount, transaction_date')
    .eq('kind', 'outgoing')
    .eq('amount', Number(amount))
    .eq('source_or_merchant', sourceOrMerchant)
    .gte('transaction_date', minDate)
    .lte('transaction_date', maxDate);

  if (userId) query = query.eq('user_id', userId);
  const { data: existingDups } = await query.limit(1);

  if (existingDups && existingDups.length > 0) {
    console.log(`[Webhook] Duplicate outgoing ignored: ${amount} EGP on ${time}`);
    return new NextResponse('Duplicate ignored', { status: 200 });
  }

  const fullNote = idempotencyKey
    ? (note ? `idempotency:${idempotencyKey} | ${note}` : `idempotency:${idempotencyKey}`)
    : note;

  const { error } = await supabase
    .from('transactions')
    .insert([{
      user_id: userId,
      kind: 'outgoing',
      amount: amount,
      category_id: categoryId,
      source_or_merchant: sourceOrMerchant,
      note: fullNote,
      transaction_date: time
    }]);

  if (error) throw error;

  // 3. Post-insert self-healing collision check (mitigates concurrent serverless lambda instances)
  try {
    let collisionQuery = supabase
      .from('transactions')
      .select('id, created_at')
      .eq('kind', 'outgoing')
      .eq('amount', Number(amount))
      .eq('source_or_merchant', sourceOrMerchant)
      .eq('transaction_date', time)
      .order('created_at', { ascending: true });

    if (userId) collisionQuery = collisionQuery.eq('user_id', userId);
    const { data: collisions } = await collisionQuery;

    if (collisions && collisions.length > 1) {
      const duplicateIds = collisions.slice(1).map(c => c.id);
      let purgeQuery = supabase.from('transactions').delete().in('id', duplicateIds);
      if (userId) purgeQuery = purgeQuery.eq('user_id', userId);
      await purgeQuery;
      console.warn(`[Webhook] Auto-healed outgoing collision: removed duplicate IDs ${duplicateIds.join(', ')}`);
    }
  } catch (cleanErr) {
    console.warn('[Webhook] Outgoing collision check warning:', cleanErr.message);
  }

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
