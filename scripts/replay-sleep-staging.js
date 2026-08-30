'use strict';

/**
 * Replay the Cao Cao sleep-stage input/model pipeline on the legacy tLS_sleep
 * EDF corpus. This script is intentionally an evaluation tool: it never
 * changes an EDF or any legacy derived result.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const ort = require('onnxruntime-node');
const { readEdf } = require('../src/edf');
const Sleep = require('../src/realtime-sleep');
const SDK = require('../src/vendor/BrainLume_Lib');

const STAGES = ['W', 'N1', 'N2', 'N3', 'REM'];
const GROUPS = ['810_10hz', '810_40hz', '1050_10hz', '1050_40hz'];

function argValue(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback = 0) {
    const value = Number(argValue(name, fallback));
    return Number.isFinite(value) ? value : fallback;
}

function normalizeStage(value) {
    const stage = String(value || '').trim().toUpperCase();
    if (stage === 'WAKE') return 'W';
    if (stage === 'R') return 'REM';
    return STAGES.includes(stage) ? stage : '';
}

function classify(probabilities) {
    const values = Array.from(probabilities || [], Number);
    let best = 0;
    for (let index = 1; index < values.length; index++) {
        if (values[index] > values[best]) best = index;
    }
    return STAGES[best] || '';
}

function parseCsv(text) {
    const lines = String(text).split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].replace(/^\uFEFF/, '').split(',');
    return lines.slice(1).map(line => {
        const values = line.split(',');
        return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']));
    });
}

async function readCsv(filePath) {
    try {
        return parseCsv(await fsp.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function readWeakLabels(edfPath) {
    const improvedDir = path.join(path.dirname(edfPath), 'improved');
    const base = path.basename(edfPath, path.extname(edfPath));
    const correctedPath = path.join(improvedDir, `${base}_hypnogram_corrected.csv`);
    const originalPath = path.join(improvedDir, `${base}_epoch_confidence.csv`);
    const slowPath = path.join(improvedDir, `${base}_slowwaves.csv`);
    const corrected = await readCsv(correctedPath);
    const original = await readCsv(originalPath);
    const slowwaves = await readCsv(slowPath);
    const labels = new Map();
    for (const row of corrected) {
        const index = Number(row.epoch_30s);
        if (!Number.isInteger(index) || index < 0) continue;
        labels.set(index, {
            corrected: normalizeStage(row.stage_corrected || row.stage),
            original: normalizeStage(row.stage_original || row.stage),
            confidence: Number(row.confidence),
        });
    }
    for (const row of original) {
        const index = Number(row.epoch_30s);
        if (!Number.isInteger(index) || index < 0) continue;
        const existing = labels.get(index) || {};
        existing.original = existing.original || normalizeStage(row.stage);
        existing.confidence = Number.isFinite(existing.confidence) ? existing.confidence : Number(row.confidence);
        labels.set(index, existing);
    }

    const slowSeconds = new Map();
    const slowHeader = slowwaves[0] || {};
    const hasStart = Object.prototype.hasOwnProperty.call(slowHeader, 'Start');
    const hasEnd = Object.prototype.hasOwnProperty.call(slowHeader, 'End');
    for (const row of slowwaves) {
        const start = Number(row.Start);
        const duration = Number(row.Duration);
        const end = hasEnd ? Number(row.End) : start + (Number.isFinite(duration) ? duration : 0);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const first = Math.max(0, Math.floor(start / 30));
        const last = Math.max(first, Math.ceil(end / 30) - 1);
        for (let epoch = first; epoch <= last; epoch++) {
            const overlap = Math.max(0, Math.min(end, (epoch + 1) * 30) - Math.max(start, epoch * 30));
            if (overlap) slowSeconds.set(epoch, (slowSeconds.get(epoch) || 0) + overlap);
        }
    }
    return { labels, slowSeconds, correctedPath, originalPath, slowPath };
}

async function findBaselineEdfs(root) {
    const candidates = [];
    for (const group of GROUPS) {
        const groupDir = path.join(root, group);
        let subjects = [];
        try { subjects = await fsp.readdir(groupDir, { withFileTypes: true }); } catch { continue; }
        subjects = subjects.filter(entry => entry.isDirectory() && /^sub\d+$/i.test(entry.name))
            .sort((a, b) => Number(a.name.slice(3)) - Number(b.name.slice(3)));
        for (const subject of subjects) {
            const subjectDir = path.join(groupDir, subject.name);
            const files = await fsp.readdir(subjectDir, { withFileTypes: true });
            for (const entry of files) {
                if (!entry.isFile() || !/\.edf$/i.test(entry.name)) continue;
                if (!/(^|[-_ ])0(?:[-_ ]|$)/i.test(path.basename(entry.name, path.extname(entry.name)))) continue;
                const edfPath = path.join(subjectDir, entry.name);
                const weak = await readWeakLabels(edfPath);
                if (!weak.labels.size) continue;
                candidates.push({ group, subject: subject.name, edfPath, weak });
            }
        }
    }
    return candidates;
}

function chooseFiles(candidates, limit) {
    if (!(limit > 0) || candidates.length <= limit) return candidates;
    const byGroup = new Map(GROUPS.map(group => [group, []]));
    candidates.forEach(candidate => byGroup.get(candidate.group)?.push(candidate));
    const selected = [];
    let cursor = 0;
    while (selected.length < limit) {
        let added = false;
        for (const group of GROUPS) {
            const items = byGroup.get(group) || [];
            if (cursor < items.length && selected.length < limit) {
                selected.push(items[cursor]);
                added = true;
            }
        }
        if (!added) break;
        cursor += 1;
    }
    return selected;
}

function buildFeeds(input) {
    return {
        eeg: new ort.Tensor('float32', Float32Array.from(input.eeg), [1, input.temporalContext, 1, input.windowLength]),
        epoch_index: new ort.Tensor('float32', Float32Array.from(input.epochIndex), [1, input.temporalContext, 1]),
        epoch_cycle_index: new ort.Tensor('float32', Float32Array.from(input.epochCycleIndex), [1, input.temporalContext, 5]),
    };
}

function sliceOutput(output, outputIndex) {
    const values = Array.from(output.prob.data, Number);
    const offset = outputIndex * STAGES.length;
    return values.slice(offset, offset + STAGES.length);
}

function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function metricSummary(rows, predictionKey, referenceKey = 'reference') {
    const usable = rows.filter(row => row[referenceKey] && row[predictionKey]);
    const confusion = Object.fromEntries(STAGES.map(stage => [stage, Object.fromEntries(STAGES.map(other => [other, 0]))]));
    usable.forEach(row => { confusion[row[referenceKey]][row[predictionKey]] += 1; });
    const tp = confusion.N3.N3;
    const predicted = STAGES.reduce((sum, stage) => sum + confusion[stage].N3, 0);
    const actual = STAGES.reduce((sum, stage) => sum + confusion.N3[stage], 0);
    const precision = predicted ? tp / predicted : null;
    const recall = actual ? tp / actual : null;
    return {
        n: usable.length,
        agreement: usable.length ? usable.filter(row => row[referenceKey] === row[predictionKey]).length / usable.length : null,
        n3: {
            predictedEpochs: predicted,
            referenceEpochs: actual,
            precision,
            recall,
            f1: precision != null && recall != null && precision + recall > 0 ? 2 * precision * recall / (precision + recall) : null,
        },
        confusion,
    };
}

async function replayFile(candidate, model, maxEpochs) {
    const edf = await readEdf(candidate.edfPath, 0);
    const eegIndex = edf.labels.findIndex(label => /EEG|FP/i.test(String(label)));
    if (eegIndex > 0) return { error: `EEG 通道不是第一个信号，当前只读回放暂不支持索引 ${eegIndex}` };
    const filter = new SDK.filters.EegFilterBank(250, 1, SDK.filters.MODEL_TRAINING_PRESET, {
        initialization: 'zero', implementation: 'direct2t',
    });
    const pipeline = new Sleep.RealtimeSleepPipeline({ inputRateHz: 250, modelRateHz: 100, epochSeconds: 30, temporalContext: 21 });
    const centerSmoother = new Sleep.SleepStageSmoother({ alpha: 0.5 });
    const causalSmoother = new Sleep.SleepStageSmoother({ alpha: 0.5 });
    const featureHistory = [];
    const rows = [];
    let currentEpoch = [];
    let completedEpochs = 0;
    let qualityPassed = 0;

    for (const rawValue of edf.values) {
        const value = filter.process(0, rawValue);
        currentEpoch.push(value);
        const epoch = pipeline.push(value);
        if (!epoch) continue;
        const fullFeatures = Sleep.spectralFeatures(currentEpoch, 250, { maxSamples: 7500 });
        featureHistory.push(fullFeatures);
        if (featureHistory.length > 21) featureHistory.shift();
        currentEpoch = [];
        completedEpochs += 1;
        if (epoch.quality.ok) qualityPassed += 1;
        if (!epoch.ready) continue;
        const input = pipeline.inferenceInput();
        const causalInput = pipeline.onlineInferenceInput();
        if (!input || !causalInput) continue;
        const output = await model.run(buildFeeds(input));
        const centerRaw = sliceOutput(output, input.outputIndex);
        const causalRaw = sliceOutput(output, causalInput.outputIndex);
        const centerSmooth = centerSmoother.update(centerRaw);
        const causalSmooth = causalSmoother.update(causalRaw);
        const centerFeature = featureHistory[Math.floor(featureHistory.length / 2)] || {};
        const targetEpoch = input.classifiedEpochIndex;
        const weak = candidate.weak.labels.get(targetEpoch) || {};
        rows.push({
            epochIndex: targetEpoch,
            reference: weak.corrected || '',
            originalReference: weak.original || '',
            legacyConfidence: Number.isFinite(weak.confidence) ? weak.confidence : null,
            rawStage: classify(centerRaw),
            smoothedStage: STAGES[centerSmooth.stageIndex] || '',
            causalStage: classify(causalRaw),
            causalSmoothedStage: STAGES[causalSmooth.stageIndex] || '',
            rawProbabilities: centerRaw,
            smoothedProbabilities: centerSmooth.probabilities,
            causalProbabilities: causalRaw,
            deltaRatioFullEpoch: Number.isFinite(centerFeature.deltaRatio) ? centerFeature.deltaRatio : null,
            deltaRatioTailEpoch: Number.isFinite(input.targetQuality?.deltaRatio) ? input.targetQuality.deltaRatio : null,
            slowWaveSeconds: candidate.weak.slowSeconds.get(targetEpoch) || 0,
            qualityOk: input.targetQuality?.ok === true,
            qualityReason: input.targetQuality?.reason || '',
        });
        if (maxEpochs > 0 && rows.length >= maxEpochs) break;
    }

    return {
        group: candidate.group,
        subject: candidate.subject,
        edfPath: candidate.edfPath,
        sampleRateHz: edf.sampleRateHz,
        sampleCount: edf.values.length,
        durationSeconds: edf.values.length / edf.sampleRateHz,
        completedEpochs,
        qualityPassed,
        rows,
        metrics: {
            rawCenter: metricSummary(rows, 'rawStage'),
            smoothedCenter: metricSummary(rows, 'smoothedStage'),
            rawCausal: metricSummary(rows, 'causalStage'),
            smoothedCausal: metricSummary(rows, 'causalSmoothedStage'),
            meanCenterProbabilities: STAGES.map((_stage, index) => mean(rows.map(row => row.rawProbabilities[index]))),
            meanDeltaRatio: mean(rows.map(row => row.deltaRatioFullEpoch).filter(Number.isFinite)),
            meanLegacySlowWaveSeconds: mean(rows.map(row => row.slowWaveSeconds)),
        },
    };
}

async function main() {
    const root = path.resolve(argValue('--root', '/Volumes/exchange/jh_test/sleep EEG/tLS_sleep'));
    const outputPath = path.resolve(argValue('--output', path.join(process.cwd(), 'analysis', 'n3-postprocess', 'tls-replay.json')));
    const maxFiles = numberArg('--max-files', 16);
    const maxEpochs = numberArg('--max-epochs', 0);
    const candidates = chooseFiles(await findBaselineEdfs(root), maxFiles);
    if (!candidates.length) throw new Error(`没有找到带弱参考分期的基线 EDF：${root}`);
    const modelPath = path.join(process.cwd(), 'models', 'stage1_sleep.onnx');
    const model = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
    const results = [];
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        console.error(`[${index + 1}/${candidates.length}] ${candidate.group}/${candidate.subject}/${path.basename(candidate.edfPath)}`);
        results.push(await replayFile(candidate, model, maxEpochs));
    }
    const allRows = results.flatMap(result => result.rows || []);
    const payload = {
        generatedAt: new Date().toISOString(),
        root,
        selectedFiles: candidates.length,
        modelPath,
        pipeline: { inputRateHz: 250, modelRateHz: 100, epochSeconds: 30, temporalContext: 21, filter: 'training 0.4-18Hz + training notch chain' },
        reference: 'legacy improved hypnogram (YASA plus heuristic correction); weak reference only, not AASM PSG ground truth',
        aggregate: {
            rows: allRows.length,
            rawCenter: metricSummary(allRows, 'rawStage'),
            smoothedCenter: metricSummary(allRows, 'smoothedStage'),
            rawCausal: metricSummary(allRows, 'causalStage'),
            smoothedCausal: metricSummary(allRows, 'causalSmoothedStage'),
        },
        files: results,
    };
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ outputPath, selectedFiles: candidates.length, rows: allRows.length, aggregate: payload.aggregate }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
});
