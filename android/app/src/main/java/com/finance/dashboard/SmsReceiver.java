package com.finance.dashboard;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.telephony.SmsMessage;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class SmsReceiver extends BroadcastReceiver {

    public static final String CHANNEL_ID = "financial_alerts";
    private static final String TAG = "FinanceSmsReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;

        Bundle bundle = intent.getExtras();
        if (bundle == null) return;

        Object[] pdus = (Object[]) bundle.get("pdus");
        if (pdus == null || pdus.length == 0) return;

        String format = bundle.getString("format");
        StringBuilder fullMsg = new StringBuilder();
        String sender = "";

        for (Object pdu : pdus) {
            SmsMessage sms;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                sms = SmsMessage.createFromPdu((byte[]) pdu, format);
            } else {
                sms = SmsMessage.createFromPdu((byte[]) pdu);
            }
            if (sms != null) {
                fullMsg.append(sms.getMessageBody());
                sender = sms.getOriginatingAddress();
            }
        }

        String messageBody = fullMsg.toString();
        BankParser.ParsedTransaction tx = BankParser.parse(context, messageBody);

        if (tx.isMatched && tx.amount > 0) {
            // 1. Immediately store in local offline backup queue
            TransactionBackupStore.saveTransaction(context, messageBody, tx.amount, tx.merchant, tx.kind, tx.defaultCategory, "pending");

            // 2. Dispatch background webhook to sync with Dashboard
            sendWebhookBackground(context, tx);

            // 3. Show clean heads-up notification (tap opens Dashboard directly)
            showCleanNotification(context, tx);
        }
    }

    private void showCleanNotification(Context context, BankParser.ParsedTransaction tx) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.channel_name),
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(context.getString(R.string.channel_desc));
            channel.enableVibration(true);
            nm.createNotificationChannel(channel);
        }

        int notificationId = (int) (System.currentTimeMillis() % Integer.MAX_VALUE);
        String formattedAmt = String.format("%.2f", tx.amount);

        // Content intent (Tapping opens the app dashboard directly)
        Intent tapIntent = new Intent(context, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tapPendingIntent = PendingIntent.getActivity(
                context, notificationId, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        String title = "outgoing".equals(tx.kind)
                ? "💸 EGP " + formattedAmt + " Spent @ " + tx.merchant
                : "💰 EGP " + formattedAmt + " Income Received";

        String body = tx.merchant + " • Tap to open Financial Dashboard";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(tapPendingIntent);

        nm.notify(notificationId, builder.build());
    }

    private void sendWebhookBackground(Context context, BankParser.ParsedTransaction tx) {
        new Thread(() -> {
            try {
                SharedPreferences financePrefs = context.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
                String webhookUrl = financePrefs.getString("webhook_url", NotificationActionReceiver.DEFAULT_WEBHOOK_URL);
                String webhookToken = financePrefs.getString("webhook_token", "");

                String endpoint = webhookUrl;
                if (!webhookToken.isEmpty()) {
                    endpoint += (endpoint.contains("?") ? "&" : "?") + "key=" + webhookToken;
                }

                URL url = new URL(endpoint);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setDoOutput(true);

                JSONObject payload = new JSONObject();
                payload.put("message", tx.rawMessage);
                if (tx.defaultCategory != null && !tx.defaultCategory.isEmpty()) {
                    payload.put("category", tx.defaultCategory);
                }

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload.toString().getBytes(StandardCharsets.UTF_8));
                }

                int code = conn.getResponseCode();
                conn.disconnect();

                if (code >= 200 && code < 300) {
                    TransactionBackupStore.markSynced(context, tx.rawMessage);
                    Log.i(TAG, "Transaction synced to dashboard: " + tx.amount + " EGP");
                }
            } catch (Exception e) {
                Log.w(TAG, "Background webhook send error: " + e.getMessage());
            }
        }).start();
    }

    public static void showTestNotification(Context context) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.channel_name),
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(context.getString(R.string.channel_desc));
            channel.enableVibration(true);
            nm.createNotificationChannel(channel);
        }

        int notificationId = 9999;
        Intent tapIntent = new Intent(context, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tapPendingIntent = PendingIntent.getActivity(
                context, notificationId, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("🔔 Financial Dashboard Active")
                .setContentText("Bank SMS listener is running. Tap to open dashboard.")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(tapPendingIntent);

        nm.notify(notificationId, builder.build());
    }
}
