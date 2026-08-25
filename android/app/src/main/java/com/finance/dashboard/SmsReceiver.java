package com.finance.dashboard;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.telephony.SmsMessage;
import androidx.core.app.NotificationCompat;

public class SmsReceiver extends BroadcastReceiver {
    public static final String CHANNEL_ID = "financial_alerts";

    @Override public void onReceive(Context context, Intent intent) {
        if (!"android.provider.Telephony.SMS_RECEIVED".equals(intent.getAction())) return;
        Bundle bundle = intent.getExtras();
        if (bundle == null) return;
        Object[] pdus = (Object[]) bundle.get("pdus");
        if (pdus == null || pdus.length == 0) return;
        String format = bundle.getString("format");
        StringBuilder body = new StringBuilder();
        String sender = "";
        for (Object pdu : pdus) {
            SmsMessage sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    ? SmsMessage.createFromPdu((byte[]) pdu, format)
                    : SmsMessage.createFromPdu((byte[]) pdu);
            if (sms != null) { body.append(sms.getMessageBody()); sender = sms.getOriginatingAddress(); }
        }
        BankParser.ParsedTransaction tx = BankParser.parse(context, body.toString(), sender);
        if (!tx.isMatched || tx.amount <= 0) return;
        long localId = TransactionBackupStore.saveTransaction(context, tx.rawMessage, tx.amount,
                tx.merchant, tx.kind, tx.defaultCategory, "pending", sender);
        showActionNotification(context, tx, localId, sender);
    }

    private void showActionNotification(Context context, BankParser.ParsedTransaction tx, long localId, String sender) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                    context.getString(R.string.channel_name), NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(context.getString(R.string.channel_desc));
            channel.enableVibration(true);
            nm.createNotificationChannel(channel);
        }
        int notificationId = (int) (localId % Integer.MAX_VALUE);
        PendingIntent confirm = action(context, NotificationActionReceiver.ACTION_CONFIRM, tx, localId, notificationId, 0, sender);
        PendingIntent category = action(context, NotificationActionReceiver.ACTION_CATEGORY, tx, localId, notificationId, 1, sender);
        PendingIntent dismiss = action(context, NotificationActionReceiver.ACTION_DISMISS, tx, localId, notificationId, 2, sender);
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(context, notificationId, open,
                PendingIntent.FLAG_UPDATE_CURRENT | immutable());
        String title = "outgoing".equals(tx.kind) ? "💸 EGP " + String.format("%.2f", tx.amount) + " Spent" : "💰 EGP " + String.format("%.2f", tx.amount) + " Received";
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title)
                .setContentText(tx.merchant + " • Choose an action")
                .setPriority(NotificationCompat.PRIORITY_HIGH).setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true).setContentIntent(content)
                .addAction(new NotificationCompat.Action(0, "Confirm", confirm))
                .addAction(new NotificationCompat.Action(0, tx.defaultCategory.isEmpty() ? "Categorize" : tx.defaultCategory, category))
                .addAction(new NotificationCompat.Action(0, "Dismiss", dismiss));
        nm.notify(notificationId, b.build());
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent timeout = new Intent(context, TimeoutReceiver.class).putExtra("local_id", localId)
                .putExtra("notification_id", notificationId).putExtra("raw_message", tx.rawMessage).putExtra("sender", sender)
                .putExtra("amount", tx.amount).putExtra("merchant", tx.merchant).putExtra("kind", tx.kind);
        PendingIntent timeoutPi = PendingIntent.getBroadcast(context, notificationId, timeout,
                PendingIntent.FLAG_UPDATE_CURRENT | immutable());
        if (alarms != null) alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis() + 5 * 60 * 1000L, timeoutPi);
    }

    private PendingIntent action(Context c, String action, BankParser.ParsedTransaction tx, long id, int nid, int request, String sender) {
        Intent i = new Intent(c, NotificationActionReceiver.class).setAction(action)
                .putExtra("local_id", id).putExtra("notification_id", nid).putExtra("raw_message", tx.rawMessage).putExtra("sender", sender)
                .putExtra("amount", tx.amount).putExtra("kind", tx.kind).putExtra("category", tx.defaultCategory);
        return PendingIntent.getBroadcast(c, nid * 10 + request, i,
                PendingIntent.FLAG_UPDATE_CURRENT | immutable());
    }
    private static int immutable() { return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0; }

    public static void showTestNotification(Context context) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID,
                context.getString(R.string.channel_name), NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(context, 9999, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable());
        nm.notify(9999, new NotificationCompat.Builder(context, CHANNEL_ID).setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("🔔 Financial Dashboard Active").setContentText("Bank SMS listener is running.")
                .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true).setContentIntent(pi).build());
    }
}

