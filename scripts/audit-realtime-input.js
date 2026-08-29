'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const Sleep = require('../src/realtime-sleep');
const SDK = require('../src/vendor/BrainLume_Lib');

const inputPath = process.argv[2] || 'I:\\光调控\\闭环脑调控\\eeg_raw.csv';
const filter = new SDK.filters.EegFilterBank(250, 1, SDK.filters.MODEL_TRAINING_PRESET, {
    initialization: 'zero', implementation: 'direct2t',
});
const pipeline = new Sleep.RealtimeSleepPipeline({
    inputRateHz: 250, modelRateHz: 100, epochSeconds: 30, temporalContext: 21,
});

let header = null;
let rawCodeIndex = -1;
let seqGapIndex = -1;
let rows = 0;
let finiteRawCodes = 0;
let nonFiniteRawCodes = 0;
let nonFiniteFilteredCodes = 0;
let nonFiniteModelMicrovolts = 0;
let sequenceGapEvents = 0;
let sequenceGapSamples = 0;
let completedEpochs = 0;
let qualityPassedEpochs = 0;
let qualityFailedEpochs = 0;
let centeredWindows = 0;
let maxAbsFilteredCode = 0;
let maxAbsModelMicrovolts = 0;

function parseCsvRow(line) {
    // The recorded schema contains no commas inside the numeric fields used here;
    // keep this audit intentionally narrow and avoid loading the 1.2 GB file.
    return line.split(',');
}

async function main() {
    const stream = fs.createReadStream(inputPath, { encoding: 'utf8' });
    const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of input) {
        if (!line) continue;
        if (!header) {
            header = parseCsvRow(line);
            rawCodeIndex = header.indexOf('raw_code');
            seqGapIndex = header.indexOf('seq_gap');
            if (rawCodeIndex < 0) throw new Error('CSV 缺少 raw_code 列');
            continue;
        }
        const fields = parseCsvRow(line);
        rows += 1;
        const rawCode = Number(fields[rawCodeIndex]);
        if (!Number.isFinite(rawCode)) {
            nonFiniteRawCodes += 1;
            continue;
        }
        finiteRawCodes += 1;
        const filteredCode = filter.process(0, rawCode);
        if (!Number.isFinite(filteredCode)) nonFiniteFilteredCodes += 1;
        maxAbsFilteredCode = Math.max(maxAbsFilteredCode, Math.abs(filteredCode));
        const modelMicrovolts = SDK.data.codeToMicrovolts(filteredCode, { vrefVolts: 4.5, gain: 24 });
        if (!Number.isFinite(modelMicrovolts)) nonFiniteModelMicrovolts += 1;
        maxAbsModelMicrovolts = Math.max(maxAbsModelMicrovolts, Math.abs(modelMicrovolts));
        const seqGap = seqGapIndex >= 0 ? Math.max(0, Number(fields[seqGapIndex]) || 0) : 0;
        if (seqGap > 0) {
            sequenceGapEvents += 1;
            sequenceGapSamples += seqGap;
        }
        const epoch = pipeline.push(modelMicrovolts, { seqGap });
        if (!epoch) continue;
        completedEpochs += 1;
        if (epoch.quality.ok) qualityPassedEpochs += 1;
        else qualityFailedEpochs += 1;
        if (epoch.ready) centeredWindows += 1;
    }
    console.log(JSON.stringify({
        inputPath, rows, finiteRawCodes, nonFiniteRawCodes,
        nonFiniteFilteredCodes, nonFiniteModelMicrovolts,
        sequenceGapEvents, sequenceGapSamples, completedEpochs,
        qualityPassedEpochs, qualityFailedEpochs, centeredWindows,
        pendingSamples: pipeline.current.length,
        retainedEpochs: pipeline.epochs.length,
        maxAbsFilteredCode, maxAbsModelMicrovolts,
        model: { inputRateHz: 250, modelRateHz: 100, epochSeconds: 30, temporalContext: 21,
            modelEpochLength: pipeline.modelEpochLength, output: 'center', delaySeconds: 300 },
    }, null, 2));
}

main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
});
