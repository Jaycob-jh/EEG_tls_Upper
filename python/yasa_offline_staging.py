#!/usr/bin/env python3
"""Run an independent YASA sleep-staging pass on one BrainLume session.

New sessions store the raw signal as EDF; older CSV sessions remain supported
as a compatibility fallback. Derived YASA outputs are written below the
session's analysis/yasa directory.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime
from collections import Counter
from pathlib import Path
from typing import Any


STAGE_ORDER = ("W", "N1", "N2", "N3", "REM")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def emit(payload: dict[str, Any], code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    return code


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BrainLume session offline YASA sleep staging")
    parser.add_argument("--session-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--age", type=float, default=None, help="Optional participant age in years")
    parser.add_argument("--male", choices=("true", "false"), default=None, help="Optional YASA metadata")
    return parser.parse_args()


def read_json(path: Path, fallback: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback


def normalize_stage(value: Any) -> str:
    stage = str(value)
    upper = stage.upper()
    if upper in ("R", "REM"):
        return "REM"
    if upper in ("W", "WAKE"):
        return "W"
    return upper


def load_signal(csv_path: Path, np: Any) -> tuple[Any, int]:
    values: list[float] = []
    invalid_rows = 0
    with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or "voltage_uv" not in reader.fieldnames:
            raise ValueError("CSV 中没有 voltage_uv 列")
        for row in reader:
            try:
                value = float(row.get("voltage_uv", ""))
            except (TypeError, ValueError):
                value = float("nan")
            if not np.isfinite(value):
                invalid_rows += 1
            values.append(value)

    if not values:
        raise ValueError("该会话没有可分析的 EEG 数据")

    signal = np.asarray(values, dtype="float64")
    finite = np.isfinite(signal)
    if not finite.all():
        if finite.sum() < max(1, int(signal.size * 0.95)):
            raise ValueError(f"CSV 中无效 EEG 行过多：{invalid_rows} / {signal.size}")
        indices = np.arange(signal.size)
        signal[~finite] = np.interp(indices[~finite], indices[finite], signal[finite])
    return signal, invalid_rows


def load_signal_from_edf(edf_path: Path, mne: Any, np: Any) -> tuple[Any, Any, float]:
    """Read the selected raw EEG channel from EDF without changing the file."""
    raw = mne.io.read_raw_edf(str(edf_path), preload=True, verbose="ERROR")
    if not raw.ch_names:
        raise ValueError("EDF 中没有 EEG 通道")
    signal_uv = np.asarray(raw.get_data(picks=[0])[0], dtype="float64") * 1e6
    sample_rate_hz = float(raw.info["sfreq"])
    if signal_uv.size == 0 or not np.isfinite(sample_rate_hz) or sample_rate_hz <= 0:
        raise ValueError("EDF 中没有有效 EEG 数据或采样率无效")
    return signal_uv, raw, sample_rate_hz


def read_realtime_stages(events_path: Path) -> dict[int, str]:
    stages: dict[int, str] = {}
    if not events_path.exists():
        return stages
    with events_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("action") != "sleep_stage_inferred" or event.get('inferenceMode') != 'center':
                continue
            try:
                epoch_index = int(event["epochIndex"])
            except (KeyError, TypeError, ValueError):
                continue
            stages[epoch_index] = normalize_stage(event.get("stage", ""))
    return stages


def run() -> int:
    args = parse_args()
    session_dir = args.session_dir.resolve()
    output_dir = args.output_dir.resolve()
    if not session_dir.is_dir():
        return emit({"ok": False, "error": f"会话目录不存在：{session_dir}"}, 2)
    metadata_path = session_dir / "session.json"
    edf_path = session_dir / "eeg_raw.edf"
    if not edf_path.exists():
        edf_path = session_dir / "eeg_raw.edf.partial"
    csv_path = session_dir / "eeg_raw.csv"
    if not csv_path.exists():
        csv_path = session_dir / "eeg_raw.csv.partial"
    if not edf_path.exists() and not csv_path.exists() and not (session_dir / 'raw_adc.bin').exists() and not (session_dir / 'raw_adc.bin.partial').exists():
        return emit({"ok": False, "error": "会话中没有 eeg_raw.edf、eeg_raw.edf.partial 或旧版 CSV"}, 2)

    try:
        import numpy as np
        import mne
        import yasa
    except ModuleNotFoundError as exc:
        requirements = Path(__file__).with_name("requirements-yasa.txt").resolve()
        project_root = Path(__file__).resolve().parents[1]
        python_name = "Scripts/python.exe" if sys.platform == "win32" else "bin/python"
        project_python = project_root / ".venv-yasa" / python_name
        return emit({
            "ok": False,
            "error": (
                f"缺少 Python 依赖：{exc.name}。请先安装项目专用环境："
                f"\"{project_python}\" -m pip install -r \"{requirements}\""
            ),
        }, 2)

    try:
        metadata = read_json(metadata_path, {}) or {}
        sample_rate_hz = float(metadata.get("sampleRateHz") or 250)
        if sample_rate_hz <= 0:
            raise ValueError("session.json 中的 sampleRateHz 无效")
        invalid_rows = 0
        raw_path = session_dir / 'raw_adc.bin'
        if not raw_path.exists():
            raw_path = session_dir / 'raw_adc.bin.partial'
        if metadata.get('rawDataFile') == 'raw_adc.bin':
            if not raw_path.exists() or raw_path.stat().st_size % 16:
                raise ValueError('完整精度原始记录缺失或截断，不能静默退回有损 EDF')
            dtype = np.dtype([('code','<i4'),('seq','<u2'),('reserved','<u2'),('elapsed_ms','<f8')])
            records = np.fromfile(raw_path, dtype=dtype)
            if not records.size or np.any(records['code'] < -8388608) or np.any(records['code'] > 8388607):
                raise ValueError('原始 ADC 数据无效')
            scale = metadata.get('adcScale') or {'vrefVolts':4.5,'gain':24}
            signal_uv = records['code'].astype('float64') * float(scale['vrefVolts']) * 1e6 / (float(scale['gain']) * 8388608)
            info = mne.create_info(ch_names=['EEG'],sfreq=sample_rate_hz,ch_types=['eeg'])
            raw = mne.io.RawArray((signal_uv*1e-6).reshape(1,-1), info, verbose='ERROR')
            source_path = raw_path
        elif edf_path.exists():
            signal_uv, raw, sample_rate_hz = load_signal_from_edf(edf_path, mne, np)
            # EDF pads its final data record; those zeros were never acquired.
            if isinstance(metadata.get('rows'), int):
                count = min(max(0, metadata['rows']), len(signal_uv))
                if count < sample_rate_hz * 30:
                    raise ValueError('实际采集数据不足 30 秒')
                signal_uv = signal_uv[:count]
                raw.crop(tmax=(count - 1) / sample_rate_hz)
            source_path = edf_path
        else:
            signal_uv, invalid_rows = load_signal(csv_path, np)
            source_path = csv_path
            # BrainLume CSV is stored in microvolts; MNE/YASA consume volts.
            info = mne.create_info(ch_names=["EEG"], sfreq=sample_rate_hz, ch_types=["eeg"])
            raw = mne.io.RawArray((signal_uv * 1e-6).reshape(1, -1), info, verbose="ERROR")
        yasa_metadata: dict[str, Any] = {}
        if args.age is not None:
            yasa_metadata["age"] = args.age
        if args.male is not None:
            yasa_metadata["male"] = args.male == "true"

        # EDF files preserve the writer label (currently "EEG CH2"), while
        # legacy CSV sessions create a channel named "EEG". Use the actual
        # channel name so both storage formats reach the same YASA pipeline.
        eeg_name = raw.ch_names[0]
        # Resampling can round a nearly complete final epoch up (e.g. 29.996s
        # at 250 Hz becomes 30s at 100 Hz). Only feed fully acquired epochs;
        # keep signal_uv unchanged for the saved recording-duration evidence.
        epoch_samples = round(sample_rate_hz * 30)
        complete_samples = len(signal_uv) // epoch_samples * epoch_samples
        if complete_samples < epoch_samples:
            raise ValueError('实际采集数据不足 30 秒')
        if complete_samples < raw.n_times:
            raw.crop(tmax=(complete_samples - 1) / sample_rate_hz)
        staging = yasa.SleepStaging(raw, eeg_name=eeg_name, metadata=yasa_metadata or None)
        prediction = staging.predict()
        predicted_labels = getattr(prediction, "hypno", prediction)
        labels = [normalize_stage(value) for value in predicted_labels]
        # YASA >= 0.7 exposes probabilities on the returned Hypnogram;
        # older versions expose them through SleepStaging.predict_proba().
        probability_frame = getattr(prediction, "proba", None)
        if probability_frame is None:
            probability_frame = staging.predict_proba()
        if hasattr(probability_frame, "to_numpy"):
            probability_values = np.asarray(probability_frame.to_numpy(), dtype="float64")
        else:
            probability_values = np.asarray(probability_frame, dtype="float64")
        if probability_values.ndim == 1:
            probability_values = probability_values.reshape(-1, 1)
        if probability_values.ndim != 2:
            raise ValueError("YASA 返回的概率矩阵维度无效")
        probability_names = [str(value) for value in getattr(probability_frame, "columns", [])]
        if len(probability_names) != probability_values.shape[1]:
            probability_names = list(STAGE_ORDER[: probability_values.shape[1]])
        probability_names = [normalize_stage(value) for value in probability_names]
    except Exception as exc:  # YASA raises different errors across versions.
        duration = len(signal_uv) / sample_rate_hz if "signal_uv" in locals() else 0
        return emit({
            "ok": False,
            "error": f"YASA 离线分期失败（记录 {duration / 60:.1f} 分钟）：{exc}",
        }, 3)

    epoch_count = min(len(labels), int(probability_values.shape[0]), complete_samples // epoch_samples)
    labels = labels[:epoch_count]
    probability_values = probability_values[:epoch_count]
    if epoch_count == 0:
        return emit({"ok": False, "error": "YASA 未产生有效的 30 秒 epoch"}, 3)

    # EDF contains received samples only, whereas live epoch time also includes
    # sequence gaps. Index equality is not proof of temporal alignment.
    alignment_valid = False
    try:
        wall_seconds = (datetime.fromisoformat(metadata['endedAt']) - datetime.fromisoformat(metadata['startedAt'])).total_seconds()
        alignment_valid = abs(wall_seconds - len(signal_uv) / sample_rate_hz) < 1
    except (KeyError, ValueError, TypeError):
        pass
    if alignment_valid:
        events_path = session_dir / 'events.jsonl'
        if not events_path.exists():
            alignment_valid = False
        else:
            with events_path.open(encoding='utf-8') as stream:
                for line in stream:
                    try:
                        if json.loads(line).get('action') == 'eeg_seq_gap':
                            alignment_valid = False
                            break
                    except json.JSONDecodeError:
                        alignment_valid = False
                        break
    realtime_stages = read_realtime_stages(session_dir / "events.jsonl") if alignment_valid else {}
    rows: list[dict[str, Any]] = []
    compared = 0
    agreed = 0
    for index, stage in enumerate(labels):
        candidate_stage = stage
        segment = signal_uv[round(index * 30 * sample_rate_hz):round((index + 1) * 30 * sample_rate_hz)]
        # BrainLume's fixed 4.5V/24x ADC input range is +/-187500 uV.
        # Test the raw samples, before a high-pass filter can hide saturation.
        raw_saturated_samples = int(np.count_nonzero(np.abs(segment) >= 185625))
        raw_flatline = bool(segment.size and np.ptp(segment) == 0)
        quality_reason = 'raw_saturation' if raw_saturated_samples else ('raw_flatline' if raw_flatline else 'not_rejected_by_raw_checks')
        if raw_saturated_samples or raw_flatline:
            stage = 'UNKNOWN'
            labels[index] = stage
        probabilities = {stage_name: 0.0 for stage_name in STAGE_ORDER}
        for column_index, name in enumerate(probability_names):
            if column_index < probability_values.shape[1]:
                probabilities[normalize_stage(name)] = float(probability_values[index, column_index])
        realtime_stage = realtime_stages.get(index, "")
        agreement = ""
        if realtime_stage:
            compared += 1
            agreement = realtime_stage == stage
            agreed += int(agreement)
        rows.append({
            "epoch_index": index,
            "start_sec": index * 30,
            "end_sec": (index + 1) * 30,
            "stage": stage,
            "candidate_stage": candidate_stage,
            "quality_reason": quality_reason,
            "raw_saturated_samples": raw_saturated_samples,
            "confidence": max(probabilities.values()) if stage != 'UNKNOWN' else 0.0,
            **probabilities,
            "realtime_stage": realtime_stage,
            "agree_with_realtime": agreement,
        })

    output_dir.mkdir(parents=True, exist_ok=True)
    epochs_path = output_dir / "yasa_epochs.csv"
    summary_path = output_dir / "yasa_summary.json"
    fieldnames = [
        "epoch_index", "start_sec", "end_sec", "stage", "confidence",
        "candidate_stage", "quality_reason", "raw_saturated_samples",
        "W", "N1", "N2", "N3", "REM", "realtime_stage", "agree_with_realtime",
    ]
    with epochs_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    counts = Counter(labels)
    stage_counts = {stage: int(counts.get(stage, 0)) for stage in (*STAGE_ORDER, 'UNKNOWN')}
    stage_percent = {
        stage: (stage_counts[stage] / epoch_count * 100) for stage in stage_counts
    }
    warnings: list[str] = [
        "本次复核使用一条双极 EEG 导联（两枚互为参考电极）；未提供 EOG/EMG，REM 与 N1 的判定应谨慎解释。",
        "YASA 结果是独立算法输出，不是人工 AASM 金标准，也不等同于硬件诊断。",
    ]
    if invalid_rows:
        warnings.append(f"发现 {invalid_rows} 行无效电压；仅在缺失比例低于 5% 时做线性插值后送入 YASA。")
    if not alignment_valid:
        warnings.append('原始样本时间与实际采集时间不一致或缺少时间证据，已禁用按 epoch 编号直接计算在线/离线一致率。')
    warnings.append('原始 ADC 近满量程或整段恒值的 epoch 标为 UNKNOWN；其他片段也不代表已通过完整人工质量复核。')
    if source_path.name.endswith(".partial"):
        warnings.append("输入是尚未正常结束的 partial 会话，结果仅供阶段性检查。")

    overlap: dict[str, Any] = {
        "comparedEpochs": compared,
        "agreementEpochs": agreed,
        "agreementPercent": (agreed / compared * 100) if compared else None,
    }
    summary = {
        "ok": True,
        "sessionId": metadata.get("id"),
        "sourceFile": str(source_path),
        "outputFiles": {"summaryJson": str(summary_path), "epochsCsv": str(epochs_path)},
        "sampleRateHz": sample_rate_hz,
        "durationSeconds": len(signal_uv) / sample_rate_hz,
        "epochSeconds": 30,
        "epochCount": epoch_count,
        "stageCounts": stage_counts,
        "stagePercent": stage_percent,
        "overlapWithRealtime": overlap,
        "yasaVersion": getattr(yasa, "__version__", "unknown"),
        "mneVersion": getattr(mne, "__version__", "unknown"),
        "warnings": warnings,
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return emit(summary)


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except Exception as exc:
        raise SystemExit(emit({"ok": False, "error": str(exc), "errorType": type(exc).__name__}, 10))
