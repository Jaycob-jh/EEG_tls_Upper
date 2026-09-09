# 曹操当前软件状态

更新日期：2026-08-07  
项目目录：`D:\AilongProject\EEG_tls_Upper`  
应用版本：`0.5.1`
SDK 版本：`1.0.3`  
当前基线：`v0.5.1`（Windows、macOS、Android 同步发布版本）

## 1. 软件定位

曹操是 BrainLume2.0C 的 Windows Electron 上位机，当前主要用于：

- BLE 连接与设备能力发现。
- ADS1299 CH1~CH8 配置，默认使用 CH2。
- EEG 启停、实时波形、原始数据保存和序号缺口统计。
- 当前通道阻抗检测。
- 两路光刺激配置、启动和停止。
- 光刺激配置/启停最多重试 3 次，启动和停止后通过 `0x01` 回读实际状态，所有尝试均记录日志。
- 每日定时与手动相对时间方案执行。
- 已记录 EEG 的离线波形、信号质量、频谱和光刺激阶段分析。
- PDF 报告与 JSON/CSV/PNG 可复算附件。
- 协议日志、会话事件日志、截图和本地设备调试。

软件属于工程采集与控制工具，不提供医疗诊断结论。

## 2. 技术组成

| 模块 | 当前实现 |
| --- | --- |
| 桌面框架 | Electron 43 + 原生 HTML/CSS/JavaScript |
| 运行环境 | Node.js 20+，当前已在 Node.js 22 验证 |
| BLE | Web Bluetooth，GATT `ABF0/ABF1/ABF2` |
| 设备协议 | ActionBus 3.0，默认设备地址 `0x01` |
| EEG ADC | ADS1299，8 通道，默认 250 SPS |
| 测试 | Node.js 内置 test runner |

主要代码边界：

- `main.js`：Electron 主进程、BLE 设备选择、文件和诊断模式。
- `preload.js`：受限 IPC 接口。
- `src/transport.js`：BLE GATT、20 字节顺序分片和通知接收。
- `src/vendor/BrainLume_Lib.js`：ActionBus、ADS1299、EEG 解码、滤波、频谱和阻抗算法。
- `src/app.js`：UI 状态、设备控制、方案调度、CSV 和日志编排。
- `analysis-worker.js`、`src/analysis-core.js`：离线 CSV、零相位滤波、epoch、Welch PSD 和刺激阶段统计。
- `src/analysis-ui.js`、`src/analysis-report.js`：交互波形与 PDF/附件内容。
- `debug-cli.js`、`src/debug.js`：一次性本地设备调试命令。

## 3. 设备通信

### BLE GATT

| 用途 | UUID |
| --- | --- |
| Service | `0000ABF0-0000-1000-8000-00805F9B34FB` |
| Write | `0000ABF1-0000-1000-8000-00805F9B34FB` |
| Notify | `0000ABF2-0000-1000-8000-00805F9B34FB` |

当前实机名称为 `BrainLume2.0C`。Web Bluetooth 的 `device.id` 可能在不同授权会话中变化，不能将其当作固定 MAC 地址。

### ActionBus

帧格式：

```text
AA 55 | Addr | Func | Stat | Len | Data[Len] | CRC_H | CRC_L
```

当前支持的主要功能码：

| Func | 功能 |
| --- | --- |
| `0x01` | 设备状态 |
| `0x02` | 设备指示灯开关：`Stat=0x11` 开启，`Stat=0x10` 关闭 |
| `0x10/0x11` | 光刺激 CH1/CH2 配置 |
| `0x12/0x13` | 光刺激 CH1/CH2 控制 |
| `0x20` | ADS1299 配置 |
| `0x21` | EEG 启停 |
| `0x22` | EEG 原始数据上报 |
| `0x23` | ADS1299 寄存器读取 |
| `0xF0/0xFE` | 协议和能力发现 |

所有普通请求通过单一串行队列发送。38 字节的 `0x20` 完整帧按 20 字节分片，等待每片写入完成后再发送下一片。

## 4. EEG 当前行为

- 默认通道为 CH2，可切换 CH1~CH8。
- 默认采样率为 250 SPS。
- `0x22` payload 按 29 字节解码，包括 seq、ADS 状态和 8 路 int24 原始码。
- 原始码按实际 PGA 转换为微伏。
- UI 波形最多保留最近 5000 点，CSV 不受该限制。
- 设备页按最近 2 秒窗口显示实时帧率，并累计序号断档次数、缺失帧数和丢帧率。
- 显示滤波链为 0.5Hz 高通、45Hz 低通和 50Hz notch。
- 开始 EEG 前先通过 `0x23` 回读关注寄存器；配置已一致时跳过重复 `0x20`，直接发送 `0x21`。

当前 CH2 普通配置：

```text
96 C0 EC 00 81 60 81 81 81 81 81 81 02 00 00 00
00 00 00 00 20 00 00 00 CF 80 63 80 03 00
```

寄存器比较只关注当前实际使用的可配置寄存器，不比较 ID、`LOFF_STATP`、`LOFF_STATN` 以及 `0x18..0x1E` 保留区域。

## 5. 阻抗检测

- 阻抗检测前必须停止普通 EEG。
- 使用 1024 点窗口和 `brainlume-24na-v1` 估算器。
- LOFF 目标值已由错误的 `0x50` 修正为 `0x05`，对应 SDK 当前解释的 24nA、7.8125Hz。
- 阻抗配置会进行关注寄存器回读比较。
- UI 中旧的 `compareEegConfig is not defined` 已修复，统一调用 `SDK.ads1299.compareAdsConfig()`。

阻抗结果仍属于工程估算。在实际激励电流、频率和硬件校准全部复核前，不应描述为医疗级或完全校准结果。

## 6. 光刺激和方案

- 支持 CH1/CH2，频率范围 1~100Hz，功率范围 0~100%。
- `durationMs > 0` 时由设备定时结束。
- `durationMs = 0` 表示不限时，方案当前允许使用。
- 每个 `light_start` 仍必须有同通道 `light_stop` 动作。
- 每日方案按本机时间执行；相对方案从主界面点击开始时计时，运行期间暂停每日方案。
- 启动动作允许 5 秒延迟；超过后明确中止当日方案并执行安全停止。停止动作不受延迟窗口限制，恢复后仍优先补发。
- EEG 启停和每路光刺激启停必须配对。

重要风险：不限时光刺激依赖后续显式停止命令。若 BLE 在停止时间前断开，上位机无法发送停止命令，必须依赖固件断连保护或人工停止设备。

## 7. 数据和日志

默认目录：

```text
C:\Users\Zephyr\Documents\BrainLume Desktop\
|-- plans.json
|-- logs\YYYY-MM-DD.jsonl
`-- sessions\{timestamp}_{sessionId}\
    |-- session.json
    |-- events.jsonl
    `-- eeg_raw.csv
```

新时间字段使用带时区偏移的本机 ISO 8601，例如 `2026-08-07T15:30:00.123+08:00`，无需人工换算。

CSV 每个有效 `0x22` 帧写入一行，包含：

- 会话、方案和设备标识。
- 当前 EEG 通道。
- 接收时间和单调时钟偏移。
- seq、seq gap 和 ADS 状态。
- `sample_index` 保存设备原始 seq，`row_index` 保存会话内本地连续行号。
- 原始 int24 码、原始微伏值和完整 payload。

已观察到一段 1 小时 28 分 41 秒的 CH2 会话记录 1,327,186 行，平均约 249.4 SPS。该会话因 BLE 断开而标记为 `interrupted`。

## 8. 错误处理和已修复问题

固件错误码映射已与当前协议同步：

| 错误码 | 含义 |
| --- | --- |
| `0x01` | Invalid parameter |
| `0x02` | Invalid length or payload |
| `0x03` | Not supported |
| `0x04` | Wrong state |
| `0x05` | Busy |
| `0x06` | Internal error |
| `0x07` | Permission denied |
| `0x08` | Timeout |
| `0x09` | CRC error |

已完成的关键修复：

- `0x06` 不再错误显示为 Buffer overflow。
- DeviceError 保留 Addr、Func、Stat、Len、Data 和原请求帧。
- 修正 ADS1299 保留寄存器 `0x1E` 目标值，配置尾部由 `...0303` 改为 `...0300`。
- 忽略只读、状态和保留寄存器的运行时差异，避免无意义地重复发送 `0x20`。
- 修复阻抗路径遗留的未定义比较函数。
- 方案光刺激时长允许为 0，负数仍被拒绝。

## 9. 本地调试接口

```powershell
npm run debug:device -- discover
npm run debug:device -- status
npm run debug:device -- read-registers
npm run debug:device -- config-eeg --channel 2
npm run debug:device -- start-eeg --channel 2 --seconds 3
npm run debug:device -- stop-all
npm run debug:device -- raw --addr 1 --func 0x01 --stat 0x10 --data ""
```

CLI 输出单行 JSON，包含命令、设备、TX/RX、错误上下文和耗时。CLI 只复用 Web Bluetooth 已授权设备，不主动弹出选择器。当前 Windows/Electron 环境曾出现授权列表为空的情况，此时返回 `NO_AUTHORIZED_DEVICE`。

另有 `npm run diagnose:device` 自动诊断模式，但 Windows BLE 可能返回 `Connection attempt failed` 或扫描不到候选，因此不能替代所有人工授权场景。

## 10. 当前验证状态

自动化验证：

```powershell
npm run check
npm test
```

当前结果：静态检查通过，自动化测试 50/50 通过；883,729 点真实会话约 4.8 秒完成离线分析。

实机已确认：

- 可以连接 `BrainLume2.0C`。
- F0/FE、状态读取、寄存器读取和光刺激控制曾成功执行。
- CH2 EEG 可达到约 250 SPS，并能保存大体量 CSV。
- 错误帧的 Func 和请求上下文能够写入全局日志。

仍需继续验证：

- `...0300` 修正后的 CH2 EEG 启动进行完整回归，确认不再触发 `Func=0x20, Error=0x06`。
- 阻抗配置和实际激励参数的硬件校准。
- BLE 长时间稳定性和自动重连策略。
- BLE 断开时固件是否立即关闭不限时光刺激和 EEG。
- 30 分钟以上连续 EEG 的 seq gap、CSV 行数和停止后 500ms 内无新增数据。

## 11. 安全与运维建议

- 不限时光刺激必须配置显式停止动作，且需要固件侧断连保护。
- 长时间方案执行期间应保持电脑供电、蓝牙稳定并禁止系统休眠。
- 遇到 `0x06` 时先确认错误帧 Func；只有 Func=`0x20` 才进入 ADS1299 写入/回读诊断。
- 每次实机测试结束执行 `stop-all` 或应用内“全部停止”。
- 不要只依据 UI 波形判断数据完整性，应同时检查 CSV 行数和 `seq_gap`。
