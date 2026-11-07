"""Offline CH2 morphology and quality features on the original EDF sample grid."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np
from scipy import signal

FS = 250
EPOCH = 30 * FS
VERSION = 1
HIGH_PASS_HZ = 0.3
SLOW_BAND_HZ = (0.5, 2.0)
STRICT_PTP_UV = 75
LOOSE_PTP_UV = 25
MAX_CYCLE_PTP_UV = 350
MIN_LOBE_SECONDS = 0.10
MIN_LOBE_UV = 8


def load_ch2(path, label, samples, expected_hash):
    import mne

    with path.open("rb") as handle:
        header = handle.read(512).decode("latin1")
        handle.seek(0)
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
    if digest != expected_hash:
        raise ValueError("EDF 指纹与分期结果不一致")
    if (len(header) != 512 or int(header[184:192]) != 512 or int(header[252:256]) != 1
            or header[256:272].strip() != label or header[352:360].strip() not in {"uV", "µV"}):
        raise ValueError("N3 MVP 只支持已校准为 µV 的单导 CH2 EDF")
    low, high, dig_low, dig_high = (float(header[i:i+8]) for i in (360, 368, 376, 384))
    if not np.isfinite([low, high, dig_low, dig_high]).all() or not low < high or not dig_low < dig_high:
        raise ValueError("EDF 量程无效")
    raw = mne.io.read_raw_edf(str(path), include=[label], preload=True, verbose="ERROR")
    if (raw.ch_names != [label] or raw.info["sfreq"] != FS or samples > raw.n_times
            or samples < EPOCH or samples % EPOCH):
        raise ValueError("CH2 采样率或 30 秒对齐范围与分期结果不一致")
    volts = raw.get_data(stop=samples)[0]
    if not np.isfinite(volts).all():
        raise ValueError("EDF 含非有限采样")
    return volts, (low, high), (high - low) / (dig_high - dig_low)


def highpass_volts(volts):
    return signal.sosfiltfilt(signal.butter(4, HIGH_PASS_HZ, btype="highpass", fs=FS, output="sos"), volts)


def slow_cycles(slow_uv, minimum_ptp):
    """Non-overlapping complete cycles, invariant to changing bipolar polarity."""
    cuts = np.flatnonzero((slow_uv[1:] >= 0) != (slow_uv[:-1] >= 0)) + 1
    if cuts.size < 3:
        return []
    maxima = np.maximum.reduceat(slow_uv, cuts)[:-1]
    minima = np.minimum.reduceat(slow_uv, cuts)[:-1]
    peaks = np.maximum(maxima[:-1], maxima[1:])
    troughs = np.minimum(minima[:-1], minima[1:])
    ptp = peaks - troughs
    period = (cuts[2:] - cuts[:-2]) / FS
    half = np.diff(cuts) / FS
    accept = ((period >= 1 / SLOW_BAND_HZ[1]) & (period <= 1 / SLOW_BAND_HZ[0])
              & (half[:-1] >= MIN_LOBE_SECONDS) & (half[1:] >= MIN_LOBE_SECONDS)
              & (peaks >= MIN_LOBE_UV) & (troughs <= -MIN_LOBE_UV)
              & (ptp >= minimum_ptp) & (ptp <= MAX_CYCLE_PTP_UV))
    out = []
    next_start = 0
    for index in np.flatnonzero(accept):
        lo, hi = int(cuts[index]), int(cuts[index + 2])
        if lo >= next_start:
            out.append((lo, hi, float(ptp[index])))
            next_start = hi
    return out


def by_epoch(cycles, count):
    coverage = np.zeros(count, dtype=np.int64)
    events = np.zeros(count, dtype=np.int64)
    peak = np.zeros(count)
    for lo, hi, uv in cycles:
        for epoch in range(lo // EPOCH, (hi - 1) // EPOCH + 1):
            coverage[epoch] += min(hi, (epoch + 1) * EPOCH) - max(lo, epoch * EPOCH)
            events[epoch] += 1
            peak[epoch] = max(peak[epoch], uv)
    return coverage / FS, events, peak


def power_percent(data, *bands):
    hz, psd = signal.welch(data, fs=FS, nperseg=8 * FS, noverlap=4 * FS, axis=-1)
    total = psd[:, (hz >= .125) & (hz <= 100)].sum(axis=1)
    return [
        np.divide(100 * psd[:, (hz >= lo) & (hz <= hi)].sum(axis=1), total,
                  where=total > 0, out=np.full(len(data), np.nan))
        for lo, hi in bands
    ]


def max_flat_seconds(row):
    cuts = np.flatnonzero(np.diff(row) != 0) + 1
    return np.diff(np.r_[0, cuts, len(row)]).max() / FS


def extract(volts, rails_uv, lsb_uv, clip_uv):
    hp_v = highpass_volts(volts)
    raw_uv, hp_uv = volts * 1e6, hp_v * 1e6
    slow_uv = signal.sosfiltfilt(signal.butter(4, SLOW_BAND_HZ, btype="bandpass", fs=FS, output="sos"), hp_uv)
    raw, hp, slow = (value.reshape(-1, EPOCH) for value in (raw_uv, hp_uv, slow_uv))
    count = len(raw)
    loose = slow_cycles(slow_uv, LOOSE_PTP_UV)
    strict = slow_cycles(slow_uv, STRICT_PTP_UV)
    strict_s, strict_n, _ = by_epoch(strict, count)
    loose_s, _, ptp = by_epoch(loose, count)
    drift, raw_slow = power_percent(raw, (.125, .375), SLOW_BAND_HZ)
    hp_slow, = power_percent(hp, SLOW_BAND_HZ)
    raw_q = np.percentile(raw, [25, 50, 75], axis=1)
    hp_q = np.percentile(hp, [1, 25, 75, 99], axis=1)
    low, high = rails_uv
    rails = ((raw <= low + lsb_uv / 4) | (raw >= high - lsb_uv / 4)).sum(axis=1)
    # Include the jump entering an epoch, so an edge on the boundary is not missed.
    jumps = np.max(np.abs(np.diff(raw_uv, prepend=raw_uv[0])).reshape(-1, EPOCH), axis=1)
    clip_fraction = 100 * np.mean(
        np.abs(signal.resample_poly(hp_v, 128, FS).reshape(count, 30 * 128)) > clip_uv / 1e6,
        axis=1,
    )

    def f(value):
        return float(value) if np.isfinite(value) else None

    rows = [
        dict(epochIndex=i, rawMedianUv=f(raw_q[1, i]), rawIqrUv=f(raw_q[2, i] - raw_q[0, i]),
             hpIqrUv=f(hp_q[2, i] - hp_q[1, i]), hpP01P99Uv=f(hp_q[3, i] - hp_q[0, i]),
             rawDriftPercent=f(drift[i]), rawSlowPercent=f(raw_slow[i]), hpSlowPercent=f(hp_slow[i]),
             slowRmsUv=f(np.sqrt(np.mean(slow[i] ** 2))), slowMaxCyclePtpUv=f(ptp[i]) if ptp[i] else None,
             looseSlowSeconds=f(loose_s[i]), strictSlowSeconds=f(strict_s[i]), strictSlowCycles=int(strict_n[i]),
             railSamples=int(rails[i]), rawStepUv=f(jumps[i]), hpPeakUv=f(np.max(np.abs(hp[i]))),
             flatSeconds=f(max_flat_seconds(raw[i])), inputClippedPercent=f(clip_fraction[i]))
        for i in range(count)
    ]
    settings = dict(version=VERSION, samplingHz=FS, epochSeconds=30, highpassHz=HIGH_PASS_HZ,
                    slowBandHz=SLOW_BAND_HZ, strictPtpUv=STRICT_PTP_UV, loosePtpUv=LOOSE_PTP_UV,
                    maxCyclePtpUv=MAX_CYCLE_PTP_UV, minLobeUv=MIN_LOBE_UV,
                    minLobeSeconds=MIN_LOBE_SECONDS, lsbUv=lsb_uv)
    return settings, rows, (raw, hp, slow), strict


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edf", type=Path, required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--samples", type=int, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--clip-uv", type=float, required=True)
    args = parser.parse_args()
    if not np.isfinite(args.clip_uv) or args.clip_uv <= 0:
        raise ValueError("AnySleep 去漂移限幅值无效")
    volts, rails, lsb = load_ch2(args.edf, args.channel, args.samples, args.sha256)
    settings, rows, _, _ = extract(volts, rails, lsb, args.clip_uv)
    print(json.dumps(dict(ok=True, settings=settings, rows=rows), allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        run()
    except Exception as error:
        print(json.dumps(dict(ok=False, error=str(error)), ensure_ascii=False))
        raise SystemExit(2)
