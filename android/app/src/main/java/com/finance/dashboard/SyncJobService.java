package com.finance.dashboard;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.util.Log;

public class SyncJobService extends JobService {
    private static final String TAG = "SyncJobService";
    public static final int JOB_ID = 8801;

    @Override
    public boolean onStartJob(JobParameters params) {
        Log.i(TAG, "Background sync job started for pending SMS transactions");
        new Thread(() -> {
            boolean needsReschedule = false;
            try {
                needsReschedule = TransactionBackupStore.syncPendingTransactionsSync(getApplicationContext());
            } catch (Exception e) {
                Log.e(TAG, "SyncJobService execution error", e);
                needsReschedule = true;
            } finally {
                jobFinished(params, needsReschedule);
            }
        }).start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Log.w(TAG, "SyncJobService stopped prematurely");
        return true;
    }

    public static void scheduleSync(Context context) {
        try {
            JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (scheduler == null) return;

            ComponentName component = new ComponentName(context, SyncJobService.class);
            JobInfo jobInfo = new JobInfo.Builder(JOB_ID, component)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setBackoffCriteria(30000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .build();

            int result = scheduler.schedule(jobInfo);
            Log.d(TAG, "Scheduled sync job, result: " + result);
        } catch (Exception e) {
            Log.w(TAG, "Failed to schedule SyncJobService: " + e.getMessage());
        }
    }
}
