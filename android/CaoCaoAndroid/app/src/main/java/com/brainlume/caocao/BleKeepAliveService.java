package com.brainlume.caocao;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Raises the Android process priority while the Activity owns an active BLE
 * session. The GATT object remains in AndroidFullActivity for this migration;
 * this service only prevents the normal background priority drop. Explicit
 * disconnect stops the service.
 */
public final class BleKeepAliveService extends Service {
    private static final String CHANNEL_ID = "caocao_ble_connection";
    private static final int NOTIFICATION_ID = 4102;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "曹操 BLE 连接", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持 EEG 设备的 BLE 连接");
            manager.createNotificationChannel(channel);
        }
        promoteToForeground();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 不因任务界面进入后台而自动结束。用户点击“断开设备”时由 Activity
        // 显式 stopService；系统重建服务时也会重新进入前台状态。
        promoteToForeground();
        return START_STICKY;
    }

    private void promoteToForeground() {
        Intent openIntent = new Intent(this, AndroidFullActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openIntent, pendingFlags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification notification = builder
                .setSmallIcon(R.drawable.cao_cao_icon)
                .setContentTitle("曹操")
                .setContentText("BLE 连接保持中")
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
