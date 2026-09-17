package com.finance.dashboard;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.Telephony;
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
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.tasks.Task;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;

public class MainActivity extends AppCompatActivity {

    public static final String DASHBOARD_URL = "https://finance-dashboard-next-two.vercel.app/index.html";
    public static final String GOOGLE_WEB_CLIENT_ID = "772797302426-2temqmh2hhpg060l2lpkt75kbim8o9di.apps.googleusercontent.com";
    private static final int PERMISSION_REQUEST_CODE = 1001;
    private static final int RC_GOOGLE_SIGN_IN = 9001;
    private static final String TAG = "FinanceMainActivity";

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private ProgressBar progressBar;
    private boolean isRetrying = false;
    private int retryAttempt = 0;
    private float touchStartY = 0f;
    private boolean isSessionAuthenticated = false;

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

        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        SyncJobService.scheduleSync(this);

        if (savedInstanceState == null) {
            retryAttempt = 0;
            loadDashboard(false);
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
        if (!isSessionAuthenticated && prefs.getBoolean("biometric_lock_enabled", false) && isBiometricSupported()) {
            webView.setVisibility(android.view.View.INVISIBLE);
            showBiometricPrompt();
        } else {
            if (webView != null) {
                webView.post(() -> webView.evaluateJavascript("if (window.onAppResume) window.onAppResume();", null));
            }
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
                        isSessionAuthenticated = true;
                        if (webView != null) {
                            webView.setVisibility(android.view.View.VISIBLE);
                            webView.evaluateJavascript("if (window.onBiometricSuccess) window.onBiometricSuccess(); if (window.onAppResume) window.onAppResume();", null);
                        }
                    });
                }

                @Override
                public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                    super.onAuthenticationError(errorCode, errString);
                    runOnUiThread(() -> {
                        if (errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON && 
                            errorCode != BiometricPrompt.ERROR_USER_CANCELED) {
                            Toast.makeText(MainActivity.this, "Authentication failed", Toast.LENGTH_SHORT).show();
                        }
                        finishAffinity();
                    });
                }
            });

            prompt.authenticate(promptInfo);
        } catch (Exception e) {
            Log.w(TAG, "Biometric prompt error: " + e.getMessage());
        }
    }

    public void startNativeGoogleSignIn() {
        runOnUiThread(() -> {
            try {
                GoogleSignInOptions gso = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                        .requestIdToken(GOOGLE_WEB_CLIENT_ID)
                        .requestEmail()
                        .build();

                GoogleSignInClient client = GoogleSignIn.getClient(this, gso);
                Intent signInIntent = client.getSignInIntent();
                startActivityForResult(signInIntent, RC_GOOGLE_SIGN_IN);
            } catch (Exception e) {
                Log.e(TAG, "Google Sign-In initialization error", e);
                if (webView != null) {
                    webView.evaluateJavascript("if (window.onAndroidGoogleFallback) window.onAndroidGoogleFallback();", null);
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == RC_GOOGLE_SIGN_IN) {
            Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(data);
            String selectedEmail = "";
            try {
                GoogleSignInAccount account = task.getResult(ApiException.class);
                if (account != null) {
                    if (account.getEmail() != null) selectedEmail = account.getEmail();
                    String idToken = account.getIdToken();
                    if (idToken != null && !idToken.isEmpty()) {
                        if (webView != null) {
                            webView.evaluateJavascript("if (window.onAndroidGoogleToken) window.onAndroidGoogleToken(" + JSONObject.quote(idToken) + ");", null);
                        }
                        return;
                    }
                }
            } catch (ApiException e) {
                int statusCode = e.getStatusCode();
                Log.w(TAG, "Google sign in ApiException: status=" + statusCode + ", msg=" + e.getMessage());
                if (statusCode == 12501 || statusCode == 16) { // User canceled or in progress
                    if (webView != null) {
                        webView.evaluateJavascript("if (window.onAndroidGoogleCancel) window.onAndroidGoogleCancel();", null);
                    }
                    return;
                }
            } catch (Exception e) {
                Log.e(TAG, "Google sign in general error", e);
            }
            // Fallback gracefully to Web OAuth flow passing selected email hint so user doesn't have to type it!
            final String emailHint = (!selectedEmail.isEmpty()) ? selectedEmail : "kr.wn20@gmail.com";
            if (webView != null) {
                webView.evaluateJavascript("if (window.onAndroidGoogleFallback) window.onAndroidGoogleFallback(" + JSONObject.quote(emailHint) + ");", null);
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.setNetworkAvailable(true);
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
                String scheme = request.getUrl().getScheme();
                // Allow all http/https navigation inside the WebView (needed for Supabase OAuth redirects)
                if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) {
                    return false;
                }
                // For non-http schemes (tel:, mailto:, intent:, etc.) launch external handler
                try {
                    android.content.Intent intent = new android.content.Intent(
                        android.content.Intent.ACTION_VIEW, request.getUrl());
                    startActivity(intent);
                } catch (Exception e) {
                    Log.w(TAG, "Could not handle URL scheme: " + request.getUrl());
                }
                return true;
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
                 retryAttempt = 0;
             }

             @Override
             public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                 super.onReceivedError(view, request, error);
                 if (request.isForMainFrame()) {
                     Log.w(TAG, "Dashboard load failed: " + error.getErrorCode() + " " + error.getDescription());
                     scheduleDashboardRetry(view);
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
            retryAttempt = 0;
            loadDashboard(true);
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
            float headerThresholdPx = android.util.TypedValue.applyDimension(
                android.util.TypedValue.COMPLEX_UNIT_DIP, 60,
                getResources().getDisplayMetrics()
            );
            boolean isBelowTopHeader = touchStartY > headerThresholdPx;
            return isScrolledDown || isBelowTopHeader;
        });
    }

    private void loadDashboard(boolean bypassCache) {
        if (webView == null) return;
        if (bypassCache) {
            webView.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        } else {
            webView.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
        }
        webView.loadUrl(DASHBOARD_URL);
    }

    private void scheduleDashboardRetry(WebView view) {
        progressBar.setVisibility(View.GONE);
        swipeRefresh.setRefreshing(false);
        if (isRetrying || retryAttempt >= 5) {
            if (retryAttempt >= 5) Toast.makeText(this, "Dashboard connection failed. Pull down to retry.", Toast.LENGTH_LONG).show();
            return;
        }
        isRetrying = true;
        long delay = Math.min(15000L, 1000L * (1L << retryAttempt));
        retryAttempt++;
        view.postDelayed(() -> { isRetrying = false; loadDashboard(false); }, delay);
    }

    private void checkAndRequestPermissions() {
        List<String> permissions = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) {
            permissions.add(Manifest.permission.RECEIVE_SMS);
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
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidApp");
            webView.stopLoading();
            webView.clearHistory();
            if (webView.getParent() != null) {
                ((android.view.ViewGroup) webView.getParent()).removeView(webView);
            }
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
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
        public void clearUserSession() {
            SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            prefs.edit().remove("webhook_token").remove("custom_sms_rules").apply();
        }

        @JavascriptInterface
        public String getWebhookToken() {
            SharedPreferences prefs = mActivity.getSharedPreferences("finance_prefs", Context.MODE_PRIVATE);
            return prefs.getString("webhook_token", "");
        }

        @JavascriptInterface
        public String getRecentSmsSenders() {
            return "[\"INSTAPAY\",\"CIB\",\"NBE\",\"BANQUEMISR\",\"BDC\",\"QNB\",\"HSBC\",\"VFCASH\",\"ETCASH\",\"ALEXBANK\",\"AAIB\",\"FABMISR\",\"FAWRY\",\"TELDA\",\"WEPAY\"]";
        }

        @JavascriptInterface
        public boolean hasReadSmsPermission() {
            return false;
        }

        @JavascriptInterface
        public void requestReadSmsPermission() {
            // Option B: READ_SMS removed to avoid Play Protect false-positive blocks
        }

        @JavascriptInterface
        public String scanInboxBankTransactions(int daysBack) {
            // Option B: Returns empty array, relies on offline SQLite cache and direct SMS paste
            return "[]";
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

        @JavascriptInterface
        public void triggerGoogleSignIn() {
            mActivity.startNativeGoogleSignIn();
        }
    }
}
