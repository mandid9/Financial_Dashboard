package com.finance.dashboard;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class TransactionBackupStore {

    private static final String PREF_NAME = "finance_tx_backup";
    private static final String KEY_TRANSACTIONS = "saved_transactions";
    private static final String TAG = "TxBackupStore";

    public static void saveTransaction(Context context, String rawMessage, double amount, String merchant, String kind, String category, String status) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            String existingJson = prefs.getString(KEY_TRANSACTIONS, "[]");
            JSONArray arr = new JSONArray(existingJson);

            JSONObject tx = new JSONObject();
            tx.put("id", System.currentTimeMillis());
            tx.put("raw_message", rawMessage);
            tx.put("amount", amount);
            tx.put("merchant", merchant != null ? merchant : "");
            tx.put("kind", kind != null ? kind : "outgoing");
            tx.put("category", category != null ? category : "");
            tx.put("status", status); // "pending", "synced", "failed"
            tx.put("created_at", System.currentTimeMillis());

            arr.put(tx);
            prefs.edit().putString(KEY_TRANSACTIONS, arr.toString()).apply();
            Log.d(TAG, "Transaction saved locally: " + amount + " EGP (" + status + ")");
        } catch (Exception e) {
            Log.e(TAG, "Error saving backup transaction", e);
        }
    }

    public static void markSynced(Context context, String rawMessage) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            String existingJson = prefs.getString(KEY_TRANSACTIONS, "[]");
            JSONArray arr = new JSONArray(existingJson);

            for (int i = 0; i < arr.length(); i++) {
                JSONObject tx = arr.getJSONObject(i);
                if (rawMessage.equals(tx.optString("raw_message"))) {
                    tx.put("status", "synced");
                }
            }
            prefs.edit().putString(KEY_TRANSACTIONS, arr.toString()).apply();
        } catch (Exception e) {
            Log.e(TAG, "Error marking transaction as synced", e);
        }
    }

    public static void syncPendingTransactions(Context context) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
                String existingJson = prefs.getString(KEY_TRANSACTIONS, "[]");
                JSONArray arr = new JSONArray(existingJson);

                SharedPreferences financePrefs = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
                String webhookUrl = financePrefs.getString("webhook_url", NotificationActionReceiver.DEFAULT_WEBHOOK_URL);
                String webhookToken = financePrefs.getString("webhook_token", "");

                String endpoint = webhookUrl;
                if (!webhookToken.isEmpty()) {
                    endpoint += (endpoint.contains("?") ? "&" : "?") + "key=" + webhookToken;
                }

                boolean updated = false;

                for (int i = 0; i < arr.length(); i++) {
                    JSONObject tx = arr.getJSONObject(i);
                    String status = tx.optString("status");
                    if ("pending".equals(status) || "failed".equals(status)) {
                        String msg = tx.optString("raw_message");
                        String cat = tx.optString("category");

                        URL url = new URL(endpoint);
                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                        conn.setRequestMethod("POST");
                        conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                        conn.setConnectTimeout(8000);
                        conn.setReadTimeout(8000);
                        conn.setDoOutput(true);

                        JSONObject payload = new JSONObject();
                        payload.put("message", msg);
                        if (!cat.isEmpty()) payload.put("category", cat);

                        try (OutputStream os = conn.getOutputStream()) {
                            os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                        }

                        int code = conn.getResponseCode();
                        conn.disconnect();

                        if (code >= 200 && code < 300) {
                            tx.put("status", "synced");
                            updated = true;
                            Log.i(TAG, "Successfully synced pending transaction: " + msg);
                        }
                    }
                }

                if (updated) {
                    prefs.edit().putString(KEY_TRANSACTIONS, arr.toString()).apply();
                }
            } catch (Exception e) {
                Log.w(TAG, "Sync pending warning: " + e.getMessage());
            }
        }).start();
    }

    public static String getSavedTransactionsJson(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        return prefs.getString(KEY_TRANSACTIONS, "[]");
    }
}
