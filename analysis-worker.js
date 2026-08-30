'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const readline = require('node:readline');
const { parentPort } = require('node:worker_threads');
const Analysis = require('./src/analysis-core');
const { readEdf } = require('./src/edf');

let recording = null;

function progress(phase, percent, detail = '') {
    parentPort.postMessage({ type: 'progress', phase, percent, detail });
}

async function readJson(filePath, fallback) {
    try { return JSON.parse(await fsp.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function readEvents(directory) {
    const events = [];
    try {
        const stream = fs.createReadStream(path.join(directory, 'events.jsonl'), 'utf8');
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
            try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* malformed diagnostic line */ }
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return events;
}

async function loadCsv(directory, expectedRows = 0) {
    const finalPath = path.join(directory, 'eeg_raw.csv');
    const partialPath = path.join(directory, 'eeg_raw.csv.partial');
    const csvPath = fs.existsSync(finalPath) ? finalPath : partialPath;
    const values = [];
    let invalidRows = 0;
    let seqGaps = 0;
    let clippingSamples = 0;
    let firstElapsedUs = null;
    let lastElapsedUs = null;
    let header = null;
    let processed = 0;
    const input = fs.createReadStream(csvPath, 'utf8');
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
        if (!header) { header = Analysis.parseCsvLine(line); continue; }
        if (!line.trim()) continue;
        const fields = Analysis.parseCsvLine(line);
        const get = name => fields[header.indexOf(name)];
        const voltage = Number(get('voltage_uv'));
        const rawCode = Number(get('raw_code'));
        const elapsedUs = Number(get('elapsed_us'));
        const gap = Number(get('seq_gap'));
        if (!Number.isFinite(voltage)) { invalidRows++; continue; }
        values.push(voltage);
        if (Number.isFinite(gap) && gap > 0) seqGaps += gap;
        if (Number.isFinite(rawCode) && Math.abs(rawCode) >= 0x7FFFFF * 0.99) clippingSamples++;
        if (Number.isFinite(elapsedUs)) {
            if (firstElapsedUs == null) firstElapsedUs = elapsedUs;
            lastElapsedUs = elapsedUs;
        }
        processed++;
        if (processed % 50000 === 0) progress('read', Math.min(55, expectedRows ? processed / expectedRows * 55 : 20), `${processed.toLocaleString()} 点`);
    }
    return { values: Float64Array.from(values), invalidRows, seqGaps, clippingSamples, firstElapsedUs, lastElapsedUs, csvPath };
}

function eventSequenceGapCount(events) {
    return (events || []).reduce((total, event) => event.action === 'eeg_seq_gap'
        ? total + Math.max(0, Number(event.gapSamples) || 0) : total, 0);
}

async function loadEdf(directory, metadata, events) {
    const finalPath = path.join(directory, 'eeg_raw.edf');
    const partialPath = path.join(directory, 'eeg_raw.edf.partial');
    const edfPath = fs.existsSync(finalPath) ? finalPath : partialPath;
    const edf = await readEdf(edfPath, 0);
    const expectedRows = Number(metadata.rows);
    // The writer pads only the final incomplete one-second record. Use session.json's
    // received row count to remove that padding after a normal session stop.
    const rowCount = expectedRows > 0 ? Math.min(expectedRows, edf.values.length) : edf.values.length;
    return {
        values: edf.values.slice(0, rowCount),
        invalidRows: 0,
        seqGaps: eventSequenceGapCount(events),
        clippingSamples: 0,
        firstElapsedUs: null,
        lastElapsedUs: null,
        edfPath,
    };
}

function sliceBySeconds(values, sampleRateHz, startSec, endSec) {
    const start = Math.max(0, Math.floor(startSec * sampleRateHz));
    const end = Math.min(values.length, Math.ceil(endSec * sampleRateHz));
    return values.subarray(start, end);
}

function spectrumPreview(psd, maxHz = 60) {
    const frequencies = [];
    const power = [];
    for (let index = 0; index < psd.frequencies.length; index++) {
        if (psd.frequencies[index] > maxHz) break;
        frequencies.push(psd.frequencies[index]);
        power.push(psd.power[index]);
    }
    return { frequencies, power };
}

function basicMetrics(raw, filtered, sampleRateHz) {
    const rawMedian = Analysis.percentile(raw, 0.5);
    const minuteSamples = Math.max(1, Math.round(sampleRateHz * 60));
    const minuteMedians = [];
    // A minute baseline is a descriptive metric; deterministic sampling keeps
    // long overnight records responsive without changing the stored signal.
    for (let start = 0; start < raw.length; start += minuteSamples) minuteMedians.push(Analysis.percentile(raw.subarray(start, Math.min(raw.length, start + minuteSamples)), 0.5, 4000));
    const psd = Analysis.welchPsd(filtered, sampleRateHz);
    return {
        rawAbsoluteMedianUv: Math.abs(rawMedian),
        baselineRangeUv: Analysis.peakToPeak(minuteMedians),
        filteredRmsUv: Analysis.rms(filtered),
        filteredPeakToPeakUv: Analysis.peakToPeak(filtered),
        robustRangeUv: Analysis.robustRange(filtered),
        interference50HzRmsUv: Analysis.toneRms(raw.subarray(0, Math.min(raw.length, sampleRateHz * 600)), sampleRateHz, 50),
        bandPowers: Analysis.bandPowers(psd),
        psd: spectrumPreview(psd),
    };
}

function analyzeEpochs(filtered, sampleRateHz) {
    const epochSamples = Math.round(sampleRateHz * 30);
    const epochs = [];
    for (let start = 0, index = 0; start + epochSamples <= filtered.length; start += epochSamples, index++) {
        const values = filtered.subarray(start, start + epochSamples);
        // The quality gate intentionally uses a robust percentile range, so a
        // deterministic 2,000-point sample is enough for each 30 s epoch and
        // avoids sorting all 7,500 points repeatedly on long recordings.
        const range = Analysis.robustRange(values, 2000);
        epochs.push({ index, startSec: start / sampleRateHz, endSec: (start + epochSamples) / sampleRateHz,
            rmsUv: Analysis.rms(values), robustRangeUv: range, rejected: range >= 150 });
    }
    return epochs;
}

function phaseMetricsFor(segment) {
    const definitions = [
        ['before', segment.preStartSec, segment.startSec],
        ['during', segment.startSec, segment.endSec],
        ['after', segment.endSec, segment.postEndSec],
    ];
    const phases = {};
    for (const [id, startSec, endSec] of definitions) {
        const values = sliceBySeconds(recording.filtered, recording.sampleRateHz, startSec, endSec);
        const psd = Analysis.welchPsd(values, recording.sampleRateHz);
        phases[id] = {
            id, startSec, endSec, durationSeconds: Math.max(0, endSec - startSec),
            rmsUv: Analysis.rms(values), peakToPeakUv: Analysis.peakToPeak(values),
            robustRangeUv: Analysis.robustRange(values), bandPowers: Analysis.bandPowers(psd),
            psd: spectrumPreview(psd),
        };
    }
    for (const phase of [phases.during, phases.after]) {
        phase.changeFromBeforePercent = {};
        for (const band of Analysis.BAND_DEFINITIONS) {
            const baseline = phases.before.bandPowers[band.id].absolute;
            phase.changeFromBeforePercent[band.id] = baseline > 0
                ? (phase.bandPowers[band.id].absolute - baseline) / baseline * 100 : 0;
        }
    }
    return { ...segment, phases };
}

function computePhaseMetrics() {
    recording.phaseMetrics = recording.segments.map(phaseMetricsFor);
    return recording.phaseMetrics;
}

function downsampleOverview(values, width = 1200) {
    const viewport = Analysis.createViewport(values, 0, values.length, width);
    return viewport.mode === 'envelope' ? { lows: viewport.lows, highs: viewport.highs }
        : { samples: viewport.samples };
}

async function openRecording(payload) {
    progress('read', 1, '读取会话元数据');
    const metadata = await readJson(path.join(payload.directory, 'session.json'), {});
    const events = await readEvents(payload.directory);
    const edfFinalPath = path.join(payload.directory, 'eeg_raw.edf');
    const edfPartialPath = path.join(payload.directory, 'eeg_raw.edf.partial');
    const source = fs.existsSync(edfFinalPath) || fs.existsSync(edfPartialPath)
        ? await loadEdf(payload.directory, metadata, events)
        : await loadCsv(payload.directory, Number(metadata.rows || 0));
    const sampleRateHz = Number(metadata.sampleRateHz || 250);
    if (!source.values.length) throw new Error('该会话没有可分析的 EEG 数据');
    progress('filter', 58, '执行零相位 0.5-45Hz + 50Hz 陷波');
    const filtered = Analysis.zeroPhaseFilter(source.values, sampleRateHz);
    const measuredDuration = source.firstElapsedUs != null && source.lastElapsedUs > source.firstElapsedUs
        ? (source.lastElapsedUs - source.firstElapsedUs) / 1e6 : source.values.length / sampleRateHz;
    const durationSeconds = source.values.length / sampleRateHz;
    const paired = Analysis.pairLightEvents(events, durationSeconds);
    if (source.seqGaps > 0) paired.warnings.push(`记录包含 ${source.seqGaps} 个缺失样本；EDF/旧版 CSV 未将缺失段伪造为有效 EEG。`);
    recording = {
        metadata, events, raw: source.values, filtered, sampleRateHz, durationSeconds,
        csvPath: source.csvPath || null,
        edfPath: source.edfPath || null,
        segments: Analysis.validateSegments(paired.segments, durationSeconds),
        warnings: paired.warnings,
        integrity: {
            validSamples: source.values.length, invalidRows: source.invalidRows, seqGaps: source.seqGaps,
            clippingSamples: source.clippingSamples,
            effectiveSampleRateHz: measuredDuration > 0 ? (source.values.length - 1) / measuredDuration : sampleRateHz,
        },
    };
    progress('metrics', 72, '计算数据质量与频谱');
    recording.metrics = basicMetrics(recording.raw, recording.filtered, sampleRateHz);
    progress('metrics', 84, '计算每个 30 秒 epoch 的质量');
    recording.epochs = analyzeEpochs(recording.filtered, sampleRateHz);
    recording.integrity.epochs = recording.epochs.length;
    recording.integrity.rejectedEpochs = recording.epochs.filter(epoch => epoch.rejected).length;
    recording.integrity.usableEpochPercent = recording.epochs.length
        ? (recording.epochs.length - recording.integrity.rejectedEpochs) / recording.epochs.length * 100 : 0;
    computePhaseMetrics();
    // The worker has finished computing here, but the summary still needs to
    // cross the worker/main/renderer boundary. Keep 100% for the UI only after
    // that result has actually arrived in the analysis window.
    progress('complete', 96, '计算完成，正在载入分析结果');
    return summary({ includeEpochs: payload.includeEpochs !== false });
}

function summary({ includeEpochs = true } = {}) {
    const result = {
        metadata: recording.metadata,
        sourceFile: recording.edfPath || recording.csvPath,
        sampleRateHz: recording.sampleRateHz,
        durationSeconds: recording.durationSeconds,
        integrity: recording.integrity,
        metrics: recording.metrics,
        segments: recording.segments,
        phaseMetrics: recording.phaseMetrics,
        warnings: recording.warnings,
    };
    if (includeEpochs) result.epochs = recording.epochs;
    return result;
}

function reportData() {
    const comparisonStart = recording.segments.length ? Math.max(0, recording.segments[0].startSec - 5) : 0;
    const comparisonEnd = Math.min(recording.durationSeconds, comparisonStart + 10);
    return {
        ...summary(),
        generatedAt: new Date().toISOString(),
        charts: {
            overview: downsampleOverview(recording.filtered),
            comparison: {
                startSec: comparisonStart,
                raw: downsampleOverview(sliceBySeconds(recording.raw, recording.sampleRateHz, comparisonStart, comparisonEnd), 900),
                filtered: downsampleOverview(sliceBySeconds(recording.filtered, recording.sampleRateHz, comparisonStart, comparisonEnd), 900),
            },
        },
    };
}

async function dispatch(action, payload) {
    if (action === 'open') return openRecording(payload);
    if (!recording) throw new Error('尚未打开分析记录');
    if (action === 'viewport') {
        const values = payload.source === 'raw' ? recording.raw : recording.filtered;
        return { ...Analysis.createViewport(values, payload.startSample, payload.endSample, payload.pixelWidth),
            sampleRateHz: recording.sampleRateHz, source: payload.source };
    }
    if (action === 'spectrogram') {
        const values = payload.source === 'raw' ? recording.raw : recording.filtered;
        return Analysis.spectrogram(values, recording.sampleRateHz, {
            windowSeconds: payload.windowSeconds,
            overlap: 0.75,
            maxHz: payload.maxHz,
            maxTimeBins: payload.maxTimeBins,
        });
    }
    if (action === 'segments') {
        recording.segments = Analysis.validateSegments(payload.segments, recording.durationSeconds);
        computePhaseMetrics();
        return summary({ includeEpochs: payload.includeEpochs !== false });
    }
    if (action === 'report') return reportData();
    throw new Error(`Unknown analysis action: ${action}`);
}

parentPort.on('message', async message => {
    try { parentPort.postMessage({ type: 'response', id: message.id, result: await dispatch(message.action, message.payload || {}) }); }
    catch (error) { parentPort.postMessage({ type: 'response', id: message.id, error: { message: error.message, stack: error.stack } }); }
});
