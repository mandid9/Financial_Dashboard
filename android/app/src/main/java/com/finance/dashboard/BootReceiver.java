package com.finance.dashboard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        // Android system will register SmsReceiver automatically via manifest
        if (android.content.Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            // Sync any transactions that were queued while device was off
            new Thread(() -> TransactionBackupStore.syncPendingTransactions(context)).start();
        }
    }
}
