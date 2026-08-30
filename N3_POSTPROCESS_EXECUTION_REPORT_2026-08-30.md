# 曹操 N3 睡眠分期后处理执行报告

日期：2026-08-30
项目：`/Users/haijia/Desktop/EEG_tls_Upper`
旧数据：`/Volumes/exchange/jh_test/sleep EEG/tLS_sleep`

## 1. 执行结论

已完成第一阶段的“旧设备回放验证 + 保守 N3 后处理接入”。当前版本会保留 Stage-1 原始概率，同时对 N3 增加质量拒识、概率门槛、连续 epoch 确认和退出滞回。它的目标是减少 N3 误报，不能在没有 PSG/专家标签的情况下宣称临床准确率提高。

旧数据可以用于跨设备兼容性和弱标签探索，但现有 `hypnogram_corrected.csv` 是 YASA 加自动规则修正，不是独立人工 AASM 金标准；旧库中还存在重复文件和不同条件目录的副本，因此本轮结果只作为工程决策依据。

## 2. 数据与回放

- 旧库发现约 861 个 EDF，包含 EEG 以及加速度计/陀螺仪信号；EEG 采样率为 250 Hz。
- 本轮选择 16 条带弱参考分期的基线记录，回放曹操当前相同的 `0.4–18 Hz + 训练陷波链 → 250/100 Hz → 30 秒 epoch → 21 epoch Stage-1` 链路，共 4,800 个 epoch。
- 中心输出优于因果输出；不同实验组和受试者差异很大，不能随机打散 epoch 进行训练或验收。
- 当前曹操离线 EDF 的量化分辨率约为 5.72 µV/码；这不会影响实时模型输入，但会限制后续基于 EDF 的慢波幅值验证。未来应保留高精度原始数据。

回放原始结果：[tls-replay-16x300.json](analysis/n3-postprocess/tls-replay-16x300.json)
回放评估结果：[tls-postprocess-evaluation.json](analysis/n3-postprocess/tls-postprocess-evaluation.json)

## 3. 回放结果（弱参考，仅用于比较方向）

| 输出 | 原有平滑 N3 精确率 / 召回率 / F1 | 后处理 N3 精确率 / 召回率 / F1 | 后处理覆盖率 |
|---|---:|---:|---:|
| 中心回顾 | 39.7% / 55.4% / 46.3% | 69.7% / 50.0% / 58.2% | 86.1% |
| 当前因果 | 34.8% / 57.7% / 43.4% | 80.7% / 48.5% / 60.6% | 85.3% |

后处理确实减少了与旧弱标签相比的 N3 过检，但代价是部分 epoch 变成“不可评分/待确认”。在 `810_*` 与 `1050_*` 条件间表现不一致，说明不能把阈值直接当成跨设备或临床通用参数。

对当前曹操会话 `20260830T013247_0800_session_ccebf65d-51c6-45a8-89a9-375f00512a34` 的历史事件重放也显示：中心输出原有 48 个 N3，后处理保留 32 个；因果输出原有 49 个 N3，但在默认 0.95 门槛下没有形成可信 N3，并有 63 个 epoch 被标为不可评分。这不是程序卡死，而是当前因果候选没有达到“可用于闭环”的保守证据标准；因此中心输出用于回顾性分期，因果输出暂时只用于实验性候选和安全门。

## 4. 已实施改动

- [`src/sleep-stage-postprocess.js`](src/sleep-stage-postprocess.js)：独立 N3 后处理器。
  - 中心默认 N3 概率 ≥ 0.92、连续 2 个 epoch。
  - 因果默认 N3 概率 ≥ 0.95、连续 3 个 epoch。
  - 退出概率默认 0.75，连续 2 个 epoch退出。
  - 质量不通过、孤立 N3、证据不足均不强制改成 N2，而是标为 `UNKNOWN/不可评分`。
  - 原始概率不被覆盖；支持显式 reset、中心/因果模式及可选慢波/delta证据。
- [`src/app.js`](src/app.js)：中心与因果链路分别维护后处理状态；在线历史和审计日志保存模型分期、后处理分期、N3 状态及原因。
- [`src/realtime-sleep.js`](src/realtime-sleep.js)：带后处理确认的 N3 不再被旧的固定 20% deltaRatio 二次覆盖；未接入后处理的旧调用仍保留兼容安全门。
- [`src/session-history.js`](src/session-history.js)、[`src/analysis-ui.js`](src/analysis-ui.js)：历史页面显示“不可评分”“N3 已确认/已抑制/待连续确认”等状态。
- [`src/index.html`](src/index.html)、[`README.md`](README.md)：明确区分模型输出、N3 后处理和旧 delta 兼容项，避免把 20% 当作 N3 分类标准。
- [`scripts/replay-sleep-staging.js`](scripts/replay-sleep-staging.js)、[`scripts/evaluate-n3-postprocess.js`](scripts/evaluate-n3-postprocess.js)：可重复的只读回放与评估工具，不修改旧 EDF。

## 5. 验证与运行

- `npm run check`：通过。
- `npm test`：90/90 通过。
- `npm run capture:smoke`：通过；macOS Electron 仅输出系统 task policy 警告，不影响退出码。
- `npm run package:mac`：通过，产物为 Apple Silicon：
  `dist/曹操-darwin-arm64/曹操.app`

首次运行新版时需要重启已打开的曹操窗口，确保加载新的 `sleep-stage-postprocess.js`；默认仍是验证模式，不会因为本次后处理自动发光。

## 6. 尚未宣称的内容与下一步

本阶段没有改变 Stage-1 模型权重，也没有用旧弱标签训练模型。下一阶段必须先完成：

1. 按 EDF 内容 hash 去重，并建立跨条件的匿名 participant ID。
2. 明确曹操 CH2 的电极位置和参考方式。
3. 用曹操同夜同步 PSG（EEG/EOG/下颏 EMG）或至少双专家盲法标签建立强参考集。
4. 按受试者分组做内部交叉验证和独立测试，重新校准 N3 阈值及 HMM/HSMM 转移参数。
5. 在至少 20 个有效夜晚以 shadow mode 验证误触发，再考虑主动光刺激。

在完成这些条件前，N3 后处理只应作为研究性质量门和减少误触发的工程措施，不应作为医疗诊断或正式睡眠分期结论。
