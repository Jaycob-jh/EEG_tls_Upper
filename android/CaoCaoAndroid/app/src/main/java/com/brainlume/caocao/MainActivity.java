package com.brainlume.caocao;

import android.Manifest;
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
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Android client entry point for BrainLume2.0C.
 *
 * The BLE/EDF path below is the first migrated device layer. The Android
 * feature-parity work is tracked in the project report; until the remaining
 * pages are wired, this class must not be described as a completed parity
 * release.
 */
public final class MainActivity extends Activity {
    private static final int PERMISSION_REQUEST = 31;
    private static final int SCAN_DURATION_MS = 12_000;
    private static final int LIGHT_CHANNEL = 1;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, BluetoothDevice> discovered = new LinkedHashMap<>();
    private final ArrayDeque<byte[]> writeQueue = new ArrayDeque<>();
    private final CaoCaoProtocol.Parser parser = new CaoCaoProtocol.Parser();

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic writeCharacteristic;
    private BluetoothGattCharacteristic notifyCharacteristic;
    private boolean writeInFlight;
    private boolean scanning;

    private LinearLayout deviceList;
    private TextView connectionView;
    private TextView batteryView;
    private TextView recordingView;
    private TextView waveformView;
    private TextView logView;
    private EdfWriter edfWriter;

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            String deviceName = safeName(device);
            String advertisedName = advertisedName(result);
            String name = firstNonBlank(deviceName, advertisedName);
            if (!matchesTarget(result, name)) return;
            String displayName = name == null ? "BrainLume2.0C（ABF0 服务）" : name;
            runOnUiThread(() -> addDevice(device, displayName));
        }

        @Override
        public void onScanFailed(int errorCode) {
            runOnUiThread(() -> showError("BLE 扫描失败，错误码 " + errorCode));
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt callbackGatt, int status, int newState) {
            if (newState == BluetoothGatt.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                gatt = callbackGatt;
                runOnUiThread(() -> {
                    connectionView.setText("已连接：正在发现 ABF0 服务");
                    appendLog("BLE 已连接，开始发现服务");
                });
                if (hasConnectPermission()) callbackGatt.discoverServices();
            } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                runOnUiThread(() -> {
                    connectionView.setText("未连接");
                    appendLog("BLE 已断开");
                    showError(status == BluetoothGatt.GATT_SUCCESS ? "设备已断开" : "BLE 连接失败，状态码 " + status);
                });
                finishRecording();
                closeGatt(callbackGatt);
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt callbackGatt, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                runOnUiThread(() -> showError("GATT 服务发现失败，状态码 " + status));
                return;
            }
            BluetoothGattService service = callbackGatt.getService(CaoCaoProtocol.SERVICE_UUID);
            if (service == null) {
                runOnUiThread(() -> showError("未发现 ABF0 服务"));
                return;
            }
            writeCharacteristic = service.getCharacteristic(CaoCaoProtocol.WRITE_UUID);
            notifyCharacteristic = service.getCharacteristic(CaoCaoProtocol.NOTIFY_UUID);
            if (writeCharacteristic == null || notifyCharacteristic == null) {
                runOnUiThread(() -> showError("ABF1/ABF2 特征不完整"));
                return;
            }
            if (!hasConnectPermission()) return;
            callbackGatt.setCharacteristicNotification(notifyCharacteristic, true);
            BluetoothGattDescriptor descriptor = notifyCharacteristic.getDescriptor(CaoCaoProtocol.CLIENT_CONFIG_UUID);
            if (descriptor == null) {
                send(CaoCaoProtocol.statusCommand());
                return;
            }
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            callbackGatt.writeDescriptor(descriptor);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt callbackGatt, BluetoothGattDescriptor descriptor, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                runOnUiThread(() -> {
                    connectionView.setText("已连接：通知已启用");
                    appendLog("ABF2 通知已启用，查询设备状态");
                });
                send(CaoCaoProtocol.statusCommand());
            } else {
                runOnUiThread(() -> showError("ABF2 通知启用失败，状态码 " + status));
            }
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt callbackGatt, BluetoothGattCharacteristic characteristic, int status) {
            writeInFlight = false;
            if (status != BluetoothGatt.GATT_SUCCESS) {
                runOnUiThread(() -> showError("BLE 写入失败，状态码 " + status));
            }
            drainWrites();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onCharacteristicChanged(BluetoothGatt callbackGatt, BluetoothGattCharacteristic characteristic) {
            consumeNotification(characteristic.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt callbackGatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            consumeNotification(value);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle("曹操 Android");
        setContentView(buildContentView());
        BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        bluetoothAdapter = manager == null ? null : manager.getAdapter();
        if (bluetoothAdapter == null) showError("当前设备不支持蓝牙");
    }

    private View buildContentView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(239, 246, 249));
        LinearLayout root = vertical(16);
        root.setPadding(28, 28, 28, 36);

        TextView eyebrow = text("CAOCAO · CLOSED-LOOP SLEEP EEG", 12, Color.rgb(0, 143, 120));
        eyebrow.setTypeface(null, 1);
        root.addView(eyebrow);
        TextView title = text("曹操", 30, Color.rgb(16, 38, 47));
        title.setTypeface(null, 1);
        root.addView(title);
        ImageView heroImage = new ImageView(this);
        heroImage.setImageResource(R.drawable.cao_cao_icon);
        heroImage.setContentDescription("曹操闭环睡眠脑电");
        heroImage.setScaleType(ImageView.ScaleType.CENTER_CROP);
        LinearLayout.LayoutParams heroParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(180));
        heroParams.setMargins(0, dp(8), 0, dp(8));
        root.addView(heroImage, heroParams);
        root.addView(text("BrainLume2.0C · 固定 CH2 双极差分 · Android 0.5.1", 14, Color.DKGRAY));

        connectionView = text("未连接", 17, Color.rgb(16, 38, 47));
        batteryView = text("电量：--%", 17, Color.rgb(16, 38, 47));
        recordingView = text("EDF：未采集", 14, Color.DKGRAY);
        waveformView = text("EEG：等待设备数据", 14, Color.DKGRAY);
        root.addView(card(connectionView, batteryView, recordingView, waveformView));

        Button scan = button("扫描 BrainLume2.0C");
        scan.setOnClickListener(v -> scan());
        root.addView(scan);
        root.addView(text("扫描结果（点击设备名称连接）", 14, Color.DKGRAY));
        deviceList = vertical(8);
        root.addView(deviceList);

        LinearLayout eegRow = horizontal();
        Button startEeg = button("启动 CH2 EEG");
        startEeg.setOnClickListener(v -> startEeg());
        Button stopEeg = button("停止 EEG");
        stopEeg.setOnClickListener(v -> stopEeg());
        eegRow.addView(startEeg, weightParams());
        eegRow.addView(stopEeg, weightParams());
        root.addView(eegRow);

        LinearLayout lightRow = horizontal();
        Button startLight = button("启动光刺激");
        startLight.setOnClickListener(v -> startLight());
        Button stopLight = button("停止光刺激");
        stopLight.setOnClickListener(v -> stopLight());
        lightRow.addView(startLight, weightParams());
        lightRow.addView(stopLight, weightParams());
        root.addView(lightRow);

        Button status = button("查询状态 / 电量");
        status.setOnClickListener(v -> send(CaoCaoProtocol.statusCommand()));
        root.addView(status);
        root.addView(text("运行日志", 16, Color.rgb(16, 38, 47)));
        logView = text("尚无日志", 13, Color.DKGRAY);
        logView.setGravity(Gravity.TOP | Gravity.START);
        root.addView(card(logView));

        scroll.addView(root);
        return scroll;
    }

    private void scan() {
        if (!hasBlePermissions()) {
            requestBlePermissions();
            return;
        }
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            showError("请先打开系统蓝牙");
            return;
        }
        if (scanning) stopScan();
        scanner = bluetoothAdapter.getBluetoothLeScanner();
        if (scanner == null) {
            showError("BLE 扫描器不可用");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            LocationManager locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            if (locationManager != null && !locationManager.isLocationEnabled()) {
                showError("Android 11 及以下还需要打开系统定位服务才能扫描 BLE");
                return;
            }
        }
        discovered.clear();
        deviceList.removeAllViews();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
        scanner.startScan(null, settings, scanCallback);
        scanning = true;
        connectionView.setText("正在扫描附近设备…");
        appendLog("开始扫描 BrainLume2.0C");
        mainHandler.postDelayed(this::stopScan, SCAN_DURATION_MS);
    }

    private void stopScan() {
        if (!scanning) return;
        if (scanner != null && hasScanPermission()) scanner.stopScan(scanCallback);
        scanning = false;
        if (discovered.isEmpty()) {
            connectionView.setText("扫描结束：未发现目标设备");
            appendLog("未发现目标设备：请断开其他手机/电脑连接后重试，并保持设备处于广播状态");
        }
        else connectionView.setText("扫描结束：发现 " + discovered.size() + " 台设备");
    }

    private void addDevice(BluetoothDevice device, String name) {
        if (discovered.containsKey(device.getAddress())) return;
        discovered.put(device.getAddress(), device);
        Button candidate = button(name + "\n" + device.getAddress());
        candidate.setAllCaps(false);
        candidate.setOnClickListener(v -> connect(device, name));
        deviceList.addView(candidate);
        appendLog("发现设备：" + name);
    }

    private void connect(BluetoothDevice device, String name) {
        stopScan();
        if (!hasConnectPermission()) {
            requestBlePermissions();
            return;
        }
        closeGatt(gatt);
        writeCharacteristic = null;
        notifyCharacteristic = null;
        connectionView.setText("连接中：" + name);
        try {
            gatt = device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException error) {
            showError("系统拒绝 BLE 连接权限：" + error.getMessage());
        }
    }

    private void startEeg() {
        if (gatt == null || writeCharacteristic == null) {
            showError("请先连接设备");
            return;
        }
        if (edfWriter == null) {
            try {
                File baseDirectory = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
                if (baseDirectory == null) baseDirectory = getFilesDir();
                File directory = new File(baseDirectory, "CaoCao");
                if (!directory.exists() && !directory.mkdirs()) throw new IOException("无法创建 EDF 目录");
                edfWriter = new EdfWriter(new File(directory, EdfWriter.newFileName()));
                recordingView.setText("EDF：正在保存到 " + directory.getAbsolutePath());
            } catch (IOException error) {
                showError("EDF 创建失败：" + error.getMessage());
                return;
            }
        }
        send(CaoCaoProtocol.configureCH2Command());
        send(CaoCaoProtocol.startEEGCommand());
        appendLog("已请求启动 CH2 EEG");
    }

    private void stopEeg() {
        send(CaoCaoProtocol.stopEEGCommand());
        finishRecording();
        appendLog("已请求停止 EEG");
    }

    private void startLight() {
        send(CaoCaoProtocol.setLightConfigCommand(LIGHT_CHANNEL, 10, 5));
        send(CaoCaoProtocol.startLightCommand(LIGHT_CHANNEL));
        appendLog("已请求启动基础光刺激：10 Hz / 5% / 通道 " + LIGHT_CHANNEL);
    }

    private void stopLight() {
        send(CaoCaoProtocol.stopLightCommand(LIGHT_CHANNEL));
        appendLog("已请求停止光刺激");
    }

    private void send(byte[] data) {
        if (gatt == null || writeCharacteristic == null) {
            showError("设备尚未完成 GATT 建链");
            return;
        }
        writeQueue.add(data);
        drainWrites();
    }

    private void drainWrites() {
        if (writeInFlight || writeQueue.isEmpty() || gatt == null || writeCharacteristic == null || !hasConnectPermission()) return;
        byte[] data = writeQueue.peek();
        try {
            writeCharacteristic.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            writeCharacteristic.setValue(data);
            writeInFlight = gatt.writeCharacteristic(writeCharacteristic);
            if (!writeInFlight) {
                writeQueue.poll();
                showError("BLE 写入请求未接受");
            }
        } catch (SecurityException error) {
            writeQueue.poll();
            showError("BLE 写入权限失败：" + error.getMessage());
        }
    }

    private void consumeNotification(byte[] data) {
        for (CaoCaoProtocol.ActionBusFrame frame : parser.append(data)) {
            if (frame.function == CaoCaoProtocol.STATUS) {
                CaoCaoProtocol.DeviceStatus status = CaoCaoProtocol.decodeStatus(frame.payload);
                if (status != null) updateStatus(status);
            } else if (frame.function == CaoCaoProtocol.EEG_RAW) {
                CaoCaoProtocol.EegFrame eeg = CaoCaoProtocol.decodeEeg(frame.payload);
                if (eeg != null && eeg.rawCodes.length >= CaoCaoProtocol.FIXED_EEG_CHANNEL) {
                    double microvolts = eeg.rawCodes[CaoCaoProtocol.FIXED_EEG_CHANNEL - 1] * 4.5 * 1_000_000.0 / (24.0 * 8_388_608.0);
                    try {
                        if (edfWriter != null) edfWriter.append(microvolts);
                        if (eeg.sequence % 25 == 0) {
                            final double value = microvolts;
                            final int samples = edfWriter == null ? 0 : edfWriter.getReceivedSamples();
                            runOnUiThread(() -> {
                                waveformView.setText(String.format(java.util.Locale.US, "EEG CH2：%.2f µV · seq %d", value, eeg.sequence));
                                if (edfWriter != null) recordingView.setText(String.format(java.util.Locale.US, "EDF：采集中 · %d samples", samples));
                            });
                        }
                    } catch (IOException error) {
                        runOnUiThread(() -> showError("EDF 写入失败：" + error.getMessage()));
                        finishRecording();
                    }
                }
            }
        }
    }

    private void updateStatus(CaoCaoProtocol.DeviceStatus status) {
        runOnUiThread(() -> {
            batteryView.setText("电量：" + status.batteryLevel + "%" + (status.charging ? " · 充电中" : ""));
            connectionView.setText(status.eegRunning ? "已连接 · EEG 运行中" : "已连接 · 待机");
            appendLog("状态回读：电量 " + status.batteryLevel + "% · EEG " + (status.eegRunning ? "运行" : "停止"));
        });
    }

    private void finishRecording() {
        if (edfWriter == null) return;
        try {
            File partial = edfWriter.getFile();
            edfWriter.finish();
            File finalFile = new File(partial.getParentFile(), partial.getName().replace(".edf.partial", ".edf"));
            runOnUiThread(() -> recordingView.setText("EDF：已保存 " + finalFile.getAbsolutePath()));
        } catch (IOException error) {
            runOnUiThread(() -> showError("EDF 关闭失败：" + error.getMessage()));
        } finally {
            edfWriter = null;
        }
    }

    private void requestBlePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(new String[] {
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT
            }, PERMISSION_REQUEST);
        } else {
            requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION }, PERMISSION_REQUEST);
        }
    }

    private boolean hasBlePermissions() {
        return hasScanPermission() && hasConnectPermission();
    }

    private boolean hasScanPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST && hasBlePermissions()) scan();
        else if (requestCode == PERMISSION_REQUEST) showError("未授予 BLE 权限，无法扫描或连接设备");
    }

    @Override
    protected void onDestroy() {
        stopScan();
        finishRecording();
        closeGatt(gatt);
        super.onDestroy();
    }

    private void closeGatt(BluetoothGatt target) {
        if (target == null) return;
        if (hasConnectPermission()) {
            try { target.disconnect(); } catch (SecurityException ignored) {}
        }
        target.close();
        if (gatt == target) gatt = null;
        writeCharacteristic = null;
        notifyCharacteristic = null;
        writeQueue.clear();
        writeInFlight = false;
    }

    private String safeName(BluetoothDevice device) {
        if (!hasConnectPermission()) return null;
        try { return device.getName(); } catch (SecurityException error) { return null; }
    }

    private String advertisedName(ScanResult result) {
        ScanRecord record = result == null ? null : result.getScanRecord();
        if (record == null) return null;
        String name = record.getDeviceName();
        return name == null || name.trim().isEmpty() ? null : name.trim();
    }

    private boolean matchesTarget(ScanResult result, String name) {
        if (name != null && (CaoCaoProtocol.DEVICE_NAME.equals(name) || name.startsWith("BrainLume"))) {
            return true;
        }
        ScanRecord record = result == null ? null : result.getScanRecord();
        if (record == null || record.getServiceUuids() == null) return false;
        for (ParcelUuid serviceUuid : record.getServiceUuids()) {
            if (serviceUuid != null && CaoCaoProtocol.SERVICE_UUID.equals(serviceUuid.getUuid())) return true;
        }
        return false;
    }

    private String firstNonBlank(String first, String second) {
        if (first != null && !first.trim().isEmpty()) return first.trim();
        if (second != null && !second.trim().isEmpty()) return second.trim();
        return null;
    }

    private void showError(String message) {
        if (message == null || message.trim().isEmpty()) return;
        runOnUiThread(() -> {
            appendLog("错误：" + message);
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
        });
    }

    private void appendLog(String message) {
        if (logView == null) return;
        String current = logView.getText().toString();
        if ("尚无日志".equals(current)) current = "";
        String[] lines = (current + (current.isEmpty() ? "" : "\n") + message).split("\n");
        StringBuilder bounded = new StringBuilder();
        int start = Math.max(0, lines.length - 12);
        for (int i = start; i < lines.length; i++) {
            if (bounded.length() > 0) bounded.append('\n');
            bounded.append(lines[i]);
        }
        logView.setText(bounded.length() == 0 ? "尚无日志" : bounded.toString());
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setPadding(0, 6, 0, 6);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private Button button(String label) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setMinHeight(52);
        return view;
    }

    private LinearLayout vertical(int spacing) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setDividerPadding(spacing);
        return layout;
    }

    private LinearLayout horizontal() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        return layout;
    }

    private LinearLayout.LayoutParams weightParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.setMargins(4, 4, 4, 4);
        return params;
    }

    private LinearLayout card(TextView... views) {
        LinearLayout layout = vertical(4);
        layout.setPadding(20, 14, 20, 14);
        layout.setBackgroundColor(Color.WHITE);
        for (TextView view : views) layout.addView(view);
        return layout;
    }
}
