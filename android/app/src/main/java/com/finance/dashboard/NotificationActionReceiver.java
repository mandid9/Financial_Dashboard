package com.finance.dashboard;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class NotificationActionReceiver extends BroadcastReceiver {

    public static final String DEFAULT_WEBHOOK_URL = "https://finance-dashboard-next-two.vercel.app/api/webhook";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        int notificationId = intent.getIntExtra("notification_id", -1);

        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && notificationId != -1) {
            nm.cancel(notificationId);
        }

        if (SmsReceiver.ACTION_DISMISS.equals(action)) {
            return;
        }

        String rawMessage = intent.getStringExtra("raw_message");
        String category = intent.getStringExtra("category");
        double amount = intent.getDoubleExtra("amount", 0.0);

        if (rawMessage != null && !rawMessage.trim().isEmpty()) {
            sendWebhookAsync(context, rawMessage, category, amount);
        }
    }

    private void sendWebhookAsync(Context context, String rawMessage, String category, double amount) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
                String webhookUrl = prefs.getString("webhook_url", DEFAULT_WEBHOOK_URL);
                String webhookToken = prefs.getString("webhook_token", "");

                String endpoint = webhookUrl;
                if (!webhookToken.isEmpty()) {
                    endpoint += (endpoint.contains("?") ? "&" : "?") + "key=" + webhookToken;
                }

                URL url = new URL(endpoint);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("Accept", "application/json");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setDoOutput(true);

                JSONObject payload = new JSONObject();
                payload.put("message", rawMessage);
                if (category != null && !category.isEmpty()) {
                    payload.put("category", category);
                }

                byte[] postData = payload.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(postData);
                }

                int responseCode = conn.getResponseCode();
                conn.disconnect();

                new Handler(Looper.getMainLooper()).post(() -> {
                    if (responseCode >= 200 && responseCode < 300) {
                        String msg = category != null
                                ? "✅ Logged under " + category
                                : "✅ Transaction logged to Dashboard";
                        Toast.makeText(context, msg, Toast.LENGTH_SHORT).show();
                    } else {
                        Toast.makeText(context, "⚠️ Webhook returned status " + responseCode, Toast.LENGTH_SHORT).show();
                    }
                });

            } catch (Exception e) {
                new Handler(Looper.getMainLooper()).post(() -> {
                    Toast.makeText(context, "Error logging: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                });
            }
        }).start();
    }
}
