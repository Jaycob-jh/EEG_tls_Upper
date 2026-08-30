'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Postprocess = require('../src/sleep-stage-postprocess');

function input(epochIndex, stage = 'N3', probabilities = [0.01, 0.01, 0.01, 0.96, 0.01], extra = {}) {
    return { epochIndex, rawStage: stage, rawProbabilities: probabilities, quality: { ok: true }, ...extra };
}

test('normalizes options without inventing a fixed deltaRatio threshold', () => {
    const options = Postprocess.normalizeOptions();
    assert.equal(options.mode, 'center');
    assert.equal(options.minN3Probability, 0.92);
    assert.equal(options.minDeltaRatio, null);
    assert.deepEqual(Postprocess.validateOptions({ deltaEvidencePolicy: 'support' }).length, 1);
    assert.throws(() => Postprocess.normalizeOptions({ deltaEvidencePolicy: 'support' }), /显式配置 minDeltaRatio/);
});

test('confirms high-probability N3 only after consecutive epochs', () => {
    const processor = new Postprocess.N3Postprocessor({ mode: 'causal', enterConsecutiveEpochs: 2 });
    const first = processor.update(input(1));
    assert.equal(first.stage, 'UNKNOWN');
    assert.equal(first.n3Status, 'pending');
    assert.equal(first.controlEligible, false);
    const second = processor.update(input(2, 'N3', [0.01, 0.01, 0.01, 0.97, 0], { controlEligible: true }));
    assert.equal(second.stage, 'N3');
    assert.equal(second.n3Status, 'trusted');
    assert.equal(second.controlEligible, true);
    assert.equal(second.rawProbabilities[3], 0.97);
});

test('suppresses an isolated N3 instead of silently converting it to N2', () => {
    const processor = new Postprocess.N3Postprocessor({ enterConsecutiveEpochs: 2 });
    const result = processor.update(input(1));
    assert.equal(result.stage, 'UNKNOWN');
    assert.equal(result.n3Status, 'pending');
    assert.notEqual(result.stage, 'N2');
    assert.equal(result.reason, 'n3_waiting_consecutive');
});

test('rejects bad quality and clears an active N3 state', () => {
    const processor = new Postprocess.N3Postprocessor({ mode: 'causal', enterConsecutiveEpochs: 1 });
    assert.equal(processor.update(input(1, 'N3', undefined, { controlEligible: true })).n3Status, 'trusted');
    const bad = processor.update(input(2, 'N3', undefined, { quality: { ok: false, reason: 'flatline' }, controlEligible: true }));
    assert.equal(bad.stage, 'UNKNOWN');
    assert.equal(bad.n3Status, 'suppressed');
    assert.equal(bad.controlEligible, false);
    assert.equal(bad.reason, 'flatline');
    assert.equal(processor.update(input(3, 'N3', undefined, { controlEligible: true })).n3Status, 'trusted');
});

test('uses configured delta evidence only when explicitly enabled', () => {
    const ignored = new Postprocess.N3Postprocessor({ enterConsecutiveEpochs: 1 });
    assert.equal(ignored.update(input(1, 'N3', undefined, { deltaRatio: 0.01 })).stage, 'N3');
    const supported = new Postprocess.N3Postprocessor({
        enterConsecutiveEpochs: 1, deltaEvidencePolicy: 'support', minDeltaRatio: 0.8,
    });
    assert.equal(supported.update(input(1, 'N3', undefined, { deltaRatio: 0.2 })).stage, 'UNKNOWN');
    assert.equal(supported.update(input(2, 'N3', undefined, { deltaRatio: 0.9 })).stage, 'N3');
});

test('accepts optional slow-wave evidence without making it mandatory by default', () => {
    const optional = new Postprocess.N3Postprocessor({ enterConsecutiveEpochs: 1 });
    assert.equal(optional.update(input(1)).stage, 'N3');
    const required = new Postprocess.N3Postprocessor({
        enterConsecutiveEpochs: 1, slowWaveEvidencePolicy: 'require', minSlowWaveSeconds: 6,
    });
    assert.equal(required.update(input(1)).reason, 'n3_evidence_missing');
    const result = required.update(input(2, 'N3', undefined, {
        slowWaveEvidence: { present: true, seconds: 8, score: 0.8 },
    }));
    assert.equal(result.stage, 'N3');
    assert.equal(result.n3Evidence.slow.ok, true);
});

test('distinguishes center and causal control context', () => {
    const center = new Postprocess.N3Postprocessor({ enterConsecutiveEpochs: 1 });
    const centerResult = center.update(input(1, 'N3', undefined, { controlEligible: true }));
    assert.equal(centerResult.n3Status, 'trusted');
    assert.equal(centerResult.controlEligible, false);
    assert.equal(centerResult.controlEligibilityReason, 'retrospective_center_output');
    const causal = new Postprocess.N3Postprocessor({ mode: 'causal', enterConsecutiveEpochs: 1 });
    const noContext = causal.update(input(1, 'N3', undefined, { controlEligible: false }));
    assert.equal(noContext.stage, 'N3');
    assert.equal(noContext.controlEligible, false);
    assert.equal(noContext.controlEligibilityReason, 'context_not_ready');
});

test('reset starts a fresh consecutive run and input arrays are not mutated', () => {
    const processor = new Postprocess.N3Postprocessor({ enterConsecutiveEpochs: 2 });
    const probabilities = [0.01, 0.01, 0.01, 0.96, 0.01];
    const original = probabilities.slice();
    assert.equal(processor.update(input(1, 'N3', probabilities)).n3Status, 'pending');
    assert.deepEqual(probabilities, original);
    processor.reset();
    assert.equal(processor.update(input(1, 'N3', probabilities)).n3Status, 'pending');
});

test('applies exit hysteresis before suppressing a falling N3 sequence', () => {
    const processor = new Postprocess.N3Postprocessor({
        enterConsecutiveEpochs: 1, exitConsecutiveEpochs: 2, exitN3Probability: 0.75,
    });
    assert.equal(processor.update(input(1)).stage, 'N3');
    const firstLow = processor.update(input(2, 'N3', [0.1, 0.1, 0.1, 0.6, 0.1]));
    assert.equal(firstLow.stage, 'N3');
    assert.equal(firstLow.n3Status, 'pending_exit');
    const secondLow = processor.update(input(3, 'N3', [0.1, 0.1, 0.1, 0.6, 0.1]));
    assert.equal(secondLow.stage, 'UNKNOWN');
    assert.equal(secondLow.n3Status, 'suppressed');
});

test('does not mutate raw probability values and exposes normalized probabilities', () => {
    const processor = new Postprocess.N3Postprocessor({ enterConsecutiveEpochs: 1 });
    const result = processor.update(input(1, 'N3', [1, 1, 1, 96, 1]));
    assert.deepEqual(result.rawProbabilities, [1, 1, 1, 96, 1]);
    assert.ok(Math.abs(result.normalizedProbabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    assert.equal(result.stage, 'N3');
});
