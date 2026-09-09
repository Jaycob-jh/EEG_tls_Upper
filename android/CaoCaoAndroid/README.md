# 曹操 Android v0.5.1（完整迁移版，真机验收中）

这是曹操 Android 客户端的迁移工程，使用 Java + Android BLE API，固定使用 CH2
双极差分 EEG 导联（两枚互为参考电极）。它与桌面 Upper、iOS 端共用
BrainLume2.0C 的 ActionBus 3.0 协议。

Android 端现在使用与 Windows/macOS Upper 相同的 Web UI，并将设备、EDF、离线分析、
方案和记录等边界迁入原生 Java。页面中的高清曹操主视觉已加入，不再只作为应用图标使用。
完整迁移范围见
`I:\Agents-workspace\Outputs\EEG_tls_Upper\ANDROID_FULL_PARITY_PLAN_20260909.md`。

## 当前支持

- 扫描并连接名称为 `BrainLume2.0C` 的 BLE 设备；
- 读取状态、电量、充电状态和 EEG/光刺激运行状态；
- 配置并启动/停止 CH2 EEG；
- 保存 CH2 原始数据为应用私有目录中的 EDF 文件；
- 提供基础光刺激控制（10 Hz、5% 功率、光通道 1），并保留停止与状态回读；
- 记录页、方案页和独立分析 Activity；方案默认固定 CH2；
- 原始/滤波波形视窗、Welch 频谱、短时傅里叶时频图、质量/epoch 摘要和 PDF/JSON 报告；
- 复用 `stage1_sleep.onnx` 的实时模型信息与推理桥接；
- 私有 GitHub EDF/events 归档：令牌使用 Android Keystore 加密，上传前拒绝公开仓库；
- 文件分享（目录自动打包 ZIP）、当前页面 PNG 截图和设备诊断 JSON。
- ABF1 写入会按特征属性优先使用无响应写入，并将 ActionBus 帧按 20 字节分片，
  与 Windows/macOS 的 Web Bluetooth 传输策略保持一致；ABF2 同时兼容 notify/indicate。
- 能力发现与 Windows/macOS 共用同一兼容规则：`F0/00` 版本响应必须有效；旧固件未提供
  Device ID、Action 目录、运行时间或总线地址时，界面显示“兼容模式”，不把 BLE 连接判为失败。
- 连接成功后启动低重要性前台服务，切后台时不因 Activity/WebView 生命周期主动关闭 GATT；
  用户点击“断开设备”时才停止保活服务。
- EEG 通知在 Android 原生侧按 20 ms 批量跨 WebView 转发；疑似控制响应优先交付，避免高频 EEG
  上报占满 WebView 主线程。该批量不修改、不丢弃原始 EEG 字节，只减少跨桥调用次数。

## 明确边界与尚待真机验收

- Python YASA 不在 Android 内嵌运行；Android 可导出 EDF/报告，YASA 仍在 Windows/macOS
  的 Python 环境运行并回读结果。不能把 Android 内置简化分析称为 YASA；
- 实时 W/N1/N2/N3/REM 模型输入和安全门控已迁移，模型由 Android ONNX Runtime 在本机推理；
  但真实设备上的长时间 BLE、EDF 样本数、断连恢复、模型耗时和光刺激状态回读仍需要 Android
  真机验证。当前只建议把手机模型用于影子/候选分期，不建议未经真机验收直接驱动真实光刺激；
- 自动光刺激默认保持验证/Shadow Mode。没有独立人工 PSG 标签、真机回归和明确授权前，
  不把模型命中直接用于真实睡眠闭环发光；
- 本机已删除为测试 Android 版临时安装的模拟器、AVD、系统镜像和 AEHD 驱动目录；
  Windows 虚拟机平台撤销已提交，重启后完成。Android 真机或你自己的 macOS 构建机不受影响。

## 在 Android Studio 中打开

1. 用 Android Studio 打开本目录 `android/CaoCaoAndroid`。
2. 在 `Settings > Build, Execution, Deployment > Build Tools > Gradle` 将 Gradle JDK
   选择为 Java 17；本机可选 `D:\Android\jdk-17`。命令行构建前设置
   `$env:JAVA_HOME = 'D:\Android\jdk-17'`。
3. 等待 Gradle Sync 完成；项目使用 Android Gradle Plugin、Java 17，最低 Android API 26。
4. 用 Android 12 或更高版本真机运行时，允许“附近设备”权限；Android 11 及以下允许定位权限。
5. 打开系统蓝牙，在应用内扫描并点击 `BrainLume2.0C` 设备连接。

## 构建

在 Android Studio 中点击 `Build > Make Project`，或在 Windows PowerShell 中执行：

```powershell
.\gradlew.bat :app:assembleDebug
```

首次构建会自动下载 Gradle 8.13。当前仓库只提交 Android 源工程，不提交 `build/`、APK、
签名文件或本机 `local.properties`。APK 输出在
`app/build/outputs/apk/debug/app-debug.apk`；发布版仍需你自己的签名配置。
正式实验前需要在真实 Android 设备上单独验证 BLE 扫描、连接、断连恢复、状态回读、EDF
样本数和光刺激安全停止；通过前不应把该客户端用于自动睡眠闭环发光。

## 扫描不到设备时

1. 在系统设置中给曹操授予“附近的设备”权限；Android 11 及以下还要授予定位权限，
   并打开系统定位服务。
2. 确认 BrainLume2.0C 没有同时连接到 Windows、macOS 或其他手机；设备一次通常只能
   保持一个中心设备连接。
3. 保持设备处于可广播状态，点击“扫描 BrainLume2.0C”重新扫描。Android 端现在同时
   读取系统缓存名称、广播包名称和 `ABF0` 服务；即使广播周期暂时没有名称，也会显示
   `BrainLume2.0C（ABF0 服务）` 供连接。
4. 如果仍无结果，先关闭其他上位机/手机的 BLE 页面，给设备断电重启后再扫描；日志中的
   “未发现目标设备”只表示本次扫描窗口没有收到匹配广播，不代表电量为 0 或 GATT
   服务损坏。
