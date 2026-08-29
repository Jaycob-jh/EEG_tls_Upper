# 曹操 iPhone 客户端（个人长期 Ad Hoc）

这里是与 `EEG_tls_Upper` 共用 ActionBus 协议的 iOS 原生客户端骨架。它使用
SwiftUI + CoreBluetooth，固定 EEG 导联为 CH2（两枚互为参考电极的双极差分导联），
支持扫描/连接 BrainLume2.0C、状态/电量查询、CH2 EEG 启停、CH1 光刺激控制、实时波形查看，
并将手机端 CH2 原始 µV 写入 `Documents/CaoCao/*.edf`。

## 最简版入口

已提供可直接用 Xcode 打开的工程：`CaoCaoApp/CaoCaoLite.xcodeproj`。这个版本只保留
BLE 扫描/连接、状态/电量、CH2 EEG、CH1 基础光刺激、实时波形和 EDF 保存；方案管理、YASA
和睡眠在线分期继续留在桌面 Upper，不放进手机端，减少部署和实验风险。

## 当前交付边界

- `Sources/CaoCaoProtocol/CaoCaoProtocol.swift`：ActionBus 帧、CRC、ABF0/ABF1/ABF2、状态和 EEG 原始帧解码。
- `App/BluetoothManager.swift`：CoreBluetooth 扫描、连接、特征发现、分片通知解析、串行写入队列和 EDF 采集编排。
- `App/EdfWriter.swift`：固定 250 SPS、单信号 CH2 双极差分 EDF 写入器；末尾补齐点不计入真实样本数。
- `App/ContentView.swift`、`App/CaoCaoApp.swift`：可放入 Xcode iOS App target 的最小可用界面。
- `Resources/Info.plist`：蓝牙权限和 `bluetooth-central` 后台模式声明。
- `Resources/protocol-spec.json`：与桌面端协议常量的人工核对清单。

当前 Windows 工作站不能生成或签名 `.ipa`。因此这里交付的是可在 Apple Silicon Mac
上直接装入 Xcode 的客户端源文件和协议模块；最终 Ad Hoc archive 必须在你的 Mac/Xcode
上用你的 Apple Developer 账号签名。未在本机声称“已生成可安装 IPA”。

## 在 Apple Silicon Mac 上安装到 iPhone

1. 将整个 `iOS/CaoCaoApp` 文件夹复制到 Apple Silicon Mac，双击打开 `CaoCaoLite.xcodeproj`。
2. 在 target 的 Signing & Capabilities 中选择你的 Team，设置唯一 Bundle Identifier，
   添加 Background Modes 并勾选 “Uses Bluetooth LE accessories”。
3. 连接真实 iPhone，在系统中开启 Developer Mode，先点击 Xcode 的 Run，确认扫描、连接、状态回读和 CH2 EEG 数据。
4. 确认无误后按下面的 Ad Hoc 步骤导出长期安装包。

方案编辑、YASA 离线复核和完整睡眠闭环仍以桌面 Upper 为主；iPhone 客户端当前
定位为个人移动监看与基础设备控制端，避免在手机后台直接承担未经验证的 N3 自动发光。

## 长期 Ad Hoc 发布

长期个人使用应使用 Apple Developer Program 的付费团队账号：

1. 在 Apple Developer 账号中登记目标 iPhone 的 UDID。
2. 创建 App ID、Distribution Certificate 和包含该 iPhone 的 Ad Hoc provisioning profile。
3. Xcode 选择 `Product > Archive`，在 Organizer 中选择 `Distribute App > Ad Hoc`，导出签名后的 `.ipa`。
4. 用 Finder/Apple Configurator 安装到已登记的 iPhone。以后设备更换、UDID 变化或 profile 到期时重新生成并导出。

免费 Personal Team 的个人签名不等于长期 Ad Hoc，通常只能用于短期开发测试；不能把它当作长期部署方案。
Ad Hoc 的有效期、设备数量和签名状态以 Apple Developer 账号当前规则为准。

`bluetooth-central` 只声明系统允许的蓝牙后台唤醒能力，不保证 iOS 在后台持续运行高频采集或闭环控制。
正式实验建议保持前台、锁定刺激参数、保留桌面端 EDF 原始归档，并在真实设备上做断连/重连和安全停止测试。
