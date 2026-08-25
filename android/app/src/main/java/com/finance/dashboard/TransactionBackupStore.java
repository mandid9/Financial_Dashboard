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
                    "merchant TEXT, sender TEXT, kind TEXT NOT NULL, category TEXT, status TEXT NOT NULL, " +
                    "created_at INTEGER NOT NULL)");
            db.execSQL("CREATE INDEX idx_offline_status ON " + TABLE + "(status)");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            if (oldVersion < 2) db.execSQL("ALTER TABLE " + TABLE + " ADD COLUMN sender TEXT");
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
                values.put("sender", row.optString("sender", ""));
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
                                       String kind, String category, String status, String sender) {
        synchronized (LOCK) {
            Helper helper = new Helper(context);
            SQLiteDatabase db = helper.getWritableDatabase();
            migrateLegacy(context, db);
            long id = System.currentTimeMillis();
            ContentValues values = new ContentValues();
            values.put("id", id);
            values.put("raw_message", rawMessage == null ? "" : rawMessage);
            values.put("amount", amount);
            values.put("merchant", merchant == null ? "" : merchant);
            values.put("sender", sender == null ? "" : sender);
            values.put("kind", kind == null ? "outgoing" : kind);
            values.put("category", category == null ? "" : category);
            values.put("status", status == null ? "pending" : status);
            values.put("created_at", id);
            db.insertOrThrow(TABLE, null, values);
            helper.close();
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
        }
    }

    public static void syncPendingTransactions(Context context) {
        new Thread(() -> {
            Helper helper = new Helper(context);
            migrateLegacy(context, helper.getWritableDatabase());
            try {
                String webhookUrl = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE)
                        .getString("webhook_url", NotificationActionReceiver.DEFAULT_WEBHOOK_URL);
                String webhookToken = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE)
                        .getString("webhook_token", "");
                Cursor cursor;
                synchronized (LOCK) {
                    cursor = helper.getReadableDatabase().query(TABLE,
                            new String[]{"id", "raw_message", "category", "sender"},
                            "status IN (?, ?)", new String[]{"pending", "failed"}, null, null,
                            "created_at ASC");
                }
                while (cursor.moveToNext()) {
                    long id = cursor.getLong(0);
                    String message = cursor.getString(1);
                    String category = cursor.getString(2);
                    String sender = cursor.getString(3);
                    try {
                        URL url = new URL(webhookUrl);
                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                        if (!webhookToken.isEmpty()) conn.setRequestProperty("x-webhook-token", webhookToken);
                        conn.setRequestMethod("POST");
                        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                        conn.setConnectTimeout(8000);
                        conn.setReadTimeout(8000);
                        conn.setDoOutput(true);
                        JSONObject payload = new JSONObject();
                        payload.put("message", message);
                        payload.put("idempotency_key", String.valueOf(id));
                        if (category != null && !category.isEmpty()) payload.put("category", category);
                        if (sender != null && !sender.isEmpty()) payload.put("sender", sender);
                        try (OutputStream output = conn.getOutputStream()) {
                            output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                        }
                        int code = conn.getResponseCode();
                        conn.disconnect();
                        markStatusById(context, id, code >= 200 && code < 300 ? "synced" : "failed");
                    } catch (Exception error) {
                        markStatusById(context, id, "failed");
                        Log.w(TAG, "Offline transaction retry failed", error);
                    }
                }
                cursor.close();
            } finally {
                helper.close();
            }
        }).start();
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
                tx.put("sender", cursor.getString(cursor.getColumnIndexOrThrow("sender")));
                tx.put("kind", cursor.getString(cursor.getColumnIndexOrThrow("kind")));
                tx.put("category", cursor.getString(cursor.getColumnIndexOrThrow("category")));
                tx.put("status", cursor.getString(cursor.getColumnIndexOrThrow("status")));
                tx.put("created_at", cursor.getLong(cursor.getColumnIndexOrThrow("created_at")));
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

