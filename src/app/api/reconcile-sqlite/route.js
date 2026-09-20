import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import fs from 'fs';

export const dynamic = 'force-dynamic';

const SECRET_KEY = 'reconcile_sqlite_2026';

export async function POST(req) {
  return handleReconcile(req, true);
}

export async function GET(req) {
  return handleReconcile(req, false);
}

async function handleReconcile(req, isPost) {
  try {
    const { searchParams } = new URL(req.url);
    const secret = searchParams.get('secret');
    if (secret !== SECRET_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. Read SQLite backup transactions
    let sqliteTxs = [];
    if (isPost) {
      const body = await req.json().catch(() => ({}));
      sqliteTxs = body.sqliteTxs || [];
    }
    
    if (!sqliteTxs || sqliteTxs.length === 0) {
      const backupPath = '/sdcard/Download/offline_transactions_backup.json';
      if (fs.existsSync(backupPath)) {
        try {
          sqliteTxs = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        } catch (e) {
          console.warn('Failed to parse backup file:', e.message);
        }
      }
    }

    // 2. Read all database transactions from Supabase
    const { data: dbTxs, error: dbErr } = await supabase
      .from('transactions')
      .select('id, user_id, kind, amount, source_or_merchant, note, transaction_date, created_at, is_carried_forward, category_id, categories(name)')
      .order('transaction_date', { ascending: false });

    if (dbErr) throw dbErr;

    // 3. Match transactions
    const matched = [];
    const missingInDb = [];
    const matchedDbIds = new Set();

    for (const s of sqliteTxs) {
      const sAmt = Number(s.amount) || 0;
      const sTime = Number(s.created_at || s.id || 0);
      const sMerchant = (s.merchant || '').toLowerCase();
      const sKind = (s.kind || 'outgoing').toLowerCase();

      // Find best match in DB
      let bestMatch = null;
      for (const d of dbTxs || []) {
        const dAmt = Number(d.amount) || 0;
        if (Math.abs(dAmt - sAmt) < 0.01) {
          const dTime = new Date(d.transaction_date).getTime();
          const timeDiffMs = Math.abs(dTime - sTime);
          // Match within 48-hour window
          if (timeDiffMs < 48 * 3600 * 1000) {
            if (!matchedDbIds.has(d.id)) {
              bestMatch = { dbTx: d, timeDiffHours: Number((timeDiffMs / (3600 * 1000)).toFixed(1)) };
              break;
            }
          }
        }
      }

      if (bestMatch) {
        matchedDbIds.add(bestMatch.dbTx.id);
        matched.push({
          sqlite: {
            id: s.id,
            amount: sAmt,
            merchant: s.merchant,
            kind: s.kind,
            status: s.status,
            created_at: new Date(sTime).toISOString(),
            raw_message: (s.raw_message || '').slice(0, 100)
          },
          matchedDb: {
            id: bestMatch.dbTx.id,
            amount: Number(bestMatch.dbTx.amount),
            source: bestMatch.dbTx.source_or_merchant,
            kind: bestMatch.dbTx.kind,
            date: bestMatch.dbTx.transaction_date,
            created_at: bestMatch.dbTx.created_at,
            note: bestMatch.dbTx.note,
            category: bestMatch.dbTx.categories?.name || 'Uncategorized',
            timeDiffHours: bestMatch.timeDiffHours
          }
        });
      } else {
        missingInDb.push({
          id: s.id,
          amount: sAmt,
          merchant: s.merchant,
          kind: s.kind,
          status: s.status,
          created_at: new Date(sTime).toISOString(),
          raw_message: s.raw_message || ''
        });
      }
    }

    // DB transactions not matched in SQLite
    const dbOnly = (dbTxs || [])
      .filter(d => !matchedDbIds.has(d.id))
      .map(d => ({
        id: d.id,
        amount: Number(d.amount),
        source: d.source_or_merchant,
        kind: d.kind,
        date: d.transaction_date,
        created_at: d.created_at,
        note: d.note,
        category: d.categories?.name || 'Uncategorized'
      }));

    return NextResponse.json({
      success: true,
      summary: {
        totalSqlite: sqliteTxs.length,
        totalDb: dbTxs?.length || 0,
        matchedCount: matched.length,
        missingInDbCount: missingInDb.length,
        dbOnlyCount: dbOnly.length
      },
      matched,
      missingInDb,
      dbOnly
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
