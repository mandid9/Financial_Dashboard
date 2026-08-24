package com.finance.dashboard;

import android.app.NotificationManager;
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

    @Override
    public void onReceive(Context context, Intent intent) {
        int notificationId = intent.getIntExtra("notification_id", -1);
        if (notificationId != -1) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(notificationId);
        }

        String rawMessage = intent.getStringExtra("raw_message");
        double amount = intent.getDoubleExtra("amount", 0.0);
        String merchant = intent.getStringExtra("merchant");
        String kind = intent.getStringExtra("kind");

        if (rawMessage != null && !rawMessage.trim().isEmpty()) {
            pushToPendingInbox(context, rawMessage, amount, merchant, kind);
        }
    }

    private void pushToPendingInbox(Context context, String rawMessage, double amount, String merchant, String kind) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
                String webhookUrl = prefs.getString("webhook_url", NotificationActionReceiver.DEFAULT_WEBHOOK_URL);
                String webhookToken = prefs.getString("webhook_token", "");

                String endpoint = webhookUrl;
                if (!webhookToken.isEmpty()) {
                    endpoint += (endpoint.contains("?") ? "&" : "?") + "key=" + webhookToken;
                }

                URL url = new URL(endpoint);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
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

                byte[] postData = payload.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(postData);
                }

                conn.getResponseCode();
                conn.disconnect();
            } catch (Exception ignored) {}
        }).start();
    }
}
