'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

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
