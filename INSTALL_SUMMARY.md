# 曹操（EEG_tls_Upper）安装与模块总结

## 1. 安装结论

项目已解压并完成本地安装，当前使用目录为：

```text
I:\光调控\闭环脑调控\EEG_tls_Upper
```

已验证的备份副本保留在：

```text
I:\Agents-workspace\Outputs\EEG_tls_Upper
```

已完成的安装内容包括：

- 解压原始工程文件 29 个。
- 按 `package-lock.json` 安装 Node.js 依赖。
- 补齐 Electron 43.3.0 Windows runtime，`electron.exe` 已存在。
- 生成 Electron 启动 smoke test 截图：`artifacts\smoke.png`。
- 初始化运行数据目录：`C:\Users\haijia\Documents\BrainLume Desktop\`。

原始压缩包 SHA-256：

```text
FB79007B100182207B1B964ABC67B59657A763A6C546B48698A87D095535337F
```

## 2. 环境与验证

| 项目 | 结果 |
|---|---|
| Node.js | `v24.14.0`，满足项目要求的 Node.js 20+ |
| npm | `11.9.0` |
| Electron | `43.3.0` |
| 静态语法检查 | `npm run check` 通过 |
| 自动化测试 | 20/20 通过 |
| Electron smoke test | 通过，成功生成截图 |
| 真实设备连接 | 未执行，避免未经用户确认控制 EEG/光刺激硬件 |

PowerShell 中建议使用以下命令启动：

```powershell
cd 'I:\Agents-workspace\Outputs\EEG_tls_Upper'
npm.cmd start
```

也可以双击项目中的 `start.bat`。首次使用需要在应用内连接名称严格匹配 `BrainLume2.0C` 的 BLE 设备。

## 3. 系统定位

曹操是面向 BrainLume2.0C 的 Windows 桌面上位机，采用 Electron + 原生 HTML/CSS/JavaScript，负责 BLE 连接、EEG 采集、光刺激控制、实验方案调度、数据记录和离线分析。

软件属于工程采集与设备控制工具，不提供医疗诊断或未经验证的睡眠分期结论。阻抗结果是当前硬件与接线条件下的工程估算，不应直接视为医疗级校准结果。

## 4. 功能模块

| 模块 | 主要内容 |
|---|---|
| 设备连接与发现 | Web Bluetooth；BLE GATT 使用 `ABF0/ABF1/ABF2`；通过 `F0/FE` 完成协议版本、设备信息、能力表和状态发现 |
| EEG 采集 | ADS1299 8 通道，支持 CH1–CH8，默认 CH2；默认采样率 250 SPS；解析 `0x22` 的 24-bit 原始数据 |
| EEG 实时显示 | 原始码转微伏；显示滤波为 `0.5–45 Hz` 带通和 `50 Hz` notch；界面保留最近 5000 点，CSV 不受显示窗口限制 |
| 阻抗检测 | 当前通道检测；1024 点窗口；使用 `brainlume-24na-v1` 板级预设和 7.8125 Hz Goertzel 估算流程；检测后恢复普通 EEG 配置 |
| 光刺激控制 | 支持光刺激 CH1/CH2；频率 1–100 Hz、功率 0–100%；支持有限时长和显式停止；配置、启动、停止带重试与状态确认 |
| 方案调度 | 支持每日定时方案和手动相对时间方案；动作包括阻抗检测、EEG 启停、光刺激启停、状态查询；包含动作配对和安全停止规则 |
| 原始数据与日志 | 会话 `session.json`、原始 `eeg_raw.csv`、事件 `events.jsonl`、全局日志、截图；采集中使用 `.partial` 文件，正常停止后改名 |
| 离线 EEG 分析 | 流式读取 CSV；零相位滤波、数据质量、30 秒 epoch、伪迹筛查、Welch 功率谱、Delta/Theta/Alpha/Beta/Gamma 频带和刺激前/中/后比较 |
| 分析报告 | 导出 PDF，并生成 `summary.json`、`epochs.csv`、`phase_metrics.csv` 及图像附件 |
| 工程调试 | 调试页面支持发现、状态、寄存器读取、EEG 配置、光刺激控制和协议事件；另有本地 CLI 调试入口 |
| 自动化测试 | Node.js 内置 test runner；覆盖协议 CRC、ADS1299 配置、错误码、数据解析、滤波、事件切段、方案调度和报告附件 |

## 5. 主要代码边界

| 文件 | 职责 |
|---|---|
| `main.js` | Electron 主进程、BLE 设备选择、文件访问、截图、PDF 和诊断模式 |
| `preload.js` | 受限 IPC 接口 |
| `src/app.js` | 页面状态、设备控制、方案调度、CSV 与日志编排 |
| `src/transport.js` | BLE GATT 连接、20 字节顺序分片和通知接收 |
| `src/vendor/BrainLume_Lib.js` | ActionBus、ADS1299、EEG 解码、滤波、频谱和阻抗算法 |
| `src/core.js` | 无 DOM 的方案校验、调度核心和 CSV 工具 |
| `analysis-worker.js` | 离线记录流式处理、滤波、epoch、Welch PSD 和阶段统计 |
| `src/analysis-core.js` | 离线分析核心算法 |
| `src/analysis-ui.js` | 分析页面交互和波形显示 |
| `src/analysis-report.js` | PDF 报告及可复算附件生成 |
| `debug-cli.js` / `src/debug.js` | 一次性设备调试命令和协议诊断 |
| `src/index.html` / `src/styles.css` | 设备、方案、记录、分析和调试页面及样式 |
| `test/*.test.js` | 自动化回归测试 |

## 6. 运行数据位置

程序运行时默认写入：

```text
C:\Users\haijia\Documents\BrainLume Desktop\
├─ plans.json
├─ logs\YYYY-MM-DD.jsonl
└─ sessions\{timestamp}_{sessionId}\
   ├─ session.json
   ├─ eeg_raw.csv
   └─ events.jsonl
```

本次 smoke test 已创建 `logs` 和 `sessions` 目录，但没有采集真实 EEG 数据。

## 7. 使用前的安全边界

- 真实采集前应确认伦理审批、知情同意、刺激参数和设备安全状态。
- 设备首次连接后，建议先执行设备发现、状态查询和寄存器读取，再进行 EEG 或光刺激操作。
- 不限时光刺激依赖后续显式停止命令；长时间实验必须确认固件断连保护、电脑供电、蓝牙稳定性和禁止休眠设置。
- 每次实机测试结束后执行应用内“全部停止”或相应的 `stop-all` 流程。
- 不应仅依据实时波形判断数据完整性，还需检查 CSV 行数和 `seq_gap`。
行数和 `seq_gap`。
