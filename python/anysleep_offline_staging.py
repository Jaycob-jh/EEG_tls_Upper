#!/usr/bin/env python3
"""Compare two AnySleep input paths and YASA on the same complete CH2 epochs."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
from pathlib import Path

from yasa_offline_staging import STAGE_ORDER, emit, normalize_stage


UPSTREAM = "899bfff284f3eb3e7448bc90990f2230757470a2"
DETREND_HZ = 0.3
DETREND_ORDER = 4
ASSET_HASHES = {
    "anysleep_no_hydra.py": "b94a9b62216a663e2923138b42c9439ccfa7b94cc8ca95729e2548c80afe785f",
    "anysleep-run1.pth": "9f305c0f81a58d36092bb88b04832a48f0f4dae940f31486cd2284e9c659483f",
}


def load_anysleep(assets: Path):
    for name, expected in ASSET_HASHES.items():
        asset = assets / name
        with asset.open("rb") as handle:
            if hashlib.file_digest(handle, "sha256").hexdigest() != expected:
                raise ValueError(f"AnySleep 资产校验失败：{name}")
    spec = importlib.util.spec_from_file_location("brainlume_anysleep", assets / "anysleep_no_hydra.py")
    if spec is None or spec.loader is None:
        raise ImportError("无法加载作者提供的 AnySleep 模型代码")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The pinned upstream loader uses torch.load(..., weights_only=True).
    return module.AnySleep(path=str(assets / "anysleep-run1.pth"), sleep_stage_frequency=1).eval()


def prepare_anysleep(volts, rate, *, detrend=False):
    import numpy as np
    from scipy import signal
    from sklearn.preprocessing import RobustScaler

    if detrend:
        sos = signal.butter(DETREND_ORDER, DETREND_HZ, btype="highpass", fs=rate, output="sos")
        volts = signal.sosfiltfilt(sos, volts)
    resampled = signal.resample_poly(volts, 128, rate)
    iqr = np.subtract(*np.percentile(resampled, [75, 25]))
    if not np.isfinite(iqr) or iqr <= 0:
        method = "去漂移后" if detrend else "原流程"
        raise ValueError(f"CH2 {method}四分位距无效，无法运行 AnySleep")
    limit = 20 * iqr
    clipped = np.clip(resampled, -limit, limit)
    scaler = RobustScaler()
    scaled = scaler.fit_transform(clipped.reshape(-1, 1)).astype(np.float32)
    return scaled, {
        "highpassHz": DETREND_HZ if detrend else None,
        "filterOrder": DETREND_ORDER if detrend else None,
        "zeroPhase": detrend,
        "inputIqrUv": float(iqr * 1e6),
        "scaleUv": float(scaler.scale_[0] * 1e6),
        "clipUv": float(limit * 1e6),
        "clippedPercent": float(100 * np.mean(np.abs(resampled) > limit)),
    }


def score_anysleep(model, signal, epochs):
    import torch

    with torch.inference_mode():
        logits = model(torch.from_numpy(signal).unsqueeze(0))
        if tuple(logits.shape) != (1, epochs, len(STAGE_ORDER)) or not torch.isfinite(logits).all():
            raise ValueError("AnySleep 输出形状或数值无效")
        indices = logits[0].argmax(dim=-1).tolist()
        n3 = logits[0].softmax(dim=-1)[:, STAGE_ORDER.index("N3")].tolist()
    return [STAGE_ORDER[index] for index in indices], n3


def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edf", type=Path, required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--samples", type=int, required=True)
    parser.add_argument("--assets-dir", type=Path, required=True)
    args = parser.parse_args()

    import mne
    import torch
    import yasa
    import scipy

    rate, epoch_samples = 250, 7500
    raw = mne.io.read_raw_edf(str(args.edf), include=[args.channel], preload=True, verbose="ERROR")
    if raw.ch_names != [args.channel] or float(raw.info["sfreq"]) != rate:
        raise ValueError("EDF 的 CH2 导联或 250 Hz 采样率与对照输入不一致")
    if args.samples < epoch_samples or args.samples > raw.n_times or args.samples % epoch_samples:
        raise ValueError("对照输入必须是从 EDF 起点开始的完整 30 秒片段")
    if args.samples < raw.n_times:
        raw.crop(tmax=(args.samples - 1) / rate)
    if raw.n_times != args.samples:
        raise ValueError("读取后的 EDF 样本数与对齐参数不符")
    epochs = args.samples // epoch_samples

    # Both paths use the author's original 128 Hz / 20 IQR / RobustScaler
    # recipe. The additional path first high-passes the full offline record,
    # so both the clip boundary and the robust scale are fitted after detrending.
    torch.set_num_threads(4)
    model = load_anysleep(args.assets_dir)
    volts = raw.get_data()[0]
    scaled, original_info = prepare_anysleep(volts, rate)
    original_stages, original_n3 = score_anysleep(model, scaled, epochs)
    del scaled
    scaled, detrended_info = prepare_anysleep(volts, rate, detrend=True)
    detrended_stages, detrended_n3 = score_anysleep(model, scaled, epochs)

    prediction = yasa.SleepStaging(raw, eeg_name=args.channel).predict()
    yasa_labels = [normalize_stage(label) for label in getattr(prediction, "hypno", prediction)]
    if len(yasa_labels) != epochs:
        raise ValueError(f"YASA 输出 {len(yasa_labels)} 段，预期 {epochs} 段，无法对齐")

    return emit({
        "ok": True,
        "epochCount": epochs,
        "anysleep": original_stages,
        "anysleepN3Probability": original_n3,
        "anysleepDetrended": detrended_stages,
        "anysleepDetrendedN3Probability": detrended_n3,
        "yasa": yasa_labels,
        "preprocessing": {"original": original_info, "detrended": detrended_info},
        "models": {
            "anysleepCommit": UPSTREAM,
            "anysleepWeightSha256": ASSET_HASHES["anysleep-run1.pth"],
            "torch": torch.__version__,
            "yasa": yasa.__version__,
            "mne": mne.__version__,
            "scipy": scipy.__version__,
        },
    })


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except Exception as exc:
        raise SystemExit(emit({"ok": False, "error": str(exc), "errorType": type(exc).__name__}, 2))
