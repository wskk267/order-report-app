package com.orderreport.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.Window;
import android.window.OnBackInvokedDispatcher;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public final class MainActivity extends Activity {
    private static final int EXPORT_REQUEST_CODE = 4201;
    private static final String APP_URL = "file:///android_asset/index.html";
    private static final String EXPORT_FILE_PREFIX = "order-report-export-";
    private static final String STATE_PENDING_EXPORT_FILE = "pendingExportFile";
    private WebView webView;
    private File pendingExportFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(true);
        }

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isAppAsset(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isAppAsset(Uri.parse(url));
            }
        });
        webView.addJavascriptInterface(new PrintBridge(), "AndroidPrint");
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.setBackgroundColor(0xFFF5F3EE);
        if (savedInstanceState != null) {
            restorePendingExport(savedInstanceState.getString(STATE_PENDING_EXPORT_FILE));
            if (webView.restoreState(savedInstanceState) == null) webView.loadUrl(APP_URL);
        } else {
            cleanupStaleExports();
            webView.loadUrl(APP_URL);
        }
        setContentView(webView);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::handleBackPressed);
        }
    }

    private boolean isAppAsset(Uri uri) {
        return uri != null
                && "file".equals(uri.getScheme())
                && uri.getPath() != null
                && uri.getPath().startsWith("/android_asset/");
    }

    private final class PrintBridge {
        @JavascriptInterface
        public void print() {
            runOnUiThread(() -> {
                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String jobName = getString(com.orderreport.app.R.string.app_name) + " 单据";
                printManager.print(jobName, webView.createPrintDocumentAdapter(jobName), new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .build());
            });
        }
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public void saveText(String fileName, String content) {
            runOnUiThread(() -> {
                try {
                    preparePendingExport(content);
                } catch (Exception error) {
                    clearPendingExport();
                    notifyExport(false, "准备导出失败：" + error.getMessage());
                    return;
                }
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_TITLE, fileName);
                try {
                    startActivityForResult(intent, EXPORT_REQUEST_CODE);
                } catch (ActivityNotFoundException error) {
                    clearPendingExport();
                    notifyExport(false, "手机没有可用的文件保存程序");
                }
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != EXPORT_REQUEST_CODE) return;
        File contentFile = pendingExportFile;
        pendingExportFile = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            deleteQuietly(contentFile);
            notifyExport(false, "已取消保存");
            return;
        }
        if (contentFile == null || !contentFile.isFile()) {
            notifyExport(false, "导出内容已失效，请重新导出");
            return;
        }
        try (FileInputStream input = new FileInputStream(contentFile);
             OutputStream output = getContentResolver().openOutputStream(data.getData())) {
            if (output == null) throw new IllegalStateException("无法打开保存位置");
            byte[] buffer = new byte[64 * 1024];
            int bytesRead;
            while ((bytesRead = input.read(buffer)) != -1) output.write(buffer, 0, bytesRead);
        } catch (Exception error) {
            notifyExport(false, "保存失败：" + error.getMessage());
            return;
        } finally {
            deleteQuietly(contentFile);
        }
        notifyExport(true, "文件已保存");
    }

    private void preparePendingExport(String content) throws Exception {
        if (content == null) throw new IllegalArgumentException("导出内容为空");
        clearPendingExport();
        File file = File.createTempFile(EXPORT_FILE_PREFIX, ".json", getCacheDir());
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(content.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        } catch (Exception error) {
            deleteQuietly(file);
            throw error;
        }
        pendingExportFile = file;
    }

    private void restorePendingExport(String fileName) {
        if (fileName == null || !fileName.startsWith(EXPORT_FILE_PREFIX) || fileName.contains("/")) return;
        File candidate = new File(getCacheDir(), fileName);
        if (candidate.isFile()) pendingExportFile = candidate;
    }

    private void cleanupStaleExports() {
        File[] files = getCacheDir().listFiles((directory, name) -> name.startsWith(EXPORT_FILE_PREFIX));
        if (files == null) return;
        for (File file : files) deleteQuietly(file);
    }

    private void deleteQuietly(File file) {
        if (file != null) try { file.delete(); } catch (SecurityException ignored) {}
    }

    private void clearPendingExport() {
        deleteQuietly(pendingExportFile);
        pendingExportFile = null;
    }

    private void notifyExport(boolean success, String message) {
        if (webView == null) return;
        String script = "window.onNativeExportResult && window.onNativeExportResult(" + success + "," + JSONObject.quote(message) + ");";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        if (pendingExportFile != null) outState.putString(STATE_PENDING_EXPORT_FILE, pendingExportFile.getName());
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        handleBackPressed();
    }

    private void handleBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(window.handleNativeBack && window.handleNativeBack()) === true",
                result -> {
                    if ("true".equals(result)) return;
                    if (webView.canGoBack()) webView.goBack();
                    else MainActivity.super.onBackPressed();
                });
    }
}
