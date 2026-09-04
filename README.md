# 曹操

曹操是面向 BrainLume2.0C 的专用电脑上位机。设备首页和所有采集/刺激方案固定使用
EEG CH2；工程调试页仍允许在 CH1~CH8 中选择测试通道。这里的 CH2 表示 ADS1299 的一条双极差分 EEG 导联，
由两枚互为参考的电极测量电位差，并不是只有一枚电极。应用覆盖 BLE 连接、设备能力发现、ADS1299 配置、脑电波形、
阻抗检测、两路光刺激、方案定时执行、完整原始 EDF 和操作日志。

## 当前版本

- 应用版本：`0.4.1`（本地候选版本，待确认后发布）
- BrainLume SDK：`1.0.3`
- 框架：Electron + 原生 HTML/CSS/JavaScript
- 桌面平台：Windows 10/11 x64、Apple Silicon macOS arm64

选择 Electron 是为了直接复用已经验证的 JavaScript SDK，并使用 Chromium Web Bluetooth
连接设备。协议和信号算法不重复实现，后续修复可从 SDK 明确同步。

## 功能

- BLE 只显示名称严格匹配 `BrainLume2.0C` 的设备，默认 GATT 为 `ABF0 / ABF1 / ABF2`。
- 主动关闭 BLE 设备选择框时仅记录“未选择设备”，不会误报为连接失败，也不会修改 Windows 蓝牙适配器或系统服务。
- Windows `gatt_connect` 使用同一已选设备的 6 次有界恢复和 1 秒线性退避；PowerShell 只负责源码启动，不参与 BLE 建链。
- `F0 + FE` 完整设备能力发现。
- 默认 CH2，可切换 CH1~CH8；切换时实际下发 `0x20`，不是只改变 UI。
- `0x22` EEG int24 解码、原始码转 uV、`0.5~45Hz + 50Hz notch` 显示滤波。
- 波形最多 30FPS，保留最近 5000 点；EDF 原始数据不受显示窗口限制。
- 设备页实时显示最近 2 秒接收帧率、序号断档次数、累计丢帧数和累计丢帧率。
- 当前通道阻抗检测，使用 1024 点窗口和显式 `brainlume-24na-v1` 板级预设。
- 光刺激通道 1/2 配置、启动和停止。
- 每日定时和手动相对时间方案：阻抗、EEG 启停、光刺激启停和状态查询。
- 光刺激配置、启动和停止最多尝试 3 次；启停后读取设备状态确认，所有尝试及错误写入会话日志。
- 方案入口已前移到设备首页；方案编辑器固定显示 CH2 双极差分导联，不能改为其他通道。
- 会话原始 EDF、事件 JSONL、全局应用日志、截图和记录目录入口；旧版 CSV 会话仍可读取。
- 设备状态连接后每 60 秒自动查询一次，并显示电量响应的最后更新时间；查询只经过当前 BrainLume GATT 会话。
- 主界面并排显示原始 EEG 与实时预处理 EEG；预处理视图仅用于观看，新会话的 EDF 始终保存选中通道的原始 µV，事件日志保存序列缺口和操作信息。
- 离线 EEG 分析：原始/零相位滤波波形、数据质量、30 秒 epoch、Welch 频谱和光刺激前/中/后对比。
- 可选 YASA 离线睡眠分期复核：读取已结束或 partial 会话，单独输出 30 秒 epoch 分期、阶段比例及与实时分期的描述性对照。
- 实时简单预处理与睡眠分期：显示通道 `0.5–45Hz + 50Hz notch`，模型输入使用训练一致滤波、250→100Hz、30 秒 epoch 和 21-epoch 时序；同时显示当前因果候选与训练一致中心验证输出，并提供 W/N1/N2/N3/REM 概率。
- 可选分期触发刺激协议：设备首页用控制方式下拉选择手动/方案、模型或两者，模型设置弹窗默认以“N3 实时触发”为入口；仅当前因果候选在完整、质量通过的 21 epoch 上可进入实验性闭环。N3 保留“实时候选概率达到阈值”和“保守后处理确认”两种依据，中心回顾输出与离线 YASA 永远只用于复核、不触发实时光刺激；设备状态回读、默认 shadow mode 和显式启用仍保留。
- 质量门限审计：`npm run audit:quality-thresholds -- --sessions-root <sessions> --json <audit.json> --md <audit.md>` 会对所有 EDF 会话按训练滤波后模型输入重算 epoch 振幅，给出 500 µV 与离线门限网格（含 50%–95% N3 概率网格）的研究性对照；没有独立人工伪迹/PSG 标签时，不自动修改实时门限。
- PDF 分析报告及 `summary.json`、`epochs.csv`、`phase_metrics.csv` 和报告图像附件。
- 记录页的“分析”在独立、非模态窗口中打开，主窗口仍可继续连接设备、采集和执行方案。
- 记录页支持 GitHub 私有仓库归档：实际发生光刺激且 EEG 记录正常停止、EDF 封存后，自动将该记录的 `eeg_raw.edf` 与对应 `events.jsonl` 放入上传队列；同一记录多次刺激仍只对应一个 EDF。
- 记录页的“同步前几天数据”只扫描今天以前、已经封存且存在 EDF 的记录；已有 `events.jsonl` 会和 EDF 一起上传，历史记录不会在软件启动时静默上传。
- 原生“文件”菜单提供打开数据/会话/日志目录、导出当前分析报告、保存当前窗口截图和退出。
- 工程调试页：发现、寄存器读取、配置下发、EEG 与光刺激控制、协议事件。
- 顶部工具栏支持设备指示灯开关，使用功能码 `0x02`：开启帧为 `AA 55 01 02 11 00 CRC`，关闭帧为 `AA 55 01 02 10 00 CRC`。

## 安装与运行

需要 Node.js 20 或更高版本：

```powershell
npm install
npm start
```

### GitHub 下载与运行（推荐）

GitHub 的 `Code → Download ZIP` 下载的是源码，不包含 `node_modules`、Electron 运行时或
`dist` 成品，因此体积较小，不能解压后直接双击运行。共创者按使用目的选择下面的路径：

| 用途 | 下载方式 | 运行方式 |
| --- | --- | --- |
| 直接使用 | GitHub `Releases` 中的 `CaoCao-windows-x64-*.zip` | 仅 Windows 10/11 x64：解压后运行 `曹操.exe` |
| 直接使用 | GitHub `Releases` 中的 `CaoCao-macos-arm64-*.zip` | 仅 Apple Silicon Mac：解压后将 `曹操.app` 移到“应用程序”，首次右键选择“打开” |
| 开发/共创 | `Code → Download ZIP` 或 `git clone` | 按下方对应系统安装依赖后运行源码 |

Windows 和 macOS 必须使用各自的 Release 成品，不能复制或共用 `node_modules`；
`onnxruntime-node` 和 Electron 均包含平台相关运行时。GitHub Actions 分别提供
`Build Windows x64` 和 `Build macOS arm64` 工作流，可将构建结果作为 Release 附件上传。

#### Windows 源码运行

需要 Node.js 20 或更高版本。在 PowerShell 中执行：

```powershell
npm.cmd ci
npm.cmd start
```

#### Apple Silicon macOS 源码运行

需要 Apple Silicon Mac 和 Node.js 20 或更高版本。在 Terminal 中执行：

```bash
npm ci
npm start
```

如果 macOS 从 GitHub 下载后出现 `node_modules/.bin/electron: Permission denied`，在项目根目录执行：

```bash
chmod +x node_modules/.bin/electron
chmod +x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
npm start
```

### 本地构建平台成品

日常使用建议优先下载 GitHub Release 成品。需要自行构建时，必须在目标平台执行对应命令；
当前打包脚本会按目标平台裁剪 `onnxruntime-node` 原生运行时，macOS arm64 构建会拒绝
在 Windows 或 Intel Mac 上执行。

```powershell
# Windows 10/11 x64
npm run package:win:x64
```

```bash
# 仅在 Apple Silicon Mac 上执行
npm run package:mac:arm64
```

输出目录默认是项目的 `dist`。也可以把输出放入交付目录：

```powershell
node scripts/package-release.js --platform win32 --arch x64 --out "I:\Agents-workspace\Outputs\EEG_tls_Upper\release"
```

Windows 当前使用按用户提供参考图重绘的高清曹操封面，并加入闭环睡眠 EEG 波形、反馈环和神经节点元素作为启动图与界面图标；macOS 打包仍额外嵌入现有 `.icns` 图标。重绘 PNG 和旧素材备份位于项目输出目录对应文件夹。
成品目录含 `build-manifest.json`，用于核对目标平台、架构和原生运行时裁剪结果。

如果当前网络无法直接下载 Electron 二进制，可以先设置镜像再安装：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
```

首次连接时 Windows 会显示 BLE 权限或设备选择。设备应提供：

| 类型 | UUID |
| --- | --- |
| Service | `0000ABF0-0000-1000-8000-00805F9B34FB` |
| Write | `0000ABF1-0000-1000-8000-00805F9B34FB` |
| Notify | `0000ABF2-0000-1000-8000-00805F9B34FB` |

## 数据目录

运行数据默认保存在 Windows“文档”目录：

```text
Documents/BrainLume Desktop/
├─ plans.json
├─ logs/YYYY-MM-DD.jsonl
└─ sessions/
   └─ {timestamp}_{sessionId}/
      ├─ session.json
      ├─ eeg_raw.edf
      └─ events.jsonl
```

### GitHub 数据归档

GitHub 归档默认使用 `Jaycob-jh/EEG_tls_Upper` 的 `main` 分支和 `data/edf/YYYY-MM-DD/` 目录。
应用只接受私有仓库，以避免原始 EEG 外泄；建议为原始数据单独建立私有仓库。需要具有该仓库
Contents 读写权限的 GitHub Personal Access Token，令牌只在保存时读取，并通过 macOS 钥匙串或
Windows DPAPI 加密保存，不写入项目文件、`session.json` 或 Git 历史。
如果本机已通过 GitHub CLI（`gh auth login`）登录，应用首次启动且尚未配置令牌时会尝试把该凭据
安全转存到应用的系统安全存储；未安装 `gh` 或未登录时仍可在记录页手动保存令牌。

新记录只有在真实设备光刺激产生 `light_started` 事件并完成 EEG 停止后才自动排队；仅配置光刺激、
shadow/验证模式记录或没有实际发光不会触发自动归档。上传是本地串行队列，网络中断、代理不可用、
令牌失效或仓库不是私有仓库时会保留失败状态，可在记录页测试连接或重试。选择“同步前几天数据”
后，应用会先列出今天以前可用的记录和 events 数量，再把用户确认的记录加入同一队列；不会上传
全局日志、方案文件或其他目录内容。

采集期间文件名为 `eeg_raw.edf.partial`；正常或受控停止后原子改名为 `eeg_raw.edf`。
EDF 以 1 秒数据记录保存选中通道的原始 EEG（250 Hz、µV）；为完成最后一个 EDF 数据记录而补齐的点数写入 `session.json` 的 `edfPaddedSamples`，不会计入 `rows`。
EDF 无法承载每个 BLE 帧的原始 payload 和序号，因此序列缺口写入 `events.jsonl` 的 `eeg_seq_gap` 事件；断点不会被静默当成连续采样。
所有新时间字段直接保存上位机本地 ISO 时间并带时区偏移，例如 `2026-08-07T15:30:00.123+08:00`；
旧版 UTC 时间仍可读取，不会批量改写历史数据。

## 离线数据分析

在“记录”页面点击某条记录后的“分析”，会打开独立的非模态分析窗口；主窗口仍可继续操作。分析由独立 Worker 读取 EDF；旧版会话回退读取 CSV，
完整记录不会进入 Renderer；百万点记录仍可缩放和切换原始/滤波波形。关闭分析窗口会释放对应 Worker。

- 普通滚轮以鼠标位置为中心缩放时间轴。
- `Ctrl + 滚轮` 缩放电压轴。
- 鼠标右键拖动平移时间和电压基线，双击恢复完整视图。
- 离线滤波为零相位 `0.5–45Hz` 带通和 `50Hz` 陷波，不修改原始 EDF/CSV。
- 光刺激区间优先由 `events.jsonl` 的实际启停事件生成；可在分析页修正或手工添加。
- 30 秒 epoch 的严重伪迹默认阈值为 1–99 百分位幅度范围 `>=150µV`。
- 频带采用 Delta、Theta、Alpha、Beta、Gamma，并单列 `39–41Hz` 刺激频带。

分析页还会从采集期间保存的在线分期事件中生成“在线 EEG 睡眠结构”：同一 epoch 的中心回顾与当前因果输出只保留一条（优先当前因果），统计 W/N1/N2/N3/REM 的 epoch 数、时长、占比、阶段转换、最长连续段、总睡眠时长、可评分 epoch 内睡眠效率和 WASO；N3 候选、确认、质量拒绝与 UNKNOWN 分开报告。该结构是在线模型输出的研究性摘要，不是 PSG 或 YASA 金标准。

“导出报告”生成 PDF 和同名 `_data` 目录。报告及分析结果只用于研究和数据质量评估，
不构成医疗诊断。

### YASA 离线分期复核

YASA 是独立于实时 Stage-1 ONNX 模型的离线复核算法。首次使用前，在项目根目录安装可选的
Python 依赖：

```powershell
py -3 -m pip install -r python\requirements-yasa.txt
```

在“记录”页面打开一条采集记录的独立分析窗口后，点击右上角“YASA 离线复核”。程序优先读取
`eeg_raw.edf`（或尚未结束的 `eeg_raw.edf.partial`），旧版会话回退读取 `eeg_raw.csv`；不修改原始文件；结果保存到该会话的
`analysis/yasa/yasa_summary.json` 和 `analysis/yasa/yasa_epochs.csv`。当前设备记录为一条双极 EEG 导联（两枚互为参考电极），
没有 EOG/EMG，因此 REM 和 N1 的结果只能作为研究性复核，不能作为人工 AASM 分期金标准。

## 实时睡眠分期

“实时分析”使用既有 Stage-1 CNN 的离线微调部署权重 `models/stage1_sleep.onnx`，其来源是
DOD-H 预训练 → wearable `fp1fp2` Stage-1 微调。Upper 运行时只执行 ONNX 推理，不进行在线学习或权重更新；
如需继续微调，应回到 CNN 实验中的 `best_model.gz`，不能把 Upper 的 ONNX/`.onnx.data` 当作常规训练 checkpoint。
输入为当前一条双极差分 EEG 导联：

1. 显示波形继续使用 `0.5–45Hz` 带通和 `50Hz` 陷波；睡眠模型单独使用训练端 `filter_base` 的 `0.4–18Hz` 带通及训练端陷波链，避免显示滤波器与模型训练输入不一致，并将设备的 µV 换算为模型训练使用的 mV。
2. 每 30 秒形成一个 epoch，执行平线和超幅质量检查，并从 250Hz 重采样至 100Hz（3000 点）。
3. 模型固定接收连续 21 个 epoch，并选择 21×5 模型输出的中心位置（第 11 个，index 10）作为训练一致的中心验证；同时将当前 epoch 放在 21-epoch 输入末端，形成无未来数据的当前因果候选（index 20）。后者与既有模型输入形状兼容，但没有经过独立因果训练和验证，仍是实验性、未验证候选，不能与中心输出混淆。
4. 当前因果候选从首个 30 秒 epoch 开始显示，但在收满约 10.5 分钟且 21 个 epoch 全部质量通过前不能进入闭环；中心验证则相对当前采集时间约延迟 5 分钟。包含序列缺口的 epoch 不进入有效上下文。
5. 两种输出都先对模型概率做指数平滑，再经过独立的 N3 保守后处理。后处理不修改原始概率：中心输出默认要求 N3 概率至少 0.92 且连续 2 个 epoch，因果输出默认要求至少 0.95 且连续 3 个 epoch；质量不合格、孤立 N3 或退出滞回期间，内部仍保持“不可评分/不可闭环”的安全结果，但界面会同时显示模型候选（例如“N3 候选”或“W（质量警告）”），而不是把所有情况都误称为 N3 被抑制或强制改成 N2。实时质量门控作用于训练滤波后的模型输入，默认绝对幅值门限为 500 µV，并忽略滤波器启动的前 5 秒，仅用于避免启动瞬态误报；500 µV 是当前设备链路的临时研究性起点，不是医学标准，也不是对 raw EDF 数值的直接判据；持续性振幅异常仍会拒绝。

分期触发协议只接受当前因果输出，并同时满足设备状态回读、质量、完整 21-epoch 上下文和协议连续命中条件；中心输出永远不直接触发刺激。目标分期可以多选 W/N1/N2/N3/REM：W、N1、N2、REM 使用当前因果模型候选和独立的通用置信度阈值；N3 在“实时模型触发设置”中保留两种触发依据：默认“实时候选概率达到阈值”，使用实时平滑概率中的 N3 候选及用户设定阈值；也可选择“保守后处理确认”，要求独立 N3 后处理先确认。两种模式都不修改或冒充在线分期统计结果；N3 保守确认置信度与其他分期置信度分别配置，避免阈值串用。

首次中心输出在收满 21 个有效 30 秒 epoch 后产生，之后每 30 秒更新；当前因果候选也按 30 秒更新。切换 EEG 通道、重新配置通道或关闭实时分析会清空两种输出的历史和平滑状态。
设备首页通过“控制方式”下拉选择 `手动 / 方案`、`模型判别` 或 `手动 / 方案 + 模型`，随后打开对应设置弹窗；模型模式的弹窗可启用分期触发刺激协议。“实时分期”页面只显示实时 EEG、概率、质量与历史，不重复放置触发设置。中心输出明确标记为仅显示/验证，不会触发光刺激；当前因果候选只有在完整且质量通过的 21 epoch 上，才会经过设备状态回读、目标分期、N3 概率/保守确认、阈值和连续命中门控。当前 85% 仅是临时研究性起始值，不是 PSG 校准阈值；可用 `audit:quality-thresholds` 在离线/验证模式比较 50%–95% 网格。默认仍是 shadow mode，仅记录命中；没有同步 PSG/人工标签和独立伪迹标注前，不应降低 85% 后直接用于真实发光。连续命中次数由用户设置：1 个 epoch 约 30 秒，2 个约 60 秒，依此类推；分期改变、质量不合格或概率不足会清零连续计数。该协议每次启动软件均保持关闭，需要连接设备并由用户重新启用。

注意：当前因果候选只是将现有中心模型用于无未来上下文的实验性运行，不能把它当作已经验证的在线准确率或临床分期。中心输出对应约 5 分钟前的目标 epoch，不能用来直接控制光刺激；该功能不构成医疗诊断。

当前模型元数据还显示其训练来源为 `fp1fp2` wearable EEG，并包含训练期标准化/谱图特征配置；
Upper 已复现模型输入的采样时间轴、训练滤波实现配置和中心输出位置，但单条双极导联没有 EOG/EMG，
且当前采集文件没有人工 AASM 标注。因此，回放得到的阶段分布只能用于输入兼容性检查，不能直接解释为
准确率或硬件结论；若仍缺少 N3，应进入人工标注和模型适配/微调流程。

## CH2 推荐配置

普通 EEG，寄存器 `0x01..0x1E`：

```text
96 C0 EC 00 81 60 81 81 81 81 81 81 02 00 00 00
00 00 00 00 20 00 00 00 CF 80 63 80 03 00
```

CH2 阻抗模式：

```text
96 C0 EC 05 81 60 81 81 81 81 81 81 00 02 00 02
00 00 00 00 20 00 00 00 CF 80 63 80 03 00
```

应用通过 SDK 的 `ads1299.createRecommendedConfig()` 生成配置。实际下发后建议在调试页读取
`0x23`，确认 ADS1299 寄存器与目标镜像一致。

普通 CH2 采集使用 `BIAS_SENSP=0x02` 将 CH2P 加入右腿驱动共模反馈。阻抗检测时
`BIAS_SENSP=0x00`，检测结束后无论成功、超时或失败都会恢复普通采集配置。

## 方案规则

1. 桌面程序必须运行且 BLE 已连接，方案才会执行。
2. 每个 EEG 开始必须有 EEG 停止。
3. 每路光刺激开始必须有同通道停止；`durationMs=0` 表示不限时，仍由显式停止动作结束。
4. 启动动作只允许最多 5 秒调度延迟；超过后明确跳过并中止该方案当天后续启动动作。
5. 所有动作串行执行，ActionBus 同一时刻只有一个等待响应的命令。
6. 断开设备或点击“全部停止”时，依次停止两路光刺激和 EEG，并关闭 EDF。
7. 每日方案按照上位机本地时钟自动执行；相对方案从主界面点击“开始方案”的瞬间作为第 0 分钟。
8. 相对方案运行时每日方案暂停；相对方案停止、完成或失败后恢复每日调度。
9. 每日方案也可在主界面选择“立即运行”；此操作仅按原动作间隔从当前时刻执行一次，不修改保存的每日时钟。
10. 同一时刻只运行一个手动方案，BLE 断开后方案立即终止且不会自动恢复。
11. 光刺激和 EEG 停止属于安全动作，即使因卡顿晚到也会补发；启动、停止及每次重试都有成功或错误日志。
12. 设备首页和方案动作固定使用 CH2 双极差分导联；其他通道仅保留给工程调试。

纯 EEG 采集可以建立为只含 `eeg_start` 和 `eeg_stop` 的方案（需要时可在前面加入 `impedance_check`），不需要配置 `light_start`/`light_stop`。如果需要按睡眠分期自动光刺激，不要把光刺激动作混入定时方案：在“睡眠分期实时触发设置”中选择 W/N1/N2/N3/REM 目标及对应门控，先用 shadow mode 验证，再由用户关闭验证模式并显式启用自动触发。当前新建方案模板默认只包含阻抗检查、EEG 开始和 EEG 停止。

设备首页将光刺激按控制方式集中管理：下拉选择 `手动 / 方案`、`模型判别` 或 `手动 / 方案 + 模型`，只显示一个当前模式卡片，并打开对应弹窗配置；模型弹窗支持多选 W/N1/N2/N3/REM 候选目标，其中 N3 使用专用概率/保守确认门控，其他分期使用独立通用置信度门控。手动/方案弹窗负责手动参数和已保存方案。方案管理（新建、编辑、启用/停用、删除）也通过手动/方案弹窗中的入口打开独立管理弹窗，不再占用设备首页底部。手动按钮和时间方案不再与模型入口互相隐藏；同一时刻若已有光刺激输出，其他来源会等待或被安全拦截。实时分期页只负责查看结果。摘要中的数值始终标注为触发阈值，不代表当前 epoch 的实际概率。分析窗口中的在线历史、中心回顾输出和 YASA 离线结果均为复核数据，不会发起实时光刺激；模型协议默认关闭且默认验证模式只记录、不发光，避免启动软件后意外刺激。

## iPhone 客户端

`iOS/` 目录提供 SwiftUI + CoreBluetooth 客户端骨架，支持个人设备的扫描、连接、状态/电量、
CH2 EEG 和基础光刺激控制。最终安装包采用长期个人 Ad Hoc 流程，不上架 App Store；由于 iOS
签名必须使用你的 Apple Developer 账号在 Apple Silicon Mac/Xcode 上完成，具体步骤见
[`iOS/README.md`](iOS/README.md)。

## 开发检查

```powershell
npm run check
npm test
```

## 本地设备调试 CLI

CLI 只复用当前 Electron 配置中已经授权、名称为 `BrainLume2.0C` 的设备，不会弹出蓝牙选择器：

```powershell
npm run debug:device -- discover
npm run debug:device -- status
npm run debug:device -- read-registers
npm run debug:device -- config-eeg --channel 2
npm run debug:device -- start-eeg --channel 2 --seconds 3
npm run debug:device -- stop-all
npm run debug:device -- raw --addr 1 --func 0x01 --stat 0x10 --data ""
```

每次调用输出一条 JSON 结果并退出。未授权设备时返回 `NO_AUTHORIZED_DEVICE`；先在正常界面连接一次设备后再执行 CLI。

测试覆盖 ActionBus、寄存器镜像、两类方案调度、离线零相位滤波、事件切段、波形 envelope、分析 Worker、报告附件、实时 epoch 管线和真实 ONNX 推理。`npm run audit:realtime-input` 和 `npm run audit:realtime-inference` 可对指定 CSV 做只读回放审计。

## 工程边界

- `src/vendor/BrainLume_Lib.js` 是协议与信号算法运行时，不包含 BLE 和文件写盘。
- `src/transport.js` 只负责 BLE GATT 和 20 字节顺序分片。
- `src/core.js` 是无 DOM 的方案校验与调度核心，可在 Node 中独立测试。
- `analysis-worker.js` 持有完整离线记录并执行滤波、epoch、Welch PSD 和阶段统计。
- `sleep-stage-worker.js` 在独立线程中运行 Stage-1 ONNX 睡眠分期模型。
- `src/realtime-sleep.js` 负责实时 epoch、质量检查、训练时间轴重采样和 21-epoch 中心输入组装；因果入口仅保留作诊断。
- `main.js` 负责受控会话访问、文件、截图、PDF 和 Electron BLE 设备选择。
- `src/app.js` 负责页面状态和业务编排，高频 EEG 不写逐帧协议日志。

本软件属于工程采集和设备控制工具，不提供医疗诊断结论。阻抗板级校准仅适用于当前硬件与接线。
