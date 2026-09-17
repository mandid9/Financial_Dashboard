# Keep WebView JavaScript interface
-keepclassmembers class com.finance.dashboard.MainActivity$WebAppInterface {
    public *;
}
# Keep BankParser public API
-keep class com.finance.dashboard.BankParser { *; }
-keep class com.finance.dashboard.BankParser$ParsedTransaction { *; }
# Keep TransactionBackupStore & SyncJobService
-keep class com.finance.dashboard.TransactionBackupStore { *; }
-keep class com.finance.dashboard.SyncJobService { *; }

# Keep Credential Manager & Google ID
-keep class androidx.credentials.** { *; }
-keep class com.google.android.libraries.identity.googleid.** { *; }
-keep class com.google.android.gms.auth.api.signin.** { *; }
-keep class org.json.** { *; }


