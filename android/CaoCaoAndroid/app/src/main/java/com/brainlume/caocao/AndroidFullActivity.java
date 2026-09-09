package com.brainlume.caocao;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Android host for the migrated Upper web UI.
 *
 * The renderer is deliberately shared with Windows/macOS. This class only
 * owns Android boundaries: WebView, runtime permissions, BLE/GATT, local EDF
 * persistence, and the bridge methods consumed by android-bridge.js.
 */
@SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
public final class AndroidFullActivity extends Activity {
    static final int BLE_PERMISSION_REQUEST = 4101;
    static final int SCAN_DURATION_MS = 12_000;
    static final int MAX_CONNECT_ATTEMPTS = 6;
    static final int CONNECT_RETRY_DELAY_MS = 1_000;
    // 与桌面端 Web Bluetooth 的 20 字节分片策略一致，兼容默认 ATT MTU。
    static final int BLE_WRITE_CHUNK_SIZE = 20;
    // EEG 通知不再逐帧跨 WebView；批量转发仍保留原始字节流，不改变 ActionBus 解析边界。
    static final int BLE_RX_FLUSH_INTERVAL_MS = 20;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private NativeBridge bridge;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic writeCharacteristic;
    private BluetoothGattCharacteristic notifyCharacteristic;
    private final Map<String, BluetoothDevice> discovered = new LinkedHashMap<>();
    private final ArrayDeque<byte[]> writeQueue = new ArrayDeque<>();
    private final Object rxLock = new Object();
    private final ByteArrayOutputStream rxBatch = new ByteArrayOutputStream();
    private boolean rxFlushScheduled;
    private final Runnable rxFlushRunnable = this::flushRxBatch;
    private boolean writeInFlight;
    private boolean scanning;
    private boolean pendingScan;
    private BluetoothDevice selectedDevice;
    private String selectedName = "";
    private int connectAttempt;
    private boolean userDisconnect;
    private boolean bridgeConnected;

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device;
            try {
                device = result.getDevice();
            } catch (SecurityException error) {
                emitBleError("系统拒绝读取 BLE 设备信息：" + error.getMessage());
                return;
            }
            String systemName = safeDeviceName(device);
            String advertisedName = advertisedName(result);
            String name = firstNonBlank(systemName, advertisedName);
            if (!matchesTarget(result, name)) return;
            String displayName = firstNonBlank(name, "BrainLume2.0C（ABF0 服务）");
            try {
                discovered.putIfAbsent(device.getAddress(), device);
                JSONObject candidate = new JSONObject();
                candidate.put("id", device.getAddress());
                candidate.put("name", displayName);
                candidate.put("rssi", result.getRssi());
                candidate.put("advertisedName", advertisedName == null ? JSONObject.NULL : advertisedName);
                candidate.put("service", CaoCaoProtocol.SERVICE_UUID.toString());
                emitCandidates();
            } catch (Exception error) {
                emitBleError("读取 BLE 扫描结果失败：" + error.getMessage());
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            scanning = false;
            emitBleStatus(status("failed", "device_scan", 1, MAX_CONNECT_ATTEMPTS, "BLE 扫描失败，错误码 " + errorCode));
            emitBleError("BLE 扫描失败，错误码 " + errorCode);
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt callbackGatt, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                gatt = callbackGatt;
                bridgeConnected = false;
                emitBleStatus(status("connected", "gatt_connect", connectAttempt, MAX_CONNECT_ATTEMPTS, null));
                try {
                    if (!callbackGatt.discoverServices()) connectionFailure("gatt_service_discovery", "GATT 服务发现请求未接受");
                } catch (SecurityException error) {
                    connectionFailure("gatt_service_discovery", "系统拒绝 GATT 服务发现：" + error.getMessage());
                }
                return;
            }
            if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                bridgeConnected = false;
                closeGattOnly(callbackGatt);
                if (!userDisconnect && selectedDevice != null && connectAttempt < MAX_CONNECT_ATTEMPTS) {
                    emitBleStatus(status("attempt_failed", "gatt_connect", connectAttempt, MAX_CONNECT_ATTEMPTS,
                            "连接断开，准备重试"));
                    mainHandler.postDelayed(this::retryConnection, CONNECT_RETRY_DELAY_MS);
                } else if (!userDisconnect) {
                    stopBleKeepAlive();
                    emitBleStatus(status("failed", "gatt_connect", connectAttempt, MAX_CONNECT_ATTEMPTS,
                            "Connection attempt failed"));
                    emitBleError("BLE 连接失败：已尝试 " + connectAttempt + " 次");
                }
            }
        }

        private void retryConnection() {
            if (userDisconnect || selectedDevice == null) return;
            connectSelectedDevice();
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt callbackGatt, int statusCode) {
            if (statusCode != BluetoothGatt.GATT_SUCCESS) {
                connectionFailure("gatt_service_discovery", "GATT 服务发现失败，状态码 " + statusCode);
                return;
            }
            BluetoothGattService service = callbackGatt.getService(CaoCaoProtocol.SERVICE_UUID);
            if (service == null) {
                connectionFailure("gatt_service_discovery", "未发现 ABF0 服务");
                return;
            }
            writeCharacteristic = service.getCharacteristic(CaoCaoProtocol.WRITE_UUID);
            notifyCharacteristic = service.getCharacteristic(CaoCaoProtocol.NOTIFY_UUID);
            if (writeCharacteristic == null || notifyCharacteristic == null) {
                connectionFailure("notification_subscription", "ABF1/ABF2 特征不完整");
                return;
            }
            try {
                if (!callbackGatt.setCharacteristicNotification(notifyCharacteristic, true)) {
                    connectionFailure("notification_subscription", "ABF2 本地通知启用失败");
                    return;
                }
                BluetoothGattDescriptor descriptor = notifyCharacteristic.getDescriptor(CaoCaoProtocol.CLIENT_CONFIG_UUID);
                if (descriptor == null) {
                    markConnected();
                    return;
                }
                boolean indicateOnly = (notifyCharacteristic.getProperties()
                        & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0
                        && (notifyCharacteristic.getProperties()
                        & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0;
                descriptor.setValue(indicateOnly
                        ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                        : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                if (!callbackGatt.writeDescriptor(descriptor)) {
                    connectionFailure("notification_subscription", "ABF2 CCCD 写入请求未接受");
                }
            } catch (SecurityException error) {
                connectionFailure("notification_subscription", "系统拒绝启用 ABF2 通知：" + error.getMessage());
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt callbackGatt, BluetoothGattDescriptor descriptor, int statusCode) {
            if (statusCode == BluetoothGatt.GATT_SUCCESS) markConnected();
            else connectionFailure("notification_subscription", "ABF2 通知启用失败，状态码 " + statusCode);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt callbackGatt, BluetoothGattCharacteristic characteristic, int statusCode) {
            if (!writeInFlight) return;
            writeInFlight = false;
            if (statusCode != BluetoothGatt.GATT_SUCCESS) {
                emitBleError("BLE 写入失败，状态码 " + statusCode);
                emitBleStatus(status("attempt_failed", "gatt_write", connectAttempt, MAX_CONNECT_ATTEMPTS,
                        "BLE 写入失败，状态码 " + statusCode));
            }
            drainWrites();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicChanged(BluetoothGatt callbackGatt, BluetoothGattCharacteristic characteristic) {
            emitData(characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt callbackGatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            emitData(value);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("曹操");
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        bluetoothAdapter = manager == null ? null : manager.getAdapter();
        bridge = new NativeBridge(this);
        webView = new WebView(this);
        configureWebView(webView);
        webView.addJavascriptInterface(bridge, "AndroidNative");
        setContentView(webView);
        webView.loadUrl("file:///android_asset/web/index.html");
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setAllowUniversalAccessFromFileURLs(false);
        }
        view.setBackgroundColor(0xffeff6f9);
    }

    void invokeJavascript(String function, String... rawArguments) {
        if (webView == null) return;
        StringBuilder script = new StringBuilder("window.").append(function).append('(');
        for (int index = 0; index < rawArguments.length; index++) {
            if (index > 0) script.append(',');
            script.append(rawArguments[index]);
        }
        script.append(')');
        runOnUiThread(() -> webView.evaluateJavascript(script.toString(), null));
    }

    void invokeJavascriptValue(String function, String value) {
        invokeJavascript(function, JSONObject.quote(value == null ? "" : value));
    }

    private void emitCandidates() {
        JSONArray candidates = new JSONArray();
        for (Map.Entry<String, BluetoothDevice> entry : discovered.entrySet()) {
            try {
                BluetoothDevice device = entry.getValue();
                String name = firstNonBlank(safeDeviceName(device), "BrainLume2.0C（ABF0 服务）");
                JSONObject item = new JSONObject();
                item.put("id", entry.getKey());
                item.put("name", name);
                item.put("service", CaoCaoProtocol.SERVICE_UUID.toString());
                candidates.put(item);
            } catch (Exception ignored) {
                // A device can disappear while the scan list is being redrawn.
            }
        }
        invokeJavascript("__androidBleCandidates", candidates.toString());
    }

    private void emitData(byte[] value) {
        if (value == null || value.length == 0) return;
        byte[] copy = java.util.Arrays.copyOf(value, value.length);
        if (isLikelyControlResponse(copy)) {
            // EEG 数据持续上报时，控制响应不能继续排在 WebView 队列末尾。
            // 先把已经积累的 EEG 字节交给 JS，再立即交付控制帧。
            mainHandler.post(() -> {
                flushRxBatchImmediately();
                emitDataToJavascript(copy);
            });
            return;
        }
        synchronized (rxLock) {
            rxBatch.write(copy, 0, copy.length);
            if (!rxFlushScheduled) {
                rxFlushScheduled = true;
                mainHandler.postDelayed(rxFlushRunnable, BLE_RX_FLUSH_INTERVAL_MS);
            }
        }
    }

    private boolean isLikelyControlResponse(byte[] value) {
        return value.length >= 4
                && (value[0] & 0xFF) == 0xAA
                && (value[1] & 0xFF) == 0x55
                && (value[3] & 0xFF) != 0x22;
    }

    private void emitDataToJavascript(byte[] value) {
        if (value == null || value.length == 0) return;
        invokeJavascriptValue("__androidBleData", Base64.encodeToString(value, Base64.NO_WRAP));
    }

    private void flushRxBatchImmediately() {
        mainHandler.removeCallbacks(rxFlushRunnable);
        flushRxBatch();
    }

    private void flushRxBatch() {
        byte[] value;
        synchronized (rxLock) {
            rxFlushScheduled = false;
            if (rxBatch.size() == 0) return;
            value = rxBatch.toByteArray();
            rxBatch.reset();
        }
        emitDataToJavascript(value);
    }

    private void markConnected() {
        bridgeConnected = true;
        startBleKeepAlive();
        emitBleStatus(status("connected", "notification_subscription", connectAttempt, MAX_CONNECT_ATTEMPTS, null));
        invokeJavascript("__androidBleConnected", JSONObject.quote(selectedName), JSONObject.quote(selectedDevice == null ? "" : selectedDevice.getAddress()));
        // 不要在 JS BrainLumeClient 完成连接前抢发状态查询。否则状态响应
        // 可能在 onData 监听器安装前到达，随后首条 F0 查询会被误报超时。
    }

    private void connectionFailure(String stage, String message) {
        bridgeConnected = false;
        closeGattOnly(gatt);
        if (!userDisconnect && selectedDevice != null && connectAttempt < MAX_CONNECT_ATTEMPTS) {
            emitBleStatus(status("attempt_failed", stage, connectAttempt, MAX_CONNECT_ATTEMPTS, message));
            mainHandler.postDelayed(this::connectSelectedDevice, CONNECT_RETRY_DELAY_MS);
        } else {
            stopBleKeepAlive();
            emitBleStatus(status("failed", stage, connectAttempt, MAX_CONNECT_ATTEMPTS, message));
            emitBleError(message);
        }
    }

    private void emitBleError(String message) {
        invokeJavascriptValue("__androidBleConnectFailed", message);
    }

    private void emitBleStatus(JSONObject detail) {
        invokeJavascript("__androidBleStatus", detail.toString());
    }

    private JSONObject status(String phase, String stage, int attempt, int maxAttempts, String error) {
        JSONObject value = new JSONObject();
        try {
            value.put("phase", phase);
            value.put("stage", stage);
            value.put("attempt", attempt);
            value.put("maxAttempts", maxAttempts);
            if (error != null) value.put("error", error);
        } catch (Exception ignored) {}
        return value;
    }

    void startBleScan() {
        if (!hasBlePermissions()) {
            pendingScan = true;
            requestBlePermissions();
            return;
        }
        if (bluetoothAdapter == null) {
            emitBleError("当前设备不支持蓝牙");
            return;
        }
        if (!bluetoothAdapter.isEnabled()) {
            emitBleError("请先打开系统蓝牙");
            return;
        }
        if (scanning) stopBleScan();
        scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner == null) {
            emitBleError("BLE 扫描器不可用");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            LocationManager location = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            if (location != null && !location.isLocationEnabled()) {
                emitBleError("Android 11 及以下还需要打开系统定位服务才能扫描 BLE");
                return;
            }
        }
        discovered.clear();
        try {
            ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            scanner.startScan(null, settings, scanCallback);
            scanning = true;
            emitBleStatus(status("scan_started", "device_scan", 1, MAX_CONNECT_ATTEMPTS, null));
            mainHandler.postDelayed(this::stopBleScan, SCAN_DURATION_MS);
        } catch (SecurityException error) {
            emitBleError("系统拒绝 BLE 扫描权限：" + error.getMessage());
        }
    }

    void stopBleScan() {
        if (!scanning) return;
        try {
            if (scanner != null && hasScanPermission()) scanner.stopScan(scanCallback);
        } catch (SecurityException ignored) {}
        scanning = false;
        emitCandidates();
    }

    void selectBleDevice(String id) {
        stopBleScan();
        if (id == null || id.trim().isEmpty()) {
            disconnectBle();
            return;
        }
        BluetoothDevice device = discovered.get(id);
        if (device == null) {
            emitBleError("未找到所选 BLE 设备，请重新扫描");
            return;
        }
        selectedDevice = device;
        selectedName = firstNonBlank(safeDeviceName(device), "BrainLume2.0C");
        userDisconnect = false;
        connectAttempt = 0;
        connectSelectedDevice();
    }

    private void connectSelectedDevice() {
        if (selectedDevice == null || userDisconnect || !hasConnectPermission()) return;
        closeGattOnly(gatt);
        writeCharacteristic = null;
        notifyCharacteristic = null;
        writeQueue.clear();
        writeInFlight = false;
        connectAttempt++;
        emitBleStatus(status("attempt_started", "gatt_connect", connectAttempt, MAX_CONNECT_ATTEMPTS, null));
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                gatt = selectedDevice.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            } else {
                gatt = selectedDevice.connectGatt(this, false, gattCallback);
            }
            if (gatt == null) connectionFailure("gatt_connect", "系统未返回 GATT 连接对象");
        } catch (SecurityException error) {
            connectionFailure("gatt_connect", "系统拒绝 BLE 连接权限：" + error.getMessage());
        }
    }

    String writeBase64(String encoded) {
        try {
            return send(Base64.decode(encoded == null ? "" : encoded, Base64.DEFAULT))
                    ? "{\"ok\":true}"
                    : "{\"ok\":false,\"error\":\"设备尚未完成 GATT 建链\"}";
        } catch (IllegalArgumentException error) {
            emitBleError("BLE 写入数据格式错误：" + error.getMessage());
            return "{\"ok\":false,\"error\":\"BLE 写入数据格式错误\"}";
        }
    }

    private boolean send(byte[] data) {
        if (data == null || data.length == 0) return false;
        if (!bridgeConnected || gatt == null || writeCharacteristic == null) {
            emitBleError("设备尚未完成 GATT 建链");
            return false;
        }
        writeQueue.add(data);
        drainWrites();
        return true;
    }

    private void drainWrites() {
        if (writeInFlight || writeQueue.isEmpty() || gatt == null || writeCharacteristic == null || !hasConnectPermission()) return;
        byte[] data = writeQueue.peek();
        int chunkLength = Math.min(BLE_WRITE_CHUNK_SIZE, data.length);
        byte[] chunk = java.util.Arrays.copyOfRange(data, 0, chunkLength);
        try {
            int properties = writeCharacteristic.getProperties();
            // 与桌面端 writeValueWithoutResponse 优先策略一致；只有固件未
            // 提供 PROPERTY_WRITE_NO_RESPONSE 时才退回有响应写入。
            boolean noResponse = (properties & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0;
            int writeType = noResponse
                    ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                    : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
            writeCharacteristic.setWriteType(writeType);
            writeCharacteristic.setValue(chunk);
            writeInFlight = true;
            boolean accepted = gatt.writeCharacteristic(writeCharacteristic);
            if (!accepted) {
                writeInFlight = false;
                emitBleError("BLE 写入请求未接受");
                return;
            }
            // ActionBus 是字节流，必须在 GATT 接受当前分片后再推进队列。
            // EEG 配置帧会按 20+10 字节发送，避免一次写入超过默认 ATT MTU。
            writeQueue.poll();
            if (chunkLength < data.length) {
                writeQueue.addFirst(java.util.Arrays.copyOfRange(data, chunkLength, data.length));
            }
        } catch (SecurityException error) {
            writeInFlight = false;
            emitBleError("BLE 写入权限失败：" + error.getMessage());
        }
    }

    void disconnectBle() {
        userDisconnect = true;
        selectedDevice = null;
        selectedName = "";
        bridgeConnected = false;
        stopBleKeepAlive();
        stopBleScan();
        if (gatt != null) {
            try {
                if (hasConnectPermission()) gatt.disconnect();
            } catch (SecurityException ignored) {}
            closeGattOnly(gatt);
        }
        writeCharacteristic = null;
        notifyCharacteristic = null;
        writeQueue.clear();
        writeInFlight = false;
        mainHandler.removeCallbacks(rxFlushRunnable);
        synchronized (rxLock) {
            rxFlushScheduled = false;
            rxBatch.reset();
        }
        invokeJavascript("__androidBleDisconnected", "{\"reason\":\"user\"}");
    }

    private void closeGattOnly(BluetoothGatt target) {
        if (target == null) return;
        try { target.close(); } catch (Exception ignored) {}
        if (gatt == target) gatt = null;
    }

    private void startBleKeepAlive() {
        Intent intent = new Intent(this, BleKeepAliveService.class);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
            else startService(intent);
        } catch (Exception error) {
            emitBleStatus(status("warning", "foreground_service", connectAttempt, MAX_CONNECT_ATTEMPTS,
                    "BLE 前台保活服务启动失败：" + error.getMessage()));
        }
    }

    private void stopBleKeepAlive() {
        try { stopService(new Intent(this, BleKeepAliveService.class)); }
        catch (Exception ignored) {}
    }

    private boolean hasBlePermissions() { return hasScanPermission() && hasConnectPermission(); }

    private boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestBlePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}, BLE_PERMISSION_REQUEST);
        } else {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, BLE_PERMISSION_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != BLE_PERMISSION_REQUEST) return;
        if (hasBlePermissions() && pendingScan) {
            pendingScan = false;
            startBleScan();
        } else if (!hasBlePermissions()) {
            pendingScan = false;
            emitBleError("未授予 BLE 权限，无法扫描或连接设备");
        }
    }

    private String safeDeviceName(BluetoothDevice device) {
        if (device == null || !hasConnectPermission()) return null;
        try { return device.getName(); } catch (SecurityException ignored) { return null; }
    }

    private String advertisedName(ScanResult result) {
        ScanRecord record = result == null ? null : result.getScanRecord();
        if (record == null) return null;
        String value = record.getDeviceName();
        return value == null || value.trim().isEmpty() ? null : value.trim();
    }

    private boolean matchesTarget(ScanResult result, String name) {
        if (name != null && (CaoCaoProtocol.DEVICE_NAME.equals(name) || name.startsWith("BrainLume"))) return true;
        ScanRecord record = result == null ? null : result.getScanRecord();
        if (record == null || record.getServiceUuids() == null) return false;
        for (ParcelUuid uuid : record.getServiceUuids()) {
            if (uuid != null && CaoCaoProtocol.SERVICE_UUID.equals(uuid.getUuid())) return true;
        }
        return false;
    }

    private static String firstNonBlank(String first, String second) {
        if (first != null && !first.trim().isEmpty()) return first.trim();
        if (second != null && !second.trim().isEmpty()) return second.trim();
        return null;
    }

    @Override
    protected void onDestroy() {
        // Activity/WebView 生命周期不等于用户主动断开。切后台、旋转或
        // 系统回收 WebView 时不能在这里关闭 GATT；显式断开只走 disconnectBle()。
        stopBleScan();
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** JavaScript bridge shared by the main and analysis Android activities. */
    public static final class NativeBridge {
        private static final String GITHUB_PREFS = "github_sync";
        private static final String GITHUB_KEY_ALIAS = "CaoCaoGitHubToken";
        private static final long GITHUB_CONTENT_LIMIT = 95L * 1024L * 1024L;
        private final Activity activity;
        private final AndroidFullActivity host;
        private final File dataRoot;
        private final File sessionsRoot;
        private final File logsRoot;
        private final Map<String, EdfWriter> writers = new HashMap<>();
        private final Map<String, JSONObject> sessionMetadata = new HashMap<>();
        private final Map<String, AndroidAnalysisEngine.Session> analyses = new HashMap<>();
        private SleepModelRunner sleepModelRunner;

        public NativeBridge(Activity activity) {
            this.activity = activity;
            this.host = activity instanceof AndroidFullActivity ? (AndroidFullActivity) activity : null;
            File documents = activity.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
            if (documents == null) documents = activity.getFilesDir();
            dataRoot = new File(documents, "BrainLume Desktop");
            sessionsRoot = new File(dataRoot, "sessions");
            logsRoot = new File(dataRoot, "logs");
            ensureDirectories();
        }

        private void ensureDirectories() {
            dataRoot.mkdirs();
            sessionsRoot.mkdirs();
            logsRoot.mkdirs();
        }

        @JavascriptInterface
        public String getLaunchMode() { return "normal"; }

        @JavascriptInterface
        public String getDebugRequest() { return "null"; }

        @JavascriptInterface
        public String sendDebugResult(String result) { return ok(); }

        @JavascriptInterface
        public String getPaths() {
            JSONObject value = new JSONObject();
            try {
                value.put("root", dataRoot.getAbsolutePath());
                value.put("dataRoot", dataRoot.getAbsolutePath());
                value.put("sessions", sessionsRoot.getAbsolutePath());
                value.put("logs", logsRoot.getAbsolutePath());
                value.put("plans", new File(dataRoot, "plans.json").getAbsolutePath());
            } catch (Exception ignored) {}
            return value.toString();
        }

        @JavascriptInterface
        public String loadPlans() {
            return readText(new File(dataRoot, "plans.json"), "[]");
        }

        @JavascriptInterface
        public String savePlans(String plans) {
            writeText(new File(dataRoot, "plans.json"), plans == null ? "[]" : plans);
            return ok();
        }

        @JavascriptInterface
        public synchronized String startSession(String metadataText) {
            try {
                JSONObject input = new JSONObject(metadataText == null ? "{}" : metadataText);
                String id = input.optString("id", "session_" + System.currentTimeMillis());
                String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                File directory = new File(sessionsRoot, stamp + "_" + safeFilePart(id));
                if (!directory.mkdirs() && !directory.isDirectory()) return error("无法创建采集记录目录");
                JSONObject metadata = new JSONObject(input.toString());
                metadata.put("id", id);
                metadata.put("directory", directory.getAbsolutePath());
                metadata.put("startedAt", nowIso());
                metadata.put("status", "recording");
                metadata.put("storageFormat", "EDF");
                metadata.put("rows", 0);
                EdfWriter writer = new EdfWriter(new File(directory, EdfWriter.newFileName()));
                writers.put(id, writer);
                sessionMetadata.put(id, metadata);
                writeText(new File(directory, "session.json"), metadata.toString(2));
                return metadata.toString();
            } catch (Exception error) {
                return error("创建 EDF 会话失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String appendSessionSamples(String id, String samplesText) {
            EdfWriter writer = writers.get(id);
            if (writer == null) return error("采集会话不存在或已结束：" + id);
            try {
                JSONArray samples = new JSONArray(samplesText == null ? "[]" : samplesText);
                for (int index = 0; index < samples.length(); index++) writer.append(samples.optDouble(index, Double.NaN));
                JSONObject metadata = sessionMetadata.get(id);
                if (metadata != null) metadata.put("rows", writer.getReceivedSamples());
                return okWith("rows", writer.getReceivedSamples());
            } catch (Exception error) {
                return error("EDF 写入失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String appendSessionEvent(String id, String recordText) {
            JSONObject metadata = sessionMetadata.get(id);
            File directory = metadata == null ? findSessionDirectory(id) : new File(metadata.optString("directory", ""));
            if (directory == null || !directory.isDirectory()) return error("采集会话目录不存在：" + id);
            File events = new File(directory, "events.jsonl");
            String record = recordText == null ? "{}" : recordText;
            appendLine(events, record);
            return ok();
        }

        @JavascriptInterface
        public synchronized String stopSession(String id, String status, String reason) {
            EdfWriter writer = writers.remove(id);
            JSONObject metadata = sessionMetadata.remove(id);
            try {
                if (writer != null) writer.finish();
                if (metadata == null) metadata = readSessionMetadata(id);
                if (metadata == null) return error("采集会话不存在：" + id);
                metadata.put("status", status == null || status.isEmpty() ? "completed" : status);
                if (reason != null && !reason.isEmpty()) metadata.put("stopReason", reason);
                if (writer != null) {
                    metadata.put("rows", writer.getReceivedSamples());
                    metadata.put("edfPath", new File(writer.getFile().getParentFile(), writer.getFile().getName().replace(".edf.partial", ".edf")).getAbsolutePath());
                }
                File directory = new File(metadata.optString("directory", ""));
                writeText(new File(directory, "session.json"), metadata.toString(2));
                return metadata.toString();
            } catch (Exception error) {
                return error("关闭 EDF 会话失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String listSessions() {
            JSONArray result = new JSONArray();
            File[] entries = sessionsRoot.listFiles(File::isDirectory);
            if (entries == null) return result.toString();
            for (File directory : entries) {
                String text = readText(new File(directory, "session.json"), null);
                if (text == null) continue;
                try { result.put(new JSONObject(text)); } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public synchronized String loadSessionStagingHistory(String id) {
            JSONObject result = new JSONObject();
            JSONArray history = new JSONArray();
            File directory = findSessionDirectory(id);
            if (directory != null) {
                File staging = new File(directory, "online_staging.jsonl");
                String text = readText(staging, "");
                for (String line : text.split("\\R")) {
                    if (line.trim().isEmpty()) continue;
                    try { history.put(new JSONObject(line)); } catch (Exception ignored) {}
                }
            }
            try {
                result.put("sessionId", id);
                result.put("history", history);
                result.put("count", history.length());
            } catch (Exception ignored) {}
            return result.toString();
        }

        @JavascriptInterface
        public String openAnalysisWindow(String sessionId) {
            Intent intent = new Intent(activity, AndroidAnalysisActivity.class);
            intent.putExtra("sessionId", sessionId == null ? "" : sessionId);
            activity.startActivity(intent);
            return ok();
        }

        @JavascriptInterface
        public String closeAnalysisWindow() { return ok(); }

        @JavascriptInterface
        public synchronized String openAnalysis(String sessionId) {
            try {
                File directory = findSessionDirectory(sessionId);
                if (directory == null) return error("未找到指定采集会话：" + sessionId);
                AndroidAnalysisEngine.Session analysis = AndroidAnalysisEngine.Session.open(directory, sessionId);
                String analysisId = "android-analysis-" + sessionId;
                analyses.put(analysisId, analysis);
                JSONObject result = analysis.summary(true, true);
                result.put("analysisId", analysisId);
                return result.toString();
            } catch (Exception error) {
                return error("Android 离线分析失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String requestAnalysisViewport(String request) {
            try {
                JSONObject input = new JSONObject(request == null ? "{}" : request);
                AndroidAnalysisEngine.Session analysis = analyses.get(input.optString("analysisId", ""));
                if (analysis == null) return error("Android 分析会话不存在或已关闭");
                return analysis.viewport(input.optString("source", "filtered"), input.optInt("startSample", 0),
                        input.optInt("endSample", 1), input.optInt("pixelWidth", 900)).toString();
            } catch (Exception error) {
                return error("Android 波形视窗失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String requestAnalysisSpectrogram(String request) {
            try {
                JSONObject input = new JSONObject(request == null ? "{}" : request);
                AndroidAnalysisEngine.Session analysis = analyses.get(input.optString("analysisId", ""));
                if (analysis == null) return error("Android 分析会话不存在或已关闭");
                return analysis.spectrogram(input.optString("source", "filtered"), input.optDouble("windowSeconds", 2),
                        input.optDouble("maxHz", 45), input.optInt("maxTimeBins", 720)).toString();
            } catch (Exception error) {
                return error("Android 时频分析失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String updateAnalysisSegments(String id, String segments) {
            try {
                AndroidAnalysisEngine.Session analysis = analyses.get(id);
                if (analysis == null) return error("Android 分析会话不存在或已关闭");
                return analysis.updateSegments(new JSONArray(segments == null ? "[]" : segments)).toString();
            } catch (Exception error) {
                return error("Android 刺激阶段重算失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String exportAnalysisReport(String id) {
            try {
                AndroidAnalysisEngine.Session analysis = analyses.get(id);
                if (analysis == null) return error("Android 分析会话不存在或已关闭");
                File directory = new File(dataRoot, "analysis/" + safeFilePart(id));
                return analysis.exportReport(directory).toString();
            } catch (Exception error) {
                return error("Android 分析报告导出失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public String runYasaStaging(String id) { return error("Android 不直接运行 Python YASA，请在 Upper 桌面版复核"); }

        @JavascriptInterface
        public synchronized String closeAnalysis(String id) {
            analyses.remove(id);
            return ok();
        }

        @JavascriptInterface
        public synchronized String getSleepModelInfo() {
            try {
                if (sleepModelRunner == null) sleepModelRunner = new SleepModelRunner(activity);
                return sleepModelRunner.info().toString();
            } catch (Exception error) {
                return error("Android 睡眠模型加载失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String inferSleepStage(String payload) {
            try {
                if (sleepModelRunner == null) sleepModelRunner = new SleepModelRunner(activity);
                return sleepModelRunner.infer(new JSONObject(payload == null ? "{}" : payload)).toString();
            } catch (Exception error) {
                return error("Android 睡眠模型推理失败：" + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String getGithubSyncConfig() {
            return githubPublicState().toString();
        }

        @JavascriptInterface
        public synchronized String saveGithubSyncConfig(String input) {
            try {
                JSONObject request = new JSONObject(input == null ? "{}" : input);
                JSONObject source = request.optJSONObject("config");
                if (source == null) source = request;
                String repository = source.optString("repository", "").trim();
                if (!repository.matches("^[^/\\s]+/[^/\\s]+$")) return error("GitHub 仓库必须写成 owner/repository");
                String branch = source.optString("branch", "main").trim();
                String directory = source.optString("directory", "data/edf").trim();
                if (branch.isEmpty()) branch = "main";
                if (directory.isEmpty()) directory = "data/edf";
                if (directory.startsWith("/") || directory.contains("..")) return error("GitHub 归档目录不合法");
                JSONObject config = new JSONObject();
                config.put("repository", repository);
                config.put("branch", branch);
                config.put("directory", directory.replaceAll("/+", "/").replaceAll("^/|/$", ""));
                config.put("autoUploadStimulated", source.optBoolean("autoUploadStimulated", false));
                SharedPreferences preferences = githubPreferences();
                SharedPreferences.Editor editor = preferences.edit().putString("config", config.toString());
                String token = request.optString("token", "").trim();
                if (request.optBoolean("clearToken", false)) editor.remove("token_cipher");
                if (!token.isEmpty()) editor.putString("token_cipher", encryptGithubToken(token));
                editor.apply();
                return githubPublicState().toString();
            } catch (Exception error) {
                return error("保存 GitHub 设置失败：" + safeError(error));
            }
        }

        @JavascriptInterface
        public synchronized String testGithubSync() {
            try {
                JSONObject config = githubConfig();
                String token = decryptGithubToken(githubPreferences().getString("token_cipher", ""));
                if (token.isEmpty()) return error("尚未配置 GitHub 令牌");
                JSONObject repository = new JSONObject(githubRequest("repos/" + config.optString("repository"), "GET", token, null));
                JSONObject result = githubPublicState();
                result.put("repository", config.optString("repository"));
                result.put("private", repository.optBoolean("private", false));
                result.put("defaultBranch", repository.optString("default_branch", config.optString("branch")));
                JSONObject permissions = repository.optJSONObject("permissions");
                if (permissions != null) {
                    JSONObject publicPermissions = new JSONObject();
                    publicPermissions.put("push", permissions.optBoolean("push", false));
                    publicPermissions.put("maintain", permissions.optBoolean("maintain", false));
                    result.put("permissions", publicPermissions);
                }
                result.put("message", repository.optBoolean("private", false)
                        ? "GitHub 私有仓库连接正常，可归档 EDF"
                        : "连接成功，但目标仓库不是私有仓库；为保护原始 EEG，上传将被拒绝");
                return result.toString();
            } catch (Exception error) {
                return error("GitHub 连接失败：" + safeError(error));
            }
        }

        @JavascriptInterface
        public synchronized String getGithubHistoryCandidates() { return githubHistoryCandidates().toString(); }

        @JavascriptInterface
        public synchronized String uploadGithubHistory(String input) {
            try {
                JSONObject request = new JSONObject(input == null ? "{}" : input);
                JSONArray candidates = githubHistoryCandidates();
                java.util.HashSet<String> requested = new java.util.HashSet<>();
                JSONArray requestedIds = request.optJSONArray("sessionIds");
                if (requestedIds != null) {
                    for (int index = 0; index < requestedIds.length(); index++) requested.add(requestedIds.optString(index));
                }
                JSONArray statuses = new JSONArray();
                for (int index = 0; index < candidates.length(); index++) {
                    JSONObject candidate = candidates.getJSONObject(index);
                    if (requestedIds != null && !requested.contains(candidate.optString("id"))) continue;
                    if (requestedIds == null && candidate.optBoolean("alreadyUploaded", false)) continue;
                    JSONObject status = uploadSession(candidate.optString("id"));
                    JSONObject item = new JSONObject();
                    item.put("sessionId", candidate.optString("id"));
                    item.put("status", status);
                    statuses.put(item);
                }
                JSONObject result = githubPublicState();
                result.put("selectedCount", statuses.length());
                result.put("statuses", statuses);
                result.put("candidates", githubHistoryCandidates());
                return result.toString();
            } catch (Exception error) {
                return error("GitHub 历史归档失败：" + safeError(error));
            }
        }

        @JavascriptInterface
        public synchronized String retryGithubUploads() {
            try {
                JSONArray candidates = githubHistoryCandidates();
                JSONArray statuses = new JSONArray();
                for (int index = 0; index < candidates.length(); index++) {
                    JSONObject candidate = candidates.getJSONObject(index);
                    if (candidate.optBoolean("alreadyUploaded", false)) continue;
                    JSONObject item = new JSONObject();
                    item.put("sessionId", candidate.optString("id"));
                    item.put("status", uploadSession(candidate.optString("id")));
                    statuses.put(item);
                }
                JSONObject result = githubPublicState();
                result.put("selectedCount", statuses.length());
                result.put("statuses", statuses);
                result.put("candidates", githubHistoryCandidates());
                return result.toString();
            } catch (Exception error) {
                return error("重试 GitHub 归档失败：" + safeError(error));
            }
        }

        @JavascriptInterface
        public synchronized String uploadSessionToGithub(String id) {
            try { return uploadSession(id).toString(); }
            catch (Exception error) { return error("GitHub 归档失败：" + safeError(error)); }
        }

        @JavascriptInterface
        public String appendAppEvent(String recordText) {
            String day = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            appendLine(new File(logsRoot, day + ".jsonl"), recordText == null ? "{}" : recordText);
            return ok();
        }

        @JavascriptInterface
        public String revealPath(String path) {
            if (path == null || path.trim().isEmpty()) return ok();
            try {
                File target = new File(path).getCanonicalFile();
                if (!target.exists()) return error("文件不存在：" + path);
                if (!isUnderDataRoot(target)) return error("只能分享应用数据目录中的文件");
                if (target.isDirectory()) target = zipDirectory(target);
                Uri uri = new Uri.Builder().scheme("content").authority(activity.getPackageName() + ".files")
                        .appendQueryParameter("path", target.getAbsolutePath()).build();
                Intent intent = new Intent(Intent.ACTION_SEND);
                String mimeType = activity.getContentResolver().getType(uri);
                intent.setType(mimeType == null ? "application/octet-stream" : mimeType);
                intent.putExtra(Intent.EXTRA_STREAM, uri);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(Intent.createChooser(intent, "分享文件"));
                return okWith("path", target.getAbsolutePath());
            } catch (Exception error) {
                return error("分享文件失败：" + safeError(error));
            }
        }

        @JavascriptInterface
        public String saveScreenshot(String pageTitle) {
            try {
                View view = activity.getWindow().getDecorView();
                if (view.getWidth() <= 0 || view.getHeight() <= 0) return error("当前页面尚未完成布局，无法截图");
                Bitmap bitmap = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
                view.draw(new Canvas(bitmap));
                File directory = new File(dataRoot, "screenshots");
                directory.mkdirs();
                File output = new File(directory, System.currentTimeMillis() + "-" + safeFilePart(pageTitle) + ".png");
                try (FileOutputStream stream = new FileOutputStream(output)) {
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) return error("PNG 截图编码失败");
                } finally {
                    bitmap.recycle();
                }
                return okWith("path", output.getAbsolutePath());
            } catch (Exception error) {
                return error("保存截图失败：" + safeError(error));
            }
        }

        @JavascriptInterface
        public String completeDiagnostic(String report) {
            try {
                JSONObject payload;
                try { payload = new JSONObject(report == null ? "{}" : report); }
                catch (Exception ignored) { payload = new JSONObject().put("raw", report == null ? "" : report); }
                payload.put("savedAt", nowIso());
                File output = new File(logsRoot, "diagnostic-" + System.currentTimeMillis() + ".json");
                writeText(output, payload.toString(2));
                return okWith("path", output.getAbsolutePath());
            } catch (Exception error) {
                return error("保存设备诊断失败：" + safeError(error));
            }
        }

        @JavascriptInterface
        public void startScan() { if (host != null) host.startBleScan(); }

        @JavascriptInterface
        public void selectBleDevice(String id) { if (host != null) host.selectBleDevice(id); }

        @JavascriptInterface
        public String writeBase64(String payload) {
            return host == null ? error("Android BLE 主页面不可用") : host.writeBase64(payload);
        }

        @JavascriptInterface
        public void disconnect() { if (host != null) host.disconnectBle(); }

        private SharedPreferences githubPreferences() {
            return activity.getSharedPreferences(GITHUB_PREFS, Context.MODE_PRIVATE);
        }

        private JSONObject defaultGithubConfig() {
            JSONObject config = new JSONObject();
            try {
                config.put("repository", "Jaycob-jh/EEG_tls_Upper");
                config.put("branch", "main");
                config.put("directory", "data/edf");
                config.put("autoUploadStimulated", false);
            } catch (Exception ignored) {}
            return config;
        }

        private JSONObject githubConfig() {
            String raw = githubPreferences().getString("config", "");
            try {
                JSONObject value = raw == null || raw.trim().isEmpty() ? defaultGithubConfig() : new JSONObject(raw);
                if (!value.has("repository")) value.put("repository", "Jaycob-jh/EEG_tls_Upper");
                if (!value.has("branch")) value.put("branch", "main");
                if (!value.has("directory")) value.put("directory", "data/edf");
                if (!value.has("autoUploadStimulated")) value.put("autoUploadStimulated", false);
                return value;
            } catch (Exception ignored) {
                return defaultGithubConfig();
            }
        }

        private JSONObject githubPublicState() {
            JSONObject result = new JSONObject();
            try {
                result.put("config", githubConfig());
                String cipher = githubPreferences().getString("token_cipher", "");
                result.put("tokenStored", !cipher.isEmpty() && !decryptGithubToken(cipher).isEmpty());
                result.put("encryptionAvailable", canUseKeystore());
                JSONArray queue = new JSONArray();
                JSONArray candidates = githubHistoryCandidates();
                for (int index = 0; index < candidates.length(); index++) {
                    JSONObject candidate = candidates.getJSONObject(index);
                    if (candidate.optBoolean("alreadyUploaded", false)) continue;
                    JSONObject item = new JSONObject();
                    item.put("sessionId", candidate.optString("id"));
                    item.put("status", "queued");
                    item.put("files", candidate.optBoolean("hasEvents", false) ? "EDF+events" : "EDF");
                    queue.put(item);
                }
                result.put("queue", queue);
            } catch (Exception ignored) {
                try { result.put("config", defaultGithubConfig()).put("queue", new JSONArray()); }
                catch (Exception ignoredAgain) {}
            }
            return result;
        }

        private JSONArray githubHistoryCandidates() {
            JSONArray result = new JSONArray();
            File[] entries = sessionsRoot.listFiles(File::isDirectory);
            if (entries == null) return result;
            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            JSONObject config = githubConfig();
            for (File directory : entries) {
                JSONObject metadata = readSessionMetadataFrom(directory);
                if (metadata == null || "recording".equals(metadata.optString("status"))) continue;
                String id = metadata.optString("id", "");
                String startedAt = metadata.optString("startedAt", "");
                if (id.isEmpty() || startedAt.length() < 10) continue;
                String date = startedAt.substring(0, 10);
                if (date.compareTo(today) >= 0) continue;
                File edf = sessionEdfFile(directory, metadata);
                if (edf == null || !edf.isFile() || edf.length() <= 0) continue;
                File events = new File(directory, "events.jsonl");
                boolean hasEvents = events.isFile() && events.length() > 0 && events.length() <= GITHUB_CONTENT_LIMIT;
                JSONObject archive = githubArchivePaths(metadata, config);
                boolean alreadyUploaded = githubUploadHasFile(metadata.optJSONObject("githubUpload"), "edf", archive.optString("edf"))
                        && (!hasEvents || githubUploadHasFile(metadata.optJSONObject("githubUpload"), "events", archive.optString("events")));
                try {
                    JSONObject candidate = new JSONObject();
                    candidate.put("id", id);
                    candidate.put("startedAt", startedAt);
                    String endedAt = metadata.optString("endedAt", "");
                    candidate.put("endedAt", endedAt.isEmpty() ? JSONObject.NULL : endedAt);
                    candidate.put("date", date);
                    candidate.put("status", metadata.optString("status", "unknown"));
                    candidate.put("rows", metadata.optInt("rows", 0));
                    candidate.put("edfBytes", edf.length());
                    candidate.put("eventsBytes", hasEvents ? events.length() : JSONObject.NULL);
                    candidate.put("hasEvents", hasEvents);
                    candidate.put("alreadyUploaded", alreadyUploaded);
                    candidate.put("archivePaths", archive);
                    result.put(candidate);
                } catch (Exception ignored) {}
            }
            return result;
        }

        private File sessionEdfFile(File directory, JSONObject metadata) {
            String[] candidates = {
                    metadata.optString("edfPath", ""),
                    metadata.optString("dataFile", "")
            };
            for (String value : candidates) {
                if (value == null || value.trim().isEmpty()) continue;
                File candidate = new File(value);
                if (!candidate.isAbsolute()) candidate = new File(directory, value);
                try {
                    candidate = candidate.getCanonicalFile();
                    if (candidate.isFile() && candidate.getName().toLowerCase(Locale.ROOT).endsWith(".edf")
                            && candidate.getParentFile().getCanonicalPath().equals(directory.getCanonicalPath())) return candidate;
                } catch (IOException ignored) {}
            }
            File[] files = directory.listFiles((dir, name) -> name.toLowerCase(Locale.ROOT).endsWith(".edf"));
            if (files == null || files.length == 0) return null;
            return files[0];
        }

        private JSONObject githubArchivePaths(JSONObject metadata, JSONObject config) {
            JSONObject paths = new JSONObject();
            try {
                String directory = config.optString("directory", "data/edf").replaceAll("/+", "/").replaceAll("^/|/$", "");
                String date = metadata.optString("startedAt", "");
                date = date.length() >= 10 ? date.substring(0, 10) : "unknown-date";
                String id = safeFilePart(metadata.optString("id", "session"));
                String prefix = directory + "/" + date + "/" + id;
                paths.put("edf", prefix + ".edf");
                paths.put("events", prefix + ".events.jsonl");
            } catch (Exception ignored) {}
            return paths;
        }

        private boolean githubUploadHasFile(JSONObject upload, String kind, String archivePath) {
            if (upload == null || !"uploaded".equals(upload.optString("status"))) return false;
            if (archivePath.equals(upload.optString("path")) && "edf".equals(kind)) return true;
            JSONArray files = upload.optJSONArray("files");
            if (files == null) return false;
            for (int index = 0; index < files.length(); index++) {
                JSONObject file = files.optJSONObject(index);
                if (file != null && kind.equals(file.optString("kind")) && archivePath.equals(file.optString("path"))) return true;
            }
            return false;
        }

        private JSONObject uploadSession(String id) {
            File directory = findSessionDirectory(id);
            JSONObject metadata = directory == null ? null : readSessionMetadataFrom(directory);
            JSONObject status;
            if (directory == null || metadata == null) {
                return githubStatus("failed", "未找到指定采集会话");
            }
            String token = decryptGithubToken(githubPreferences().getString("token_cipher", ""));
            if (token.isEmpty()) {
                status = githubStatus("not_configured", "请先配置 GitHub 令牌并测试私有仓库");
                saveGithubUpload(directory, metadata, status);
                return status;
            }
            try {
                JSONObject config = githubConfig();
                JSONObject repository = new JSONObject(githubRequest("repos/" + config.optString("repository"), "GET", token, null));
                if (!repository.optBoolean("private", false)) {
                    status = githubStatus("failed", "目标仓库不是私有仓库，已拒绝上传原始 EEG");
                    saveGithubUpload(directory, metadata, status);
                    return status;
                }
                File edf = sessionEdfFile(directory, metadata);
                if (edf == null || !edf.isFile() || edf.length() <= 0) {
                    status = githubStatus("failed", "未找到已完成的 EDF 文件");
                    saveGithubUpload(directory, metadata, status);
                    return status;
                }
                JSONObject archive = githubArchivePaths(metadata, config);
                JSONArray files = new JSONArray();
                files.put(uploadGithubFile(edf, "edf", archive.optString("edf"), config, token));
                File events = new File(directory, "events.jsonl");
                if (events.isFile() && events.length() > 0) {
                    if (events.length() > GITHUB_CONTENT_LIMIT) throw new IOException("events 文件超过 GitHub Contents API 95 MB 限制");
                    files.put(uploadGithubFile(events, "events", archive.optString("events"), config, token));
                }
                status = githubStatus("uploaded", "EDF 已上传到私有 GitHub 仓库");
                status.put("repository", config.optString("repository"));
                status.put("branch", config.optString("branch", "main"));
                status.put("path", archive.optString("edf"));
                status.put("files", files);
                status.put("uploadedAt", nowIso());
            } catch (Exception error) {
                status = githubStatus("failed", safeError(error));
            }
            saveGithubUpload(directory, metadata, status);
            return status;
        }

        private void saveGithubUpload(File directory, JSONObject metadata, JSONObject status) {
            try {
                metadata.put("githubUpload", status);
                writeText(new File(directory, "session.json"), metadata.toString(2));
            } catch (Exception ignored) {}
        }

        private JSONObject githubStatus(String status, String message) {
            JSONObject result = new JSONObject();
            try {
                result.put("status", status);
                result.put("error", "failed".equals(status) ? message : JSONObject.NULL);
                result.put("message", message);
            } catch (Exception ignored) {}
            return result;
        }

        private JSONObject uploadGithubFile(File file, String kind, String archivePath, JSONObject config, String token) throws Exception {
            if (file.length() > GITHUB_CONTENT_LIMIT) throw new IOException(kind + " 文件超过 GitHub Contents API 95 MB 限制");
            if (file.length() <= 0) throw new IOException(kind + " 文件为空");
            String repository = config.optString("repository");
            String branch = config.optString("branch", "main");
            String contentPath = "repos/" + repository + "/contents/" + githubPath(archivePath);
            String sha = null;
            try {
                JSONObject existing = new JSONObject(githubRequest(contentPath + "?ref=" + Uri.encode(branch), "GET", token, null));
                sha = existing.optString("sha", null);
            } catch (GithubHttpException error) {
                if (error.statusCode != 404) throw error;
            }
            byte[] bytes = java.nio.file.Files.readAllBytes(file.toPath());
            JSONObject body = new JSONObject();
            body.put("message", "Archive EEG session " + file.getName());
            body.put("content", Base64.encodeToString(bytes, Base64.NO_WRAP));
            body.put("branch", branch);
            if (sha != null && !sha.isEmpty()) body.put("sha", sha);
            JSONObject response = new JSONObject(githubRequest(contentPath, "PUT", token, body.toString()));
            JSONObject result = new JSONObject();
            result.put("kind", kind);
            result.put("path", archivePath);
            result.put("bytes", file.length());
            result.put("url", response.optString("content", ""));
            return result;
        }

        private String githubRequest(String path, String method, String token, String body) throws Exception {
            HttpURLConnection connection = (HttpURLConnection) new URL("https://api.github.com/" + path).openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(60_000);
            connection.setDoInput(true);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            connection.setRequestProperty("User-Agent", "CaoCao-Android");
            if (token != null && !token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(payload.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(payload); }
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 200 && status < 400 ? connection.getInputStream() : connection.getErrorStream();
            String response = "";
            if (input != null) {
                try (java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
                    response = new String(output.toByteArray(), StandardCharsets.UTF_8);
                }
            }
            connection.disconnect();
            if (status < 200 || status >= 300) throw new GithubHttpException(status, "GitHub 请求失败（HTTP " + status + "）");
            return response;
        }

        private static String githubPath(String value) {
            StringBuilder result = new StringBuilder();
            for (String part : value.split("/")) {
                if (part.isEmpty()) continue;
                if (result.length() > 0) result.append('/');
                result.append(Uri.encode(part));
            }
            return result.toString();
        }

        private static final class GithubHttpException extends IOException {
            final int statusCode;
            GithubHttpException(int statusCode, String message) { super(message); this.statusCode = statusCode; }
        }

        private String encryptGithubToken(String token) throws Exception {
            if (!canUseKeystore()) throw new IllegalStateException("当前 Android 版本不支持安全令牌存储");
            SecretKey key = githubSecretKey(true);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        }

        private String decryptGithubToken(String ciphertext) {
            if (!canUseKeystore() || ciphertext == null || ciphertext.trim().isEmpty()) return "";
            try {
                String[] parts = ciphertext.split("\\.", 2);
                if (parts.length != 2) return "";
                SecretKey key = githubSecretKey(false);
                if (key == null) return "";
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)));
                return new String(cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT)), StandardCharsets.UTF_8);
            } catch (Exception ignored) { return ""; }
        }

        private SecretKey githubSecretKey(boolean create) throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (!store.containsAlias(GITHUB_KEY_ALIAS) && create) {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(GITHUB_KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .build());
                generator.generateKey();
            }
            if (!store.containsAlias(GITHUB_KEY_ALIAS)) return null;
            return ((KeyStore.SecretKeyEntry) store.getEntry(GITHUB_KEY_ALIAS, null)).getSecretKey();
        }

        private static boolean canUseKeystore() { return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M; }

        private boolean isUnderDataRoot(File target) {
            try {
                String root = dataRoot.getCanonicalPath();
                String path = target.getCanonicalPath();
                return path.equals(root) || path.startsWith(root + File.separator);
            } catch (IOException error) { return false; }
        }

        private File zipDirectory(File directory) throws IOException {
            if (directory.getCanonicalPath().equals(dataRoot.getCanonicalPath())) throw new IOException("不能分享整个应用数据根目录");
            File exports = new File(dataRoot, "exports");
            exports.mkdirs();
            File output = new File(exports, safeFilePart(directory.getName()) + "-" + System.currentTimeMillis() + ".zip");
            try (ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(output))) {
                zipDirectoryRecursive(directory, directory, zip);
            }
            return output;
        }

        private void zipDirectoryRecursive(File root, File current, ZipOutputStream zip) throws IOException {
            File[] children = current.listFiles();
            if (children == null) return;
            for (File child : children) {
                if (child.getName().endsWith(".zip") && child.getParentFile().getCanonicalPath().equals(new File(dataRoot, "exports").getCanonicalPath())) continue;
                String name = root.toPath().relativize(child.toPath()).toString().replace(File.separatorChar, '/')
                        + (child.isDirectory() ? "/" : "");
                if (child.isDirectory()) {
                    zip.putNextEntry(new ZipEntry(name));
                    zip.closeEntry();
                    zipDirectoryRecursive(root, child, zip);
                } else {
                    zip.putNextEntry(new ZipEntry(name));
                    try (FileInputStream input = new FileInputStream(child)) {
                        byte[] buffer = new byte[8192];
                        int count;
                        while ((count = input.read(buffer)) >= 0) zip.write(buffer, 0, count);
                    }
                    zip.closeEntry();
                }
            }
        }

        private static String safeError(Exception error) {
            String message = error == null ? "未知错误" : error.getMessage();
            return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message.replaceAll("[\\r\\n]+", " ");
        }

        private JSONObject readSessionMetadata(String id) {
            File directory = findSessionDirectory(id);
            if (directory == null) return null;
            String text = readText(new File(directory, "session.json"), null);
            if (text == null) return null;
            try { return new JSONObject(text); } catch (Exception error) { return null; }
        }

        private File findSessionDirectory(String id) {
            if (id == null || id.isEmpty()) return null;
            File[] entries = sessionsRoot.listFiles(File::isDirectory);
            if (entries == null) return null;
            for (File directory : entries) {
                JSONObject metadata = readSessionMetadataFrom(directory);
                if (metadata != null && id.equals(metadata.optString("id"))) return directory;
            }
            return null;
        }

        private JSONObject readSessionMetadataFrom(File directory) {
            String text = readText(new File(directory, "session.json"), null);
            if (text == null) return null;
            try { return new JSONObject(text); } catch (Exception error) { return null; }
        }

        private static String safeFilePart(String value) {
            return value.replaceAll("[^A-Za-z0-9._-]+", "_");
        }

        private static String nowIso() {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
            format.setTimeZone(TimeZone.getDefault());
            return format.format(new Date());
        }

        private static void appendLine(File file, String line) {
            file.getParentFile().mkdirs();
            try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8))) {
                writer.write(line);
                writer.newLine();
            } catch (IOException ignored) {}
        }

        private static String readText(File file, String fallback) {
            if (file == null || !file.isFile()) return fallback;
            try {
                byte[] bytes = java.nio.file.Files.readAllBytes(file.toPath());
                return new String(bytes, StandardCharsets.UTF_8);
            } catch (IOException error) { return fallback; }
        }

        private static void writeText(File file, String value) {
            file.getParentFile().mkdirs();
            try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file, false), StandardCharsets.UTF_8))) {
                writer.write(value == null ? "" : value);
            } catch (IOException ignored) {}
        }

        private static String ok() { return "{\"ok\":true}"; }

        private static String okWith(String key, int value) {
            JSONObject result = new JSONObject();
            try { result.put("ok", true); result.put(key, value); } catch (Exception ignored) {}
            return result.toString();
        }

        private static String okWith(String key, String value) {
            JSONObject result = new JSONObject();
            try { result.put("ok", true); result.put(key, value == null ? JSONObject.NULL : value); } catch (Exception ignored) {}
            return result.toString();
        }

        private static String error(String message) {
            JSONObject result = new JSONObject();
            try { result.put("ok", false); result.put("error", message == null ? "Android 操作失败" : message); } catch (Exception ignored) {}
            return result.toString();
        }
    }
}
