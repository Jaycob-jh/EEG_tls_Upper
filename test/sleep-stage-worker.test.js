'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Integrity = require('../src/sleep-model-integrity');

function request(worker, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sleep worker timeout')), 20000);
        const listener = response => {
            if (response.id !== message.id) return;
            clearTimeout(timer);
            worker.off('message', listener);
            response.ok ? resolve(response.result) : reject(new Error(response.error));
        };
        worker.on('message', listener);
        worker.postMessage(message);
    });
}

test('exported Stage-1 ONNX model can select the latest causal epoch output', { timeout: 30000 }, async () => {
    const worker = new Worker(path.join(__dirname, '..', 'sleep-stage-worker.js'));
    try {
        const info = await request(worker, { id: 1, type: 'info' });
        assert.deepEqual(info.inputs.sort(), ['eeg', 'epoch_cycle_index', 'epoch_index']);
        assert.deepEqual(info.outputs.sort(), ['logits', 'prob']);
        assert.equal(info.integrity.metadata.temporalContext, 21);
        assert.equal(info.integrity.metadata.centerOutputIndex, 10);
        assert.equal(info.integrity.metadata.causalOutputIndex, 20);
        const result = await request(worker, {
            id: 2,
            type: 'infer',
            temporalContext: 21,
            windowLength: 3000,
            eeg: new Float32Array(21 * 3000),
            epochIndex: new Float32Array(21),
            epochCycleIndex: new Float32Array(21 * 5),
            outputIndex: 20,
        });
        assert.equal(result.probabilities.length, 5);
        assert.equal(result.outputDims.join('x'), '21x5');
        assert.equal(result.selectedOutputIndex, 20);
        assert.ok(Math.abs(result.probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-5);
        assert.ok(result.stage >= 0 && result.stage < 5);
    } finally {
        await worker.terminate();
    }
});

test('sleep model provenance is portable and matches the deployed model contract', () => {
    const rootDir = path.resolve(__dirname, '..');
    const report = Integrity.inspectSleepModelAssets({ rootDir });
    assert.equal(report.ok, true, report.errors.join('\n'));
    assert.deepEqual(report.metadataSummary.inputNames, ['eeg', 'epoch_index', 'epoch_cycle_index']);
    assert.deepEqual(report.metadataSummary.outputNames, ['logits', 'prob']);
    assert.equal(report.metadataSummary.temporalContext, 21);
    assert.equal(report.metadataSummary.centerOutputIndex, 10);
    assert.equal(report.metadataSummary.causalOutputIndex, 20);
    assert.equal(report.files.onnx.actualSha256, report.files.onnx.expectedSha256);
    assert.equal(report.files.onnx_data.actualSha256, report.files.onnx_data.expectedSha256);
    assert.equal(report.files.metadata.actualSha256, report.files.metadata.expectedSha256);
});

test('sleep model integrity fails closed before session creation on a hash mismatch', async () => {
    const rootDir = path.resolve(__dirname, '..');
    const provenance = JSON.parse(fs.readFileSync(
        path.join(rootDir, 'models', 'stage1_sleep.provenance.json'), 'utf8',
    ));
    provenance.upper_assets.onnx.sha256 = '0'.repeat(64);
    let createCalls = 0;
    await assert.rejects(
        Integrity.createValidatedSession({ rootDir, provenance }, async () => {
            createCalls += 1;
            return {};
        }),
        error => error.code === Integrity.INTEGRITY_ERROR_CODE
            && /asset\.onnx\.sha256/.test(error.message),
    );
    assert.equal(createCalls, 0);
});
