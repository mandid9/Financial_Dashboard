package com.finance.dashboard;

import android.app.NotificationManager;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class TimeoutReceiver extends BroadcastReceiver {

    public static void cancel(Context context, int notificationId) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent i = new Intent(context, TimeoutReceiver.class);
        PendingIntent pi = PendingIntent.getBroadcast(context, notificationId, i, PendingIntent.FLAG_NO_CREATE | (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        if (alarms != null && pi != null) alarms.cancel(pi);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        int notificationId = intent.getIntExtra("notification_id", -1);
        long localId = intent.getLongExtra("local_id", -1L);
        if (notificationId != -1) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(notificationId);
        }

        String rawMessage = intent.getStringExtra("raw_message");
        double amount = intent.getDoubleExtra("amount", 0.0);
        String merchant = intent.getStringExtra("merchant");
        String kind = intent.getStringExtra("kind");
        String sender = intent.getStringExtra("sender");

        if (rawMessage != null && !rawMessage.trim().isEmpty()) {
            pushToPendingInbox(context, rawMessage, amount, merchant, kind, localId, sender);
        }
    }

    private void pushToPendingInbox(Context context, String rawMessage, double amount, String merchant, String kind, long localId, String sender) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
                String webhookUrl = prefs.getString("webhook_url", NotificationActionReceiver.DEFAULT_WEBHOOK_URL);
                String webhookToken = prefs.getString("webhook_token", "");

                String endpoint = webhookUrl;
                URL url = new URL(endpoint);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                if (!webhookToken.isEmpty()) {
                    conn.setRequestProperty("x-webhook-token", webhookToken);
                }
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setDoOutput(true);

                JSONObject payload = new JSONObject();
                payload.put("action", "queue_pending");
                payload.put("message", rawMessage);
                payload.put("amount", amount);
                payload.put("merchant", merchant);
                payload.put("kind", kind);
                 if (sender != null && !sender.isEmpty()) payload.put("sender", sender);
                 payload.put("idempotency_key", String.valueOf(localId));
                 payload.put("pending", true);

                byte[] postData = payload.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(postData);
                }

                int responseCode = conn.getResponseCode();
                conn.disconnect();
                if (responseCode >= 200 && responseCode < 300) TransactionBackupStore.markStatusById(context, localId, "queued");
            } catch (Exception ignored) {}
        }).start();
    }
}

