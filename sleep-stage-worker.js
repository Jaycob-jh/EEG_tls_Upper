'use strict';

const { parentPort } = require('node:worker_threads');
const path = require('node:path');
const ort = require('onnxruntime-node');
const {
    createValidatedSession,
    inspectRuntimeOutputs,
    INTEGRITY_ERROR_CODE,
} = require('./src/sleep-model-integrity');

const modelPath = path.join(__dirname, 'models', 'stage1_sleep.onnx');
let sessionPromise = null;
let integrityReport = null;

function session() {
    if (!sessionPromise) {
        sessionPromise = createValidatedSession({ rootDir: __dirname, modelPath }, targetPath => ort.InferenceSession.create(targetPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
        })).then(result => {
            integrityReport = {
                assets: result.assetReport.actualHashes,
                metadata: result.assetReport.metadataSummary,
                interface: result.interfaceReport,
            };
            return result.session;
        });
    }
    return sessionPromise;
}

function selectedProbability(output, temporalContext, outputIndex) {
    const data = Array.from(output.data, Number);
    const classes = 5;
    if (data.length === classes) return data;
    if (data.length !== temporalContext * classes) {
        throw new Error(`Unexpected sleep-model output shape ${JSON.stringify(output.dims)}`);
    }
    if (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= temporalContext) {
        throw new RangeError(`Sleep-model output index must be 0~${temporalContext - 1}`);
    }
    const offset = outputIndex * classes;
    return data.slice(offset, offset + classes);
}

parentPort.on('message', async message => {
    const { id, type } = message;
    try {
        const model = await session();
        if (type === 'info') {
            parentPort.postMessage({ id, ok: true, result: {
                modelPath,
                inputs: model.inputNames,
                outputs: model.outputNames,
                integrity: integrityReport,
            } });
            return;
        }
        if (type !== 'infer') throw new Error(`Unknown sleep worker request: ${type}`);
        const temporalContext = Number(message.temporalContext || 21);
        const windowLength = Number(message.windowLength || 3000);
        const outputIndex = Number(message.outputIndex ?? Math.floor(temporalContext / 2));
        const feeds = {
            eeg: new ort.Tensor('float32', Float32Array.from(message.eeg), [1, temporalContext, 1, windowLength]),
            epoch_index: new ort.Tensor('float32', Float32Array.from(message.epochIndex), [1, temporalContext, 1]),
            epoch_cycle_index: new ort.Tensor('float32', Float32Array.from(message.epochCycleIndex), [1, temporalContext, 5]),
        };
        const output = await model.run(feeds);
        const runtimeOutputReport = inspectRuntimeOutputs(output);
        if (!runtimeOutputReport.ok) {
            const error = new Error(`Sleep-model runtime output integrity check failed: ${runtimeOutputReport.errors.join('; ')}`);
            error.code = INTEGRITY_ERROR_CODE;
            throw error;
        }
        const probabilities = selectedProbability(output.prob, temporalContext, outputIndex);
        const probabilitySum = probabilities.reduce((sum, value) => sum + value, 0);
        const normalized = probabilitySum > 0 ? probabilities.map(value => value / probabilitySum) : probabilities;
        const stage = normalized.indexOf(Math.max(...normalized));
        parentPort.postMessage({ id, ok: true, result: {
            stage,
            probabilities: normalized,
            outputDims: output.prob.dims,
            selectedOutputIndex: outputIndex,
        } });
    } catch (error) {
        parentPort.postMessage({
            id,
            ok: false,
            errorCode: error?.code || null,
            error: error?.stack || error?.message || String(error),
        });
    }
});
