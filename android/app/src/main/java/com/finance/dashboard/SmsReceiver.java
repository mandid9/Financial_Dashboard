package com.finance.dashboard;

import android.app.AlarmManager;
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
import androidx.core.app.NotificationCompat;

public class SmsReceiver extends BroadcastReceiver {

    public static final String CHANNEL_ID = "financial_alerts";
    public static final String ACTION_CONFIRM = "com.finance.dashboard.ACTION_CONFIRM";
    public static final String ACTION_DISMISS = "com.finance.dashboard.ACTION_DISMISS";
    public static final String ACTION_CATEGORY = "com.finance.dashboard.ACTION_CATEGORY";
    public static final String ACTION_TIMEOUT = "com.finance.dashboard.ACTION_TIMEOUT";

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
            showActionableNotification(context, tx, sender);
        }
    }

    private void showActionableNotification(Context context, BankParser.ParsedTransaction tx, String sender) {
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

        // Content intent (tap opens app)
        Intent tapIntent = new Intent(context, MainActivity.class);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tapPendingIntent = PendingIntent.getActivity(
                context, notificationId, tapIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        // Confirm Action
        Intent confirmIntent = new Intent(context, NotificationActionReceiver.class);
        confirmIntent.setAction(ACTION_CONFIRM);
        confirmIntent.putExtra("notification_id", notificationId);
        confirmIntent.putExtra("raw_message", tx.rawMessage);
        confirmIntent.putExtra("amount", tx.amount);
        confirmIntent.putExtra("merchant", tx.merchant);
        confirmIntent.putExtra("kind", tx.kind);
        if (tx.defaultCategory != null && !tx.defaultCategory.isEmpty()) {
            confirmIntent.putExtra("category", tx.defaultCategory);
        }
        PendingIntent confirmPending = PendingIntent.getBroadcast(
                context, notificationId * 10 + 1, confirmIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        // Quick Category Chip 1: Groceries (or custom if set)
        String chip1Name = (tx.defaultCategory != null && !tx.defaultCategory.isEmpty()) ? tx.defaultCategory : "Groceries & Supermarket";
        String chip1Label = (tx.defaultCategory != null && !tx.defaultCategory.isEmpty()) ? "🏷️ " + chip1Name : "🛒 Groceries";
        Intent grocIntent = new Intent(context, NotificationActionReceiver.class);
        grocIntent.setAction(ACTION_CATEGORY);
        grocIntent.putExtra("notification_id", notificationId);
        grocIntent.putExtra("raw_message", tx.rawMessage);
        grocIntent.putExtra("category", chip1Name);
        PendingIntent grocPending = PendingIntent.getBroadcast(
                context, notificationId * 10 + 2, grocIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        // Quick Category Chip 2: Dining
        Intent foodIntent = new Intent(context, NotificationActionReceiver.class);
        foodIntent.setAction(ACTION_CATEGORY);
        foodIntent.putExtra("notification_id", notificationId);
        foodIntent.putExtra("raw_message", tx.rawMessage);
        foodIntent.putExtra("category", "Food & Dining");
        PendingIntent foodPending = PendingIntent.getBroadcast(
                context, notificationId * 10 + 3, foodIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        // Dismiss Action
        Intent dismissIntent = new Intent(context, NotificationActionReceiver.class);
        dismissIntent.setAction(ACTION_DISMISS);
        dismissIntent.putExtra("notification_id", notificationId);
        PendingIntent dismissPending = PendingIntent.getBroadcast(
                context, notificationId * 10 + 4, dismissIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        String title = "outgoing".equals(tx.kind)
                ? "💸 EGP " + formattedAmt + " Spent @ " + tx.merchant
                : "💰 EGP " + formattedAmt + " Income Received";

        String body = tx.merchant + " • Tap to confirm or choose category";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(tapPendingIntent)
                .addAction(android.R.drawable.ic_menu_save, "✅ Confirm", confirmPending)
                .addAction(android.R.drawable.ic_menu_agenda, chip1Label, grocPending)
                .addAction(android.R.drawable.ic_menu_agenda, "🍔 Dining", foodPending)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "❌ Dismiss", dismissPending);

        nm.notify(notificationId, builder.build());

        // Schedule 5-minute timeout to push untouched SMS to pending inbox
        scheduleTimeout(context, notificationId, tx.rawMessage, tx.amount, tx.merchant, tx.kind);
    }

    private void scheduleTimeout(Context context, int notificationId, String rawMessage, double amount, String merchant, String kind) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Intent timeoutIntent = new Intent(context, TimeoutReceiver.class);
        timeoutIntent.setAction(ACTION_TIMEOUT);
        timeoutIntent.putExtra("notification_id", notificationId);
        timeoutIntent.putExtra("raw_message", rawMessage);
        timeoutIntent.putExtra("amount", amount);
        timeoutIntent.putExtra("merchant", merchant);
        timeoutIntent.putExtra("kind", kind);

        PendingIntent pi = PendingIntent.getBroadcast(
                context, notificationId, timeoutIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        long triggerAt = System.currentTimeMillis() + (5 * 60 * 1000); // 5 minutes
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
        } else {
            am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi);
        }
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
                .setContentText("Bank SMS listener and quick-action chips are active!")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(tapPendingIntent);

        nm.notify(notificationId, builder.build());
    }
}
