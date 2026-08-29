'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Worker } = require('node:worker_threads');
const Sleep = require('../src/realtime-sleep');
const SDK = require('../src/vendor/BrainLume_Lib');

const inputPath = process.argv[2] || 'I:\\光调控\\闭环脑调控\\eeg_raw.csv';
let requestId = 0;

function workerRequest(worker, payload, timeoutMs = 30_000) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            worker.off('message', listener);
            reject(new Error(`睡眠模型请求超时：${payload.type}`));
        }, timeoutMs);
        const listener = response => {
            if (response.id !== id) return;
            clearTimeout(timer);
            worker.off('message', listener);
            response.ok ? resolve(response.result) : reject(new Error(response.error));
        };
        worker.on('message', listener);
        worker.postMessage({ id, ...payload });
    });
}

async function main() {
    const worker = new Worker(path.join(__dirname, '..', 'sleep-stage-worker.js'));
    try {
        const info = await workerRequest(worker, { type: 'info' });
        const filter = new SDK.filters.EegFilterBank(250, 1, SDK.filters.MODEL_TRAINING_PRESET, {
            initialization: 'zero', implementation: 'direct2t',
        });
        const pipeline = new Sleep.RealtimeSleepPipeline({
            inputRateHz: 250, modelRateHz: 100, epochSeconds: 30, temporalContext: 21,
        });
        const stream = fs.createReadStream(inputPath, { encoding: 'utf8' });
        const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let header = null;
        let rawCodeIndex = -1;
        let seqGapIndex = -1;
        let rows = 0;
        let modelWindows = 0;
        let inferenceFailures = 0;
        const stageCounts = Object.fromEntries(Sleep.STAGES.map(stage => [stage, 0]));
        let confidenceSum = 0;
        let confidenceMin = Infinity;
        let confidenceMax = -Infinity;
        let firstResult = null;
        let lastResult = null;
        for await (const line of input) {
            if (!line) continue;
            if (!header) {
                header = line.split(',');
                rawCodeIndex = header.indexOf('raw_code');
                seqGapIndex = header.indexOf('seq_gap');
                if (rawCodeIndex < 0) throw new Error('CSV 缺少 raw_code 列');
                continue;
            }
            const fields = line.split(',');
            rows += 1;
            const rawCode = Number(fields[rawCodeIndex]);
            if (!Number.isFinite(rawCode)) continue;
            const filteredCode = filter.process(0, rawCode);
            const modelMicrovolts = SDK.data.codeToMicrovolts(filteredCode, { vrefVolts: 4.5, gain: 24 });
            const seqGap = seqGapIndex >= 0 ? Math.max(0, Number(fields[seqGapIndex]) || 0) : 0;
            const epoch = pipeline.push(modelMicrovolts, { seqGap });
            if (!epoch?.ready) continue;
            const modelInput = pipeline.inferenceInput();
            if (!modelInput) continue;
            modelWindows += 1;
            try {
                const result = await workerRequest(worker, {
                    type: 'infer', temporalContext: modelInput.temporalContext,
                    windowLength: modelInput.windowLength, eeg: modelInput.eeg,
                    epochIndex: modelInput.epochIndex, epochCycleIndex: modelInput.epochCycleIndex,
                    outputIndex: modelInput.outputIndex,
                });
                const stage = Sleep.STAGES[result.stage] || `Stage ${result.stage}`;
                const confidence = Math.max(...result.probabilities);
                stageCounts[stage] = (stageCounts[stage] || 0) + 1;
                confidenceSum += confidence;
                confidenceMin = Math.min(confidenceMin, confidence);
                confidenceMax = Math.max(confidenceMax, confidence);
                const record = { epochIndex: modelInput.classifiedEpochIndex, stage, confidence };
                if (!firstResult) firstResult = record;
                lastResult = record;
            } catch (error) {
                inferenceFailures += 1;
                if (inferenceFailures > 3) throw error;
            }
        }
        console.log(JSON.stringify({
            inputPath, modelInputs: info.inputs, rows, modelWindows, inferenceFailures,
            stageCounts,
            meanConfidence: modelWindows - inferenceFailures > 0 ? confidenceSum / (modelWindows - inferenceFailures) : null,
            minConfidence: Number.isFinite(confidenceMin) ? confidenceMin : null,
            maxConfidence: Number.isFinite(confidenceMax) ? confidenceMax : null,
            firstResult, lastResult,
            inference: { mode: 'center', outputIndex: 10, delaySeconds: 300 },
        }, null, 2));
    } finally {
        await worker.terminate();
    }
}

main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
});
