package com.orderreport.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;

public final class MainActivity extends Activity {
    private static final int EXPORT_REQUEST_CODE = 4201;
    private static final String APP_URL = "file:///android_asset/index.html";
    private static final String APP_URL_NATIVE_INSETS = APP_URL + "?nativeInsets=1";
    private static final String EXPORT_FILE_PREFIX = "order-report-export-";
    private static final ExportCoordinator EXPORTS = new ExportCoordinator();

    private FrameLayout contentRoot;
    private WebView webView;
    private volatile boolean destroyed;
    private volatile boolean pageReady;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        configureSystemBars();

        contentRoot = new FrameLayout(this);
        contentRoot.setBackgroundColor(0xFFF5F3EE);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        // The bundled offline application requires JavaScript; top-level navigation is
        // restricted to our own android_asset origin by the WebViewClient below.
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

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageReady = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (destroyed || webView != view) return;
                pageReady = true;
                if (usesNativeInsets()) {
                    view.evaluateJavascript(
                            "document.documentElement.classList.add('native-insets')",
                            ignored -> EXPORTS.onPageReady(MainActivity.this));
                } else {
                    EXPORTS.onPageReady(MainActivity.this);
                }
            }
        });
        webView.addJavascriptInterface(new PrintBridge(), "AndroidPrint");
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.setBackgroundColor(0xFFF5F3EE);
        contentRoot.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(contentRoot);
        configureWindowInsets();

        if (savedInstanceState != null) {
            if (webView.restoreState(savedInstanceState) == null) webView.loadUrl(startUrl());
        } else {
            webView.loadUrl(startUrl());
        }
        EXPORTS.attach(this, savedInstanceState, savedInstanceState != null);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    this::handleBackPressed);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        EXPORTS.attach(this, null, true);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        configureSystemBars();
        if (contentRoot != null && usesNativeInsets()) contentRoot.requestApplyInsets();
    }

    private String startUrl() {
        return usesNativeInsets() ? APP_URL_NATIVE_INSETS : APP_URL;
    }

    private boolean usesNativeInsets() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM;
    }

    private void configureSystemBars() {
        if (usesNativeInsets()) getWindow().setDecorFitsSystemWindows(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(lightBars, lightBars);
            }
        } else {
            View decorView = getWindow().getDecorView();
            decorView.setSystemUiVisibility(decorView.getSystemUiVisibility()
                    | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    private void configureWindowInsets() {
        FrameLayout root = contentRoot;
        if (root == null || !usesNativeInsets()) return;
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            Insets safe = windowInsets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsets.Type.ime());
            int bottom = Math.max(safe.bottom, ime.bottom);
            if (view.getPaddingLeft() != safe.left
                    || view.getPaddingTop() != safe.top
                    || view.getPaddingRight() != safe.right
                    || view.getPaddingBottom() != bottom) {
                view.setPadding(safe.left, safe.top, safe.right, bottom);
            }
            return windowInsets;
        });
        root.requestApplyInsets();
    }

    private boolean isAppAsset(Uri uri) {
        return uri != null
                && "file".equals(uri.getScheme())
                && uri.getAuthority() == null
                && uri.getPath() != null
                && uri.getPath().startsWith("/android_asset/");
    }

    private static boolean isWritableContentUri(Uri uri) {
        return uri != null
                && ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())
                && uri.getAuthority() != null
                && !uri.getAuthority().trim().isEmpty();
    }

    private final class PrintBridge {
        @JavascriptInterface
        public void print() {
            runOnUiThread(() -> {
                WebView current = webView;
                if (destroyed || current == null || isFinishing()) return;
                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                String jobName = getString(R.string.app_name) + " 单据";
                printManager.print(jobName, current.createPrintDocumentAdapter(jobName), new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .build());
            });
        }
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public void saveText(String fileName, String content) {
            EXPORTS.requestExport(MainActivity.this, fileName, content);
        }
    }

    private void launchExportPicker(long jobId, String fileName) {
        if (destroyed || isFinishing()) {
            EXPORTS.deferPicker(jobId, this);
            return;
        }
        if (!EXPORTS.markPickerLaunched(jobId, this)) return;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        try {
            startActivityForResult(intent, EXPORT_REQUEST_CODE);
        } catch (ActivityNotFoundException error) {
            EXPORTS.complete(jobId, false, "手机没有可用的文件保存程序");
        } catch (RuntimeException error) {
            EXPORTS.complete(jobId, false, "无法打开保存程序：" + errorMessage(error));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != EXPORT_REQUEST_CODE) return;
        long jobId = EXPORTS.activeJobId();
        if (jobId == 0L) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            EXPORTS.complete(jobId, false, "已取消保存");
            return;
        }

        Uri destination = data.getData();
        if (!isWritableContentUri(destination)) {
            EXPORTS.complete(jobId, false, "保存程序返回了不安全的文件位置");
            return;
        }

        boolean persistedPermission = false;
        int resultFlags = data.getFlags();
        if ((resultFlags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0) {
            try {
                getContentResolver().takePersistableUriPermission(
                        destination,
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                persistedPermission = true;
            } catch (SecurityException ignored) {
                // Immediate copying can still succeed. A process restart will report a clear failure.
            }
        }
        EXPORTS.beginCopy(jobId, destination, persistedPermission);
    }

    private void applyExportBusy(boolean busy) {
        String value = Boolean.toString(busy);
        postJavascript("document.querySelectorAll('[data-action=\"save-export\"]').forEach(function(button){"
                + "button.disabled=" + value + ";button.setAttribute('aria-busy','" + value + "');});", null);
    }

    private void notifyExport(ExportResult result) {
        String script = "window.onNativeExportResult && window.onNativeExportResult("
                + result.success + "," + JSONObject.quote(result.message) + ");";
        postJavascript(script, () -> EXPORTS.resultDelivered(this, result.id));
    }

    private void notifyExportImmediately(boolean success, String message) {
        String script = "window.onNativeExportResult && window.onNativeExportResult("
                + success + "," + JSONObject.quote(message) + ");";
        postJavascript(script, null);
    }

    private void postJavascript(String script, Runnable delivered) {
        WebView current = webView;
        if (destroyed || current == null) {
            if (delivered != null) EXPORTS.resultDeliveryDeferred(this);
            return;
        }
        current.post(() -> {
            if (destroyed || webView != current || !pageReady) {
                if (delivered != null) EXPORTS.resultDeliveryDeferred(this);
                return;
            }
            try {
                current.evaluateJavascript(script, ignored -> {
                    if (!destroyed && webView == current && delivered != null) delivered.run();
                    else if (delivered != null) EXPORTS.resultDeliveryDeferred(this);
                });
            } catch (RuntimeException error) {
                if (delivered != null) EXPORTS.resultDeliveryDeferred(this);
            }
        });
    }

    private static String errorMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        EXPORTS.saveInstanceState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        pageReady = false;
        EXPORTS.detach(this);
        FrameLayout root = contentRoot;
        contentRoot = null;
        if (root != null) root.setOnApplyWindowInsetsListener(null);
        WebView current = webView;
        webView = null;
        if (current != null) {
            if (root != null) root.removeView(current);
            current.removeJavascriptInterface("AndroidPrint");
            current.removeJavascriptInterface("AndroidBridge");
            current.stopLoading();
            current.removeAllViews();
            current.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        handleBackPressed();
    }

    private void handleBackPressed() {
        WebView current = webView;
        if (destroyed) return;
        if (current == null) {
            super.onBackPressed();
            return;
        }
        current.evaluateJavascript(
                "(window.handleNativeBack && window.handleNativeBack()) === true",
                result -> {
                    if (destroyed || webView != current) return;
                    if ("true".equals(result)) return;
                    if (current.canGoBack()) current.goBack();
                    else MainActivity.super.onBackPressed();
                });
    }

    private static final class ExportResult {
        final long id;
        final boolean success;
        final String message;

        ExportResult(long id, boolean success, String message) {
            this.id = id;
            this.success = success;
            this.message = message;
        }
    }

    private static final class ExportCoordinator {
        private static final String PREFS = "native-export-state";
        private static final String KEY_JOB_ID = "jobId";
        private static final String KEY_STAGE = "stage";
        private static final String KEY_FILE_NAME = "fileName";
        private static final String KEY_CACHE_NAME = "cacheName";
        private static final String KEY_DESTINATION = "destination";
        private static final String KEY_PERSISTED_PERMISSION = "persistedPermission";
        private static final String KEY_RESULT_ID = "resultId";
        private static final String KEY_RESULT_SUCCESS = "resultSuccess";
        private static final String KEY_RESULT_MESSAGE = "resultMessage";
        private static final String STAGE_PREPARING = "preparing";
        private static final String STAGE_READY = "ready";
        private static final String STAGE_PICKER = "picker";
        private static final String STAGE_COPYING = "copying";
        private static final int WRITE_CHUNK_SIZE = 8 * 1024;
        private static final long STALE_EXPORT_AGE_MS = 24L * 60L * 60L * 1000L;

        private final Object monitor = new Object();
        private final AtomicLong sequence = new AtomicLong(System.currentTimeMillis());
        private WeakReference<MainActivity> activityReference = new WeakReference<>(null);
        private WeakReference<MainActivity> resultActivityReference = new WeakReference<>(null);
        private Context applicationContext;
        private ExecutorService executor;
        private boolean loaded;
        private boolean pickerDispatchPending;
        private long activeJobId;
        private String stage;
        private String fileName;
        private String cacheName;
        private String destination;
        private boolean persistedPermission;
        private ExportResult pendingResult;
        private long deliveringResultId;

        void attach(MainActivity activity, Bundle savedInstanceState, boolean systemRestore) {
            File abandonedFile = null;
            boolean resumeCopy = false;
            boolean launchPicker;
            boolean busy;
            synchronized (monitor) {
                applicationContext = activity.getApplicationContext();
                activityReference = new WeakReference<>(activity);
                if (!loaded) {
                    loadLocked(savedInstanceState);
                    loaded = true;
                    if (activeJobId != 0L) {
                        sequence.accumulateAndGet(activeJobId, Math::max);
                        File restoredFile = resolveCacheFileLocked();
                        if (STAGE_PREPARING.equals(stage)) {
                            recordResultAndClearLocked(false, "上次导出在准备文件时中断，请重新导出");
                        } else if (restoredFile == null || !restoredFile.isFile()) {
                            recordResultAndClearLocked(false, "上次导出内容已失效，请重新导出");
                        } else if (STAGE_PICKER.equals(stage) && !systemRestore) {
                            stage = STAGE_READY;
                            if (!persistLocked()) {
                                abandonedFile = restoredFile;
                                recordResultAndClearLocked(false, "无法恢复上次导出任务，请重新导出");
                            }
                        } else if (STAGE_COPYING.equals(stage)) {
                            Uri restoredDestination = destination == null ? null : Uri.parse(destination);
                            if (!isWritableContentUri(restoredDestination)) {
                                abandonedFile = restoredFile;
                                recordResultAndClearLocked(false, "上次导出的保存位置无效，请重新导出");
                            } else {
                                resumeCopy = true;
                            }
                        } else if (!STAGE_READY.equals(stage) && !STAGE_PICKER.equals(stage)) {
                            abandonedFile = restoredFile;
                            recordResultAndClearLocked(false, "上次导出任务状态无效，请重新导出");
                        }
                    }
                }
                busy = activeJobId != 0L;
                launchPicker = STAGE_READY.equals(stage);
                if (STAGE_COPYING.equals(stage) && executor == null) resumeCopy = true;
            }

            deleteQuietly(abandonedFile);
            cleanupStaleExports();
            activity.applyExportBusy(busy);
            deliverPendingResult(activity);
            if (launchPicker) dispatchPicker();
            if (resumeCopy) resumeCopy();
        }

        void detach(MainActivity activity) {
            synchronized (monitor) {
                if (activityReference.get() == activity) {
                    activityReference.clear();
                    pickerDispatchPending = false;
                }
                if (resultActivityReference.get() == activity) {
                    resultActivityReference.clear();
                    deliveringResultId = 0L;
                }
                if (activeJobId == 0L && executor != null) {
                    executor.shutdown();
                    executor = null;
                }
            }
        }

        void requestExport(MainActivity activity, String requestedFileName, String content) {
            if (content == null) {
                activity.notifyExportImmediately(false, "导出内容为空");
                return;
            }
            long jobId;
            boolean duplicate;
            boolean persisted;
            synchronized (monitor) {
                applicationContext = activity.getApplicationContext();
                activityReference = new WeakReference<>(activity);
                duplicate = activeJobId != 0L;
                if (duplicate) {
                    jobId = 0L;
                    persisted = true;
                } else {
                    jobId = sequence.incrementAndGet();
                    activeJobId = jobId;
                    stage = STAGE_PREPARING;
                    fileName = normalizeFileName(requestedFileName);
                    cacheName = null;
                    destination = null;
                    persistedPermission = false;
                    persisted = persistLocked();
                    if (!persisted) clearActiveLocked();
                }
            }
            if (duplicate) {
                activity.notifyExportImmediately(false, "已有导出正在进行，请完成后再试");
                return;
            }
            if (!persisted) {
                activity.notifyExportImmediately(false, "无法保存导出任务状态，请稍后重试");
                return;
            }
            activity.applyExportBusy(true);
            if (!submitPhase(jobId, () -> prepareExport(jobId, content))) {
                complete(jobId, false, "导出服务正忙，请稍后重试");
            }
        }

        long activeJobId() {
            synchronized (monitor) {
                return activeJobId;
            }
        }

        boolean markPickerLaunched(long jobId, MainActivity activity) {
            boolean persistenceFailed = false;
            synchronized (monitor) {
                pickerDispatchPending = false;
                if (activeJobId != jobId || !STAGE_READY.equals(stage)
                        || activityReference.get() != activity) return false;
                stage = STAGE_PICKER;
                if (!persistLocked()) {
                    stage = STAGE_READY;
                    persistenceFailed = true;
                }
            }
            if (persistenceFailed) {
                complete(jobId, false, "无法保存导出任务状态，请重新导出");
                return false;
            }
            return true;
        }

        void deferPicker(long jobId, MainActivity activity) {
            synchronized (monitor) {
                if (activeJobId == jobId && activityReference.get() == activity) {
                    pickerDispatchPending = false;
                    if (STAGE_PICKER.equals(stage)) {
                        stage = STAGE_READY;
                        persistLocked();
                    }
                }
            }
        }

        void beginCopy(long jobId, Uri destinationUri, boolean permissionPersisted) {
            boolean persistenceFailed = false;
            synchronized (monitor) {
                if (activeJobId != jobId || !STAGE_PICKER.equals(stage)) {
                    releasePersistedPermission(destinationUri, permissionPersisted);
                    return;
                }
                File contentFile = resolveCacheFileLocked();
                if (contentFile == null || !contentFile.isFile()) {
                    persistenceFailed = true;
                } else {
                    stage = STAGE_COPYING;
                    destination = destinationUri.toString();
                    persistedPermission = permissionPersisted;
                    if (!persistLocked()) persistenceFailed = true;
                }
            }
            if (persistenceFailed) {
                releasePersistedPermission(destinationUri, permissionPersisted);
                complete(jobId, false, "无法保存导出任务状态，请重新导出");
                return;
            }
            if (!submitPhase(jobId, () -> copyExport(jobId))) {
                complete(jobId, false, "导出服务正忙，请重新导出");
            }
        }

        void complete(long jobId, boolean success, String message) {
            File contentFile;
            Uri destinationUri;
            boolean releasePermission;
            MainActivity activity;
            synchronized (monitor) {
                if (jobId == 0L || activeJobId != jobId) return;
                contentFile = resolveCacheFileLocked();
                destinationUri = destination == null ? null : Uri.parse(destination);
                releasePermission = persistedPermission;
                recordResultAndClearLocked(success, message);
                pickerDispatchPending = false;
                ExecutorService currentExecutor = executor;
                executor = null;
                if (currentExecutor != null) currentExecutor.shutdown();
                activity = activityReference.get();
            }
            deleteQuietly(contentFile);
            releasePersistedPermission(destinationUri, releasePermission);
            if (activity != null) {
                activity.runOnUiThread(() -> {
                    if (activity.destroyed) return;
                    activity.applyExportBusy(false);
                    deliverPendingResult(activity);
                });
            }
        }

        void onPageReady(MainActivity activity) {
            boolean busy;
            synchronized (monitor) {
                if (activityReference.get() != activity) return;
                busy = activeJobId != 0L;
            }
            activity.applyExportBusy(busy);
            deliverPendingResult(activity);
        }

        void resultDelivered(MainActivity activity, long resultId) {
            synchronized (monitor) {
                if (deliveringResultId != resultId || resultActivityReference.get() != activity) return;
                if (pendingResult != null && pendingResult.id == resultId) pendingResult = null;
                deliveringResultId = 0L;
                resultActivityReference.clear();
                persistLocked();
            }
        }

        void resultDeliveryDeferred(MainActivity activity) {
            synchronized (monitor) {
                if (resultActivityReference.get() != activity) return;
                deliveringResultId = 0L;
                resultActivityReference.clear();
            }
        }

        void saveInstanceState(Bundle outState) {
            synchronized (monitor) {
                if (activeJobId == 0L) return;
                outState.putLong(KEY_JOB_ID, activeJobId);
                outState.putString(KEY_STAGE, stage);
                outState.putString(KEY_FILE_NAME, fileName);
                outState.putString(KEY_CACHE_NAME, cacheName);
                outState.putString(KEY_DESTINATION, destination);
                outState.putBoolean(KEY_PERSISTED_PERMISSION, persistedPermission);
            }
        }

        private void prepareExport(long jobId, String content) {
            File file = null;
            try {
                if (!isActiveStage(jobId, STAGE_PREPARING)) return;
                file = prepareExportFile(content);
                boolean persistenceFailed = false;
                ExecutorService completedPhase = null;
                synchronized (monitor) {
                    if (activeJobId != jobId || !STAGE_PREPARING.equals(stage)) {
                        deleteQuietly(file);
                        return;
                    }
                    cacheName = file.getName();
                    stage = STAGE_READY;
                    if (!persistLocked()) persistenceFailed = true;
                    else {
                        completedPhase = executor;
                        executor = null;
                    }
                }
                if (persistenceFailed) {
                    complete(jobId, false, "无法保存导出任务状态，请重新导出");
                    return;
                }
                if (completedPhase != null) completedPhase.shutdown();
                dispatchPicker();
            } catch (Exception error) {
                deleteQuietly(file);
                complete(jobId, false, "准备导出失败：" + errorMessage(error));
            }
        }

        private File prepareExportFile(String content) throws Exception {
            Context context;
            synchronized (monitor) {
                context = applicationContext;
            }
            if (context == null) throw new IllegalStateException("导出服务尚未初始化");
            File file = File.createTempFile(EXPORT_FILE_PREFIX, ".json", context.getCacheDir());
            try (FileOutputStream output = new FileOutputStream(file);
                 BufferedWriter writer = new BufferedWriter(
                         new OutputStreamWriter(output, StandardCharsets.UTF_8),
                         WRITE_CHUNK_SIZE)) {
                int offset = 0;
                while (offset < content.length()) {
                    if (Thread.currentThread().isInterrupted()) {
                        throw new InterruptedIOException("导出准备已取消");
                    }
                    int end = Math.min(content.length(), offset + WRITE_CHUNK_SIZE);
                    if (end < content.length() && end > offset
                            && Character.isHighSurrogate(content.charAt(end - 1))) {
                        end -= 1;
                    }
                    writer.write(content, offset, end - offset);
                    offset = end;
                }
                writer.flush();
                output.getFD().sync();
            } catch (Exception error) {
                deleteQuietly(file);
                throw error;
            }
            return file;
        }

        private void copyExport(long jobId) {
            Context context;
            File contentFile;
            Uri destinationUri;
            synchronized (monitor) {
                if (activeJobId != jobId || !STAGE_COPYING.equals(stage)) return;
                context = applicationContext;
                contentFile = resolveCacheFileLocked();
                destinationUri = destination == null ? null : Uri.parse(destination);
            }
            if (context == null || contentFile == null || !contentFile.isFile()
                    || !isWritableContentUri(destinationUri)) {
                complete(jobId, false, "导出任务无法恢复，请重新导出");
                return;
            }

            boolean success = false;
            String message = "文件已保存";
            try (FileInputStream input = new FileInputStream(contentFile);
                 OutputStream output = context.getContentResolver().openOutputStream(destinationUri, "wt")) {
                if (output == null) throw new IllegalStateException("无法打开保存位置");
                byte[] buffer = new byte[64 * 1024];
                int bytesRead;
                while ((bytesRead = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) {
                        throw new InterruptedIOException("保存已取消");
                    }
                    output.write(buffer, 0, bytesRead);
                }
                success = true;
            } catch (Exception error) {
                message = "保存失败：" + errorMessage(error);
            }
            complete(jobId, success, message);
        }

        private void resumeCopy() {
            long jobId;
            synchronized (monitor) {
                if (!STAGE_COPYING.equals(stage) || activeJobId == 0L || executor != null) return;
                jobId = activeJobId;
            }
            if (!submitPhase(jobId, () -> copyExport(jobId))) {
                complete(jobId, false, "无法恢复上次导出任务，请重新导出");
            }
        }

        private boolean submitPhase(long jobId, Runnable task) {
            ExecutorService phaseExecutor;
            synchronized (monitor) {
                if (activeJobId != jobId || executor != null) return false;
                phaseExecutor = Executors.newSingleThreadExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "order-report-export");
                    thread.setPriority(Thread.NORM_PRIORITY - 1);
                    return thread;
                });
                executor = phaseExecutor;
            }
            try {
                phaseExecutor.execute(() -> {
                    try {
                        task.run();
                    } finally {
                        synchronized (monitor) {
                            if (executor == phaseExecutor) executor = null;
                        }
                        phaseExecutor.shutdown();
                    }
                });
                return true;
            } catch (RejectedExecutionException error) {
                synchronized (monitor) {
                    if (executor == phaseExecutor) executor = null;
                }
                phaseExecutor.shutdownNow();
                return false;
            }
        }

        private void dispatchPicker() {
            MainActivity activity;
            long jobId;
            String suggestedFileName;
            synchronized (monitor) {
                if (!STAGE_READY.equals(stage) || activeJobId == 0L || pickerDispatchPending) return;
                activity = activityReference.get();
                if (activity == null) return;
                pickerDispatchPending = true;
                jobId = activeJobId;
                suggestedFileName = fileName;
            }
            activity.runOnUiThread(() -> activity.launchExportPicker(jobId, suggestedFileName));
        }

        private void deliverPendingResult(MainActivity activity) {
            ExportResult result;
            synchronized (monitor) {
                if (!activity.pageReady || activityReference.get() != activity
                        || pendingResult == null || deliveringResultId != 0L) return;
                result = pendingResult;
                deliveringResultId = result.id;
                resultActivityReference = new WeakReference<>(activity);
            }
            activity.notifyExport(result);
        }

        private boolean isActiveStage(long jobId, String expectedStage) {
            synchronized (monitor) {
                return activeJobId == jobId && expectedStage.equals(stage);
            }
        }

        private void loadLocked(Bundle savedInstanceState) {
            SharedPreferences preferences = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            activeJobId = preferences.getLong(KEY_JOB_ID, 0L);
            stage = preferences.getString(KEY_STAGE, null);
            fileName = preferences.getString(KEY_FILE_NAME, null);
            cacheName = preferences.getString(KEY_CACHE_NAME, null);
            destination = preferences.getString(KEY_DESTINATION, null);
            persistedPermission = preferences.getBoolean(KEY_PERSISTED_PERMISSION, false);
            long resultId = preferences.getLong(KEY_RESULT_ID, 0L);
            if (resultId != 0L) {
                pendingResult = new ExportResult(
                        resultId,
                        preferences.getBoolean(KEY_RESULT_SUCCESS, false),
                        preferences.getString(KEY_RESULT_MESSAGE, "导出任务已结束"));
            }

            if (activeJobId == 0L && savedInstanceState != null) {
                activeJobId = savedInstanceState.getLong(KEY_JOB_ID, 0L);
                if (activeJobId != 0L) {
                    stage = savedInstanceState.getString(KEY_STAGE);
                    fileName = savedInstanceState.getString(KEY_FILE_NAME);
                    cacheName = savedInstanceState.getString(KEY_CACHE_NAME);
                    destination = savedInstanceState.getString(KEY_DESTINATION);
                    persistedPermission = savedInstanceState.getBoolean(KEY_PERSISTED_PERMISSION, false);
                    persistLocked();
                }
            }
        }

        private boolean persistLocked() {
            if (applicationContext == null) return false;
            SharedPreferences.Editor editor = applicationContext
                    .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .clear();
            if (activeJobId != 0L) {
                editor.putLong(KEY_JOB_ID, activeJobId)
                        .putString(KEY_STAGE, stage)
                        .putString(KEY_FILE_NAME, fileName)
                        .putString(KEY_CACHE_NAME, cacheName)
                        .putString(KEY_DESTINATION, destination)
                        .putBoolean(KEY_PERSISTED_PERMISSION, persistedPermission);
            }
            if (pendingResult != null) {
                editor.putLong(KEY_RESULT_ID, pendingResult.id)
                        .putBoolean(KEY_RESULT_SUCCESS, pendingResult.success)
                        .putString(KEY_RESULT_MESSAGE, pendingResult.message);
            }
            return editor.commit();
        }

        private void recordResultAndClearLocked(boolean success, String message) {
            long completedJobId = activeJobId != 0L ? activeJobId : sequence.incrementAndGet();
            pendingResult = new ExportResult(completedJobId, success, message);
            clearActiveLocked();
            persistLocked();
        }

        private void clearActiveLocked() {
            activeJobId = 0L;
            stage = null;
            fileName = null;
            cacheName = null;
            destination = null;
            persistedPermission = false;
        }

        private File resolveCacheFileLocked() {
            if (applicationContext == null || cacheName == null
                    || !cacheName.startsWith(EXPORT_FILE_PREFIX)
                    || cacheName.contains("/") || cacheName.contains("\\")) return null;
            File file = new File(applicationContext.getCacheDir(), cacheName);
            return file.getParentFile() != null
                    && file.getParentFile().equals(applicationContext.getCacheDir())
                    ? file
                    : null;
        }

        private void cleanupStaleExports() {
            Context context;
            String preservedName;
            synchronized (monitor) {
                context = applicationContext;
                preservedName = cacheName;
            }
            if (context == null) return;
            File[] files = context.getCacheDir().listFiles(
                    (directory, name) -> name.startsWith(EXPORT_FILE_PREFIX));
            if (files == null) return;
            long cutoff = System.currentTimeMillis() - STALE_EXPORT_AGE_MS;
            for (File file : files) {
                if (!file.getName().equals(preservedName) && file.lastModified() < cutoff) {
                    deleteQuietly(file);
                }
            }
        }

        private void releasePersistedPermission(Uri uri, boolean persisted) {
            Context context;
            synchronized (monitor) {
                context = applicationContext;
            }
            if (!persisted || uri == null || context == null) return;
            try {
                context.getContentResolver().releasePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // The provider may already have revoked the grant.
            }
        }

        private static String normalizeFileName(String requestedFileName) {
            if (requestedFileName == null || requestedFileName.trim().isEmpty()) {
                return "order-report.json";
            }
            return requestedFileName;
        }

        private static void deleteQuietly(File file) {
            if (file != null) try { file.delete(); } catch (SecurityException ignored) {}
        }
    }
}
