# R8 / ProGuard Configuration for Financial Dashboard

# 1. Preserve JavaScript Bridge methods for WebView
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 2. Preserve native WebAppInterface
-keep class com.finance.dashboard.MainActivity$WebAppInterface {
    <methods>;
}

# 3. AndroidX & Material Components rules
-keep class androidx.swiperefreshlayout.widget.** { *; }
-keepclassmembers class * extends androidx.fragment.app.Fragment {
    public <init>();
}

# 4. JSON / Data Parsing rules
-keepclassmembers class com.finance.dashboard.BankParser$ParsedTransaction {
    <fields>;
    <methods>;
}

# 5. Optimize release build size by removing debug logs
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int d(...);
}
