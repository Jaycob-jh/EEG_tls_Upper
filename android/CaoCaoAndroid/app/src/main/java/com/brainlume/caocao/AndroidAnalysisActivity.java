package com.brainlume.caocao;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

/** Separate Android activity for the non-modal offline-analysis window. */
@SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
public final class AndroidAnalysisActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("曹操 · EEG 分析");
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        AndroidFullActivity.NativeBridge bridge = new AndroidFullActivity.NativeBridge(this);
        webView.addJavascriptInterface(bridge, "AndroidNative");
        setContentView(webView);
        String sessionId = getIntent().getStringExtra("sessionId");
        String query = sessionId == null || sessionId.isEmpty() ? "" : "?sessionId=" + Uri.encode(sessionId);
        webView.loadUrl("file:///android_asset/web/analysis.html" + query);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
