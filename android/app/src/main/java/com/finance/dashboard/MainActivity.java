package com.finance.dashboard;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    public static final String DASHBOARD_URL = "https://finance-dashboard-next-two.vercel.app/index.html";
    private static final int PERMISSION_REQUEST_CODE = 1001;
    private static final String TAG = "FinanceMainActivity";

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private ProgressBar progressBar;
    private boolean isRetrying = false;
    private float touchStartY = 0f;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. Edge-to-Edge System Bar Configuration
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat insetsController = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (insetsController != null) {
            insetsController.setAppearanceLightStatusBars(false);
            insetsController.setAppearanceLightNavigationBars(false);
        }

        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        swipeRefresh = findViewById(R.id.swipe_refresh);
        progressBar = findViewById(R.id.progress_bar);

        // 2. Dynamic Window Insets Handling
        ViewCompat.setOnApplyWindowInsetsListener(swipeRefresh, (v, windowInsets) -> {
            Insets systemBars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
            return windowInsets;
        });

        setupWebView();
        setupSwipeRefresh();
        checkAndRequestPermissions();

        if (savedInstanceState == null) {
            webView.loadUrl(DASHBOARD_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 1. Sync any offline/pending SMS transactions
        TransactionBackupStore.syncPendingTransactions(this);

        // 2. Check biometric lock on app open/resume if user enabled it
        SharedPreferences prefs = getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
        if (prefs.getBoolean("biometric_lock_enabled", false) && isBiometricSupported()) {
            showBiometricPrompt();
        }
    }

    public boolean isBiometricSupported() {
        try {
            BiometricManager bm = BiometricManager.from(this);
            int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
            return bm.canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS;
        } catch (Exception e) {
            return false;
        }
    }

    public void showBiometricPrompt() {
        try {
            BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock Financial Dashboard")
                    .setSubtitle("Confirm fingerprint or device lock")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .build();

            BiometricPrompt prompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                    super.onAuthenticationSucceeded(result);
                    runOnUiThread(() -> {
                        if (webView != null) {
                            webView.evaluateJavascript("if (window.onBiometricSuccess) window.onBiometricSuccess();", null);
                        }
                    });
                }

                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                    super.onAuthenticationError(errorCode, errString);
                    Log.d(TAG, "Biometric notice: " + errString);
                }
            });

            prompt.authenticate(promptInfo);
        } catch (Exception e) {
            Log.w(TAG, "Biometric prompt error: " + e.getMessage());
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Cookies
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        // Hardware acceleration
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        webView.setVisibility(View.VISIBLE);

        // Expose JavaScript bridge
        webView.addJavascriptInterface(new WebAppInterface(this), "AndroidApp");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false; // Handle all navigation internally
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                swipeRefresh.setRefreshing(false);
                isRetrying = false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    progressBar.setVisibility(View.GONE);
                    swipeRefresh.setRefreshing(false);
                    // Automatically retry once if connection aborted transiently during deployment
                    if (!isRetrying) {
                        isRetrying = true;
                        view.postDelayed(() -> view.loadUrl(DASHBOARD_URL), 1200);
                    }
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                if (newProgress >= 100) {
                    progressBar.setVisibility(View.GONE);
                }
            }
        });
    }

    @SuppressLint("ClickableViewAccessibility")
    private void setupSwipeRefresh() {
        swipeRefresh.setColorSchemeResources(R.color.primary, R.color.accent);
        swipeRefresh.setProgressBackgroundColorSchemeResource(R.color.surface);
        swipeRefresh.setOnRefreshListener(() -> {
            isRetrying = false;
            webView.loadUrl(DASHBOARD_URL);
        });

        // 1. Capture touch start Y position to prevent pull-to-refresh when dragging lower/middle parts or popups
        webView.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                touchStartY = event.getY();
            }
            return false;
        });

        // 2. Strictly allow pull-to-refresh ONLY when:
        //    - WebView scroll position is at the very top (scrollY == 0)
        //    - AND touch started within the top header area (Y <= 220px)
        swipeRefresh.setOnChildScrollUpCallback((parent, child) -> {
            boolean isScrolledDown = webView.getScrollY() > 0 || webView.canScrollVertically(-1);
            boolean isBelowTopHeader = touchStartY > 220f;
            return isScrolledDown || isBelowTopHeader;
        });
    }

    private void checkAndRequestPermissions() {
        List<String> permissions = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.RECEIVE_SMS);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.READ_SMS);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissions.add(Manifest.permission.POST_NOTIFICATIONS);
            }
        }

        if (!permissions.isEmpty()) {
            ActivityCompat.requestPermissions(this, permissions.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_CODE) {
            boolean allGranted = true;
            for (int result : grantResults) {
                if (result != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (allGranted) {
                Toast.makeText(this, "✅ Bank SMS catching is active!", Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(this, "⚠️ SMS permission required to auto-detect bank transactions", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    public static class WebAppInterface {
        private final MainActivity mActivity;

        WebAppInterface(MainActivity activity) {
            this.mActivity = activity;
        }

        @JavascriptInterface
        public void vibrate(int durationMs) {
            Vibrator v = (Vibrator) mActivity.getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(Math.min(durationMs, 500), VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(Math.min(durationMs, 500));
                }
            }
        }

        @JavascriptInterface
        public void setWebhookToken(String token) {
            if (token != null) {
                SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
                prefs.edit().putString("webhook_token", token.trim()).apply();
            }
        }

        @JavascriptInterface
        public String getWebhookToken() {
            SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            return prefs.getString("webhook_token", "");
        }

        @JavascriptInterface
        public void syncCustomSmsRules(String jsonRules) {
            if (jsonRules != null) {
                SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
                prefs.edit().putString("custom_sms_rules", jsonRules).apply();
            }
        }

        @JavascriptInterface
        public String getCustomSmsRules() {
            SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            return prefs.getString("custom_sms_rules", "[]");
        }

        // --- Biometric Authentication Bridge ---
        @JavascriptInterface
        public boolean isBiometricSupported() {
            return mActivity.isBiometricSupported();
        }

        @JavascriptInterface
        public boolean isBiometricLockEnabled() {
            SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            return prefs.getBoolean("biometric_lock_enabled", false);
        }

        @JavascriptInterface
        public void setBiometricLockEnabled(boolean enabled) {
            SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            prefs.edit().putBoolean("biometric_lock_enabled", enabled).apply();
            mActivity.runOnUiThread(() -> {
                String status = enabled ? "🔐 Fingerprint Lock Enabled" : "🔓 Fingerprint Lock Disabled";
                Toast.makeText(mActivity, status, Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public void promptBiometricAuth() {
            mActivity.runOnUiThread(mActivity::showBiometricPrompt);
        }

        @JavascriptInterface
        public void sendNativeTestNotification() {
            mActivity.runOnUiThread(() -> {
                SmsReceiver.showTestNotification(mActivity);
                Toast.makeText(mActivity, "🔔 Test notification sent to status bar!", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public String getOfflineBackupTransactions() {
            return TransactionBackupStore.getSavedTransactionsJson(mActivity);
        }

        @JavascriptInterface
        public void syncOfflineTransactions() {
            TransactionBackupStore.syncPendingTransactions(mActivity);
            mActivity.runOnUiThread(() -> {
                Toast.makeText(mActivity, "🔄 Syncing offline transactions...", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public void setSwipeRefreshEnabled(boolean enabled) {
            mActivity.runOnUiThread(() -> {
                if (mActivity.swipeRefresh != null) {
                    mActivity.swipeRefresh.setEnabled(enabled);
                }
            });
        }
    }
}
