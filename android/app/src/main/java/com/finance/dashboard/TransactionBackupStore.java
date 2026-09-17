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

public final class TransactionBackupStore {
    private static final String TAG = "TxBackupStore";
    private static final String DB_NAME = "finance_transactions.db";
    private static final int DB_VERSION = 2;
    private static final String TABLE = "offline_transactions";
    private static final Object LOCK = new Object();

    private static final class Helper extends SQLiteOpenHelper {
        Helper(Context context) { super(context.getApplicationContext(), DB_NAME, null, DB_VERSION); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE " + TABLE + " (" +
                    "id INTEGER PRIMARY KEY, raw_message TEXT NOT NULL, amount REAL NOT NULL, " +
                    "merchant TEXT, kind TEXT NOT NULL, category TEXT, status TEXT NOT NULL, " +
                    "created_at INTEGER NOT NULL, sender TEXT, note TEXT)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_offline_status ON " + TABLE + "(status)");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            if (oldVersion < 2) {
                try { db.execSQL("ALTER TABLE " + TABLE + " ADD COLUMN sender TEXT;"); } catch (Exception ignored) {}
                try { db.execSQL("ALTER TABLE " + TABLE + " ADD COLUMN note TEXT;"); } catch (Exception ignored) {}
            }
        }
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
            Helper helper = new Helper(context);
            SQLiteDatabase db = helper.getWritableDatabase();
            migrateLegacy(context, db);
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
            helper.close();
            exportBackupToFile(context);
            return id;
        }
    }

    public static void markSynced(Context context, String rawMessage) {
        markStatus(context, rawMessage, "synced");
    }

    public static void markStatus(Context context, String rawMessage, String status) {
        synchronized (LOCK) {
            Helper helper = new Helper(context);
            SQLiteDatabase db = helper.getWritableDatabase();
            migrateLegacy(context, db);
            ContentValues values = new ContentValues();
            values.put("status", status);
            db.update(TABLE, values, "raw_message = ?", new String[]{rawMessage});
            helper.close();
            exportBackupToFile(context);
        }
    }

    public static void markStatusById(Context context, long id, String status) {
        if (id < 0) return;
        synchronized (LOCK) {
            Helper helper = new Helper(context);
            ContentValues values = new ContentValues();
            values.put("status", status);
            helper.getWritableDatabase().update(TABLE, values, "id = ?", new String[]{String.valueOf(id)});
            helper.close();
            exportBackupToFile(context);
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

    public static boolean syncPendingTransactionsSync(Context context) {
        Helper helper = new Helper(context);
        migrateLegacy(context, helper.getWritableDatabase());
        boolean hasRemainingUnsynced = false;
        try {
            String webhookUrl = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE)
                    .getString("webhook_url", NotificationActionReceiver.DEFAULT_WEBHOOK_URL);
            String webhookToken = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE)
                    .getString("webhook_token", "");
            Cursor cursor;
            synchronized (LOCK) {
                cursor = helper.getReadableDatabase().query(TABLE,
                        null,
                        "status IN (?, ?)", new String[]{"pending", "failed"}, null, null,
                        "created_at ASC");
            }
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
                    payload.put("message", message);
                    payload.put("amount", amount);
                    payload.put("merchant", merchant != null && !merchant.isEmpty() ? merchant : "Bank Transaction");
                    payload.put("kind", kind != null && !kind.isEmpty() ? kind : "outgoing");
                    payload.put("note", note != null && !note.isEmpty() ? note : "Bank SMS");
                    payload.put("sender", sender != null ? sender : "");
                    payload.put("idempotency_key", "sms_" + id);
                    payload.put("timestamp", createdAt);
                    if (category != null && !category.isEmpty()) payload.put("category", category);
                    try (OutputStream output = conn.getOutputStream()) {
                        output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                    }
                    int code = conn.getResponseCode();
                    conn.disconnect();
                    if (code >= 200 && code < 300) {
                        markStatusById(context, id, "synced");
                        Log.i(TAG, "Successfully synced pending transaction ID: " + id);
                    } else {
                        markStatusById(context, id, "failed");
                        hasRemainingUnsynced = true;
                        Log.w(TAG, "Sync returned HTTP " + code + " for ID: " + id);
                    }
                } catch (Exception error) {
                    markStatusById(context, id, "failed");
                    hasRemainingUnsynced = true;
                    Log.w(TAG, "Offline transaction retry failed for ID: " + id + ", err: " + error.getMessage());
                }
            }
            cursor.close();
        } finally {
            helper.close();
            exportBackupToFile(context);
        }
        return hasRemainingUnsynced;
    }

    public static void syncPendingTransactions(Context context) {
        new Thread(() -> syncPendingTransactionsSync(context)).start();
    }

    public static String getSavedTransactionsJson(Context context) {
        JSONArray result = new JSONArray();
        Helper helper = new Helper(context);
        migrateLegacy(context, helper.getWritableDatabase());
        Cursor cursor = helper.getReadableDatabase().query(TABLE, null, null, null, null, null, "created_at ASC");
        try {
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
        } catch (Exception error) {
            Log.e(TAG, "Could not read offline transactions", error);
        } finally {
            cursor.close();
            helper.close();
        }
        return result.toString();
    }
}

