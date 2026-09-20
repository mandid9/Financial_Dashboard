package com.finance.dashboard;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class TransactionBackupStore {
    private static final String TAG = "TxBackupStore";
    private static final String DB_NAME = "finance_transactions.db";
    private static final int DB_VERSION = 2;
    private static final String TABLE = "offline_transactions";
    private static final Object LOCK = new Object();

    private static volatile Helper sHelperInstance;
    private static boolean sMigrated = false;

    private static Helper getHelper(Context context) {
        if (sHelperInstance == null) {
            synchronized (LOCK) {
                if (sHelperInstance == null) {
                    sHelperInstance = new Helper(context.getApplicationContext());
                }
            }
        }
        return sHelperInstance;
    }

    private static final class Helper extends SQLiteOpenHelper {
        Helper(Context context) {
            super(context.getApplicationContext(), DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE " + TABLE + " (" +
                    "id INTEGER PRIMARY KEY, raw_message TEXT NOT NULL, amount REAL NOT NULL, " +
                    "merchant TEXT, kind TEXT NOT NULL, category TEXT, status TEXT NOT NULL, " +
                    "created_at INTEGER NOT NULL, sender TEXT, note TEXT)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_offline_status ON " + TABLE + "(status)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            if (oldVersion < 2) {
                try { db.execSQL("ALTER TABLE " + TABLE + " ADD COLUMN sender TEXT;"); } catch (Exception ignored) {}
                try { db.execSQL("ALTER TABLE " + TABLE + " ADD COLUMN note TEXT;"); } catch (Exception ignored) {}
            }
        }
    }

    private static void ensureMigrated(Context context, SQLiteDatabase db) {
        if (sMigrated) return;
        migrateLegacy(context, db);
        sMigrated = true;
    }

    private static void migrateLegacy(Context context, SQLiteDatabase db) {
        android.content.SharedPreferences prefs = context.getSharedPreferences("finance_tx_backup", Context.MODE_PRIVATE);
        String legacy = prefs.getString("saved_transactions", "");
        if (legacy == null || legacy.isEmpty()) return;
        try {
            JSONArray rows = new JSONArray(legacy);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = rows.getJSONObject(i);
                ContentValues values = new ContentValues();
                values.put("id", row.optLong("id", System.currentTimeMillis() + i));
                values.put("raw_message", row.optString("raw_message", ""));
                values.put("amount", row.optDouble("amount", 0));
                values.put("merchant", row.optString("merchant", ""));
                values.put("kind", row.optString("kind", "outgoing"));
                values.put("category", row.optString("category", ""));
                values.put("status", row.optString("status", "pending"));
                values.put("created_at", row.optLong("created_at", System.currentTimeMillis()));
                db.insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_IGNORE);
            }
            prefs.edit().remove("saved_transactions").apply();
        } catch (Exception error) {
            Log.e(TAG, "Legacy queue migration failed", error);
        }
    }

    public static long saveTransaction(Context context, String rawMessage, double amount, String merchant,
                                       String kind, String category, String status) {
        return saveTransaction(context, rawMessage, amount, merchant, kind, category, status, System.currentTimeMillis(), "", "");
    }

    public static long saveTransaction(Context context, String rawMessage, double amount, String merchant,
                                       String kind, String category, String status, long timestamp) {
        return saveTransaction(context, rawMessage, amount, merchant, kind, category, status, timestamp, "", "");
    }

    public static long saveTransaction(Context context, String rawMessage, double amount, String merchant,
                                       String kind, String category, String status, long timestamp,
                                       String sender, String note) {
        synchronized (LOCK) {
            try {
                Helper helper = getHelper(context);
                SQLiteDatabase db = helper.getWritableDatabase();
                ensureMigrated(context, db);
                long id = timestamp > 0 ? timestamp : System.currentTimeMillis();
                ContentValues values = new ContentValues();
                values.put("id", id);
                values.put("raw_message", rawMessage == null ? "" : rawMessage);
                values.put("amount", amount);
                values.put("merchant", merchant == null ? "" : merchant);
                values.put("kind", kind == null ? "outgoing" : kind);
                values.put("category", category == null ? "" : category);
                values.put("status", status == null ? "pending" : status);
                values.put("created_at", id);
                values.put("sender", sender == null ? "" : sender);
                values.put("note", note == null ? "" : note);
                db.insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE);
                exportBackupToFile(context);
                return id;
            } catch (Exception e) {
                Log.e(TAG, "Failed to save offline transaction", e);
                return -1;
            }
        }
    }

    public static void markSynced(Context context, String rawMessage) {
        markStatus(context, rawMessage, "synced");
    }

    public static void markStatus(Context context, String rawMessage, String status) {
        synchronized (LOCK) {
            try {
                Helper helper = getHelper(context);
                SQLiteDatabase db = helper.getWritableDatabase();
                ensureMigrated(context, db);
                ContentValues values = new ContentValues();
                values.put("status", status);
                db.update(TABLE, values, "raw_message = ?", new String[]{rawMessage});
            } catch (Exception e) {
                Log.e(TAG, "Failed to markStatus", e);
            }
        }
    }

    public static void markStatusById(Context context, long id, String status) {
        if (id < 0) return;
        synchronized (LOCK) {
            try {
                Helper helper = getHelper(context);
                ContentValues values = new ContentValues();
                values.put("status", status);
                helper.getWritableDatabase().update(TABLE, values, "id = ?", new String[]{String.valueOf(id)});
            } catch (Exception e) {
                Log.e(TAG, "Failed to markStatusById: " + id, e);
            }
        }
    }

    public static void exportBackupToFile(Context context) {
        try {
            String json = getSavedTransactionsJson(context);
            java.io.File downloadDir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS);
            if (downloadDir != null && downloadDir.exists()) {
                java.io.File backupFile = new java.io.File(downloadDir, "offline_transactions_backup.json");
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(backupFile)) {
                    fos.write(json.getBytes(StandardCharsets.UTF_8));
                }
            }
            java.io.File appFiles = context.getExternalFilesDir(null);
            if (appFiles != null) {
                java.io.File internalBackup = new java.io.File(appFiles, "offline_transactions_backup.json");
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(internalBackup)) {
                    fos.write(json.getBytes(StandardCharsets.UTF_8));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Export backup to file failed: " + e.getMessage());
        }
    }

    private static final class PendingTx {
        final long id;
        final String message;
        final double amount;
        final String merchant;
        final String kind;
        final String category;
        final long createdAt;
        final String sender;
        final String note;

        PendingTx(long id, String message, double amount, String merchant, String kind,
                  String category, long createdAt, String sender, String note) {
            this.id = id;
            this.message = message;
            this.amount = amount;
            this.merchant = merchant;
            this.kind = kind;
            this.category = category;
            this.createdAt = createdAt;
            this.sender = sender;
            this.note = note;
        }
    }

    public static boolean syncPendingTransactionsSync(Context context) {
        boolean hasRemainingUnsynced = false;
        List<PendingTx> pendingList = new ArrayList<>();

        synchronized (LOCK) {
            Cursor cursor = null;
            try {
                Helper helper = getHelper(context);
                SQLiteDatabase db = helper.getWritableDatabase();
                ensureMigrated(context, db);
                String twoMinutesAgo = String.valueOf(System.currentTimeMillis() - 120000L);
                cursor = db.query(TABLE,
                        null,
                        "status IN (?, ?) OR (status = 'syncing' AND created_at < ?)",
                        new String[]{"pending", "failed", twoMinutesAgo}, null, null,
                        "created_at ASC");
                if (cursor != null) {
                    while (cursor.moveToNext()) {
                        long id = cursor.getLong(cursor.getColumnIndexOrThrow("id"));
                        String message = cursor.getString(cursor.getColumnIndexOrThrow("raw_message"));
                        double amount = cursor.getDouble(cursor.getColumnIndexOrThrow("amount"));
                        String merchant = cursor.getString(cursor.getColumnIndexOrThrow("merchant"));
                        String kind = cursor.getString(cursor.getColumnIndexOrThrow("kind"));
                        String category = cursor.getString(cursor.getColumnIndexOrThrow("category"));
                        long createdAt = cursor.getLong(cursor.getColumnIndexOrThrow("created_at"));
                        int senderIdx = cursor.getColumnIndex("sender");
                        String sender = senderIdx >= 0 ? cursor.getString(senderIdx) : "";
                        int noteIdx = cursor.getColumnIndex("note");
                        String note = noteIdx >= 0 ? cursor.getString(noteIdx) : "";
                        pendingList.add(new PendingTx(id, message, amount, merchant, kind, category, createdAt, sender, note));
                    }
                }
                // Atomically claim these transactions as syncing so no concurrent sync thread touches them
                if (!pendingList.isEmpty()) {
                    ContentValues cv = new ContentValues();
                    cv.put("status", "syncing");
                    for (PendingTx p : pendingList) {
                        db.update(TABLE, cv, "id = ?", new String[]{String.valueOf(p.id)});
                    }
                }
            } catch (Exception error) {
                Log.e(TAG, "Error querying pending transactions", error);
            } finally {
                if (cursor != null) {
                    try { cursor.close(); } catch (Exception ignored) {}
                }
            }
        }

        if (pendingList.isEmpty()) {
            return false;
        }

        try {
            String webhookUrl = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE)
                    .getString("webhook_url", NotificationActionReceiver.DEFAULT_WEBHOOK_URL);
            String webhookToken = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE)
                    .getString("webhook_token", "");

            for (PendingTx tx : pendingList) {
                try {
                    String endpoint = webhookUrl;
                    if (!webhookToken.isEmpty()) {
                        endpoint += (endpoint.contains("?") ? "&" : "?") + "key=" + webhookToken;
                    }
                    URL url = new URL(endpoint);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    if (!webhookToken.isEmpty()) conn.setRequestProperty("x-webhook-token", webhookToken);
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(8000);
                    conn.setDoOutput(true);
                    JSONObject payload = new JSONObject();
                    payload.put("message", tx.message);
                    payload.put("amount", tx.amount);
                    payload.put("merchant", tx.merchant != null && !tx.merchant.isEmpty() ? tx.merchant : "Bank Transaction");
                    payload.put("kind", tx.kind != null && !tx.kind.isEmpty() ? tx.kind : "outgoing");
                    payload.put("note", tx.note != null && !tx.note.isEmpty() ? tx.note : "Bank SMS");
                    payload.put("sender", tx.sender != null ? tx.sender : "");
                    payload.put("idempotency_key", "sms_" + tx.id);
                    payload.put("timestamp", tx.createdAt);
                    if (tx.category != null && !tx.category.isEmpty()) payload.put("category", tx.category);
                    try (OutputStream output = conn.getOutputStream()) {
                        output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                    }
                    int code = conn.getResponseCode();
                    conn.disconnect();
                    if (code >= 200 && code < 300) {
                        markStatusById(context, tx.id, "synced");
                        Log.i(TAG, "Successfully synced pending transaction ID: " + tx.id);
                    } else {
                        markStatusById(context, tx.id, "failed");
                        hasRemainingUnsynced = true;
                        Log.w(TAG, "Sync returned HTTP " + code + " for ID: " + tx.id);
                    }
                } catch (Exception error) {
                    markStatusById(context, tx.id, "failed");
                    hasRemainingUnsynced = true;
                    Log.w(TAG, "Offline transaction retry failed for ID: " + tx.id + ", err: " + error.getMessage());
                }
            }
        } finally {
            exportBackupToFile(context);
        }
        return hasRemainingUnsynced;
    }

    public static void syncPendingTransactions(Context context) {
        new Thread(() -> syncPendingTransactionsSync(context)).start();
    }

    public static String getSavedTransactionsJson(Context context) {
        JSONArray result = new JSONArray();
        synchronized (LOCK) {
            Cursor cursor = null;
            try {
                Helper helper = getHelper(context);
                SQLiteDatabase db = helper.getReadableDatabase();
                ensureMigrated(context, db);
                cursor = db.query(TABLE, null, null, null, null, null, "created_at ASC");
                if (cursor != null) {
                    while (cursor.moveToNext()) {
                        JSONObject tx = new JSONObject();
                        tx.put("id", cursor.getLong(cursor.getColumnIndexOrThrow("id")));
                        tx.put("raw_message", cursor.getString(cursor.getColumnIndexOrThrow("raw_message")));
                        tx.put("amount", cursor.getDouble(cursor.getColumnIndexOrThrow("amount")));
                        tx.put("merchant", cursor.getString(cursor.getColumnIndexOrThrow("merchant")));
                        tx.put("kind", cursor.getString(cursor.getColumnIndexOrThrow("kind")));
                        tx.put("category", cursor.getString(cursor.getColumnIndexOrThrow("category")));
                        tx.put("status", cursor.getString(cursor.getColumnIndexOrThrow("status")));
                        tx.put("created_at", cursor.getLong(cursor.getColumnIndexOrThrow("created_at")));
                        int senderIdx = cursor.getColumnIndex("sender");
                        tx.put("sender", senderIdx >= 0 ? cursor.getString(senderIdx) : "");
                        int noteIdx = cursor.getColumnIndex("note");
                        tx.put("note", noteIdx >= 0 ? cursor.getString(noteIdx) : "");
                        result.put(tx);
                    }
                }
            } catch (Exception error) {
                Log.e(TAG, "Could not read offline transactions", error);
            } finally {
                if (cursor != null) {
                    try { cursor.close(); } catch (Exception ignored) {}
                }
            }
        }
        return result.toString();
    }
}
