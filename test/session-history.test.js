'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionStagingHistory, selectCanonicalStagingRecords, computeOnlineSleepMetrics } = require('../src/session-history');

test('session staging history keeps both inference modes and sorts by epoch', () => {
    const result = parseSessionStagingHistory([
        JSON.stringify({ ts: '2026-08-30T01:00:02+08:00', action: 'sleep_stage_inferred', epochIndex: 1, stage: 'UNKNOWN', modelStage: 'N3', candidateStage: 'N3', candidateConfidence: .91, n3Status: 'suppressed', n3Reason: 'n3_probability_below_enter', n3Postprocessed: false, confidence: 0, probabilities: [0, 0, .8, .1, .1], inferenceMode: 'causal', modelDelaySeconds: 0, quality: { ok: true }, lightChannels: [2] }),
        JSON.stringify({ ts: '2026-08-30T01:00:01+08:00', action: 'sleep_stage_inferred', epochIndex: 0, stage: 'W', confidence: .9, probabilities: [ .9, .02, .02, .03, .03 ], inferenceMode: 'center', modelDelaySeconds: 300, quality: { ok: false, reason: 'low_quality' } }),
        JSON.stringify({ ts: '2026-08-30T01:00:03+08:00', action: 'unrelated' }),
        '{not-json}',
    ].join('\n'));
    assert.equal(result.records.length, 2);
    assert.deepEqual(result.records.map(record => record.epochIndex), [0, 1]);
    assert.equal(result.summary.epochCount, 2);
    assert.deepEqual(result.summary.modeCounts, { center: 1, causal: 1 });
    assert.equal(result.records[0].modelDelaySeconds, 300);
    assert.deepEqual(result.records[1].lightChannels, [2]);
    assert.equal(result.records[1].modelStage, 'N3');
    assert.equal(result.records[1].candidateStage, 'N3');
    assert.equal(result.records[1].candidateConfidence, .91);
    assert.equal(result.records[1].n3Status, 'suppressed');
    assert.equal(result.records[1].n3Postprocessed, false);
    assert.equal(result.ignoredLines, 1);
});

test('session staging history ignores malformed staging records and clamps unsafe values', () => {
    const result = parseSessionStagingHistory(JSON.stringify({
        action: 'sleep_stage_inferred', epochIndex: 3, stage: '<unsafe>', confidence: 4,
        probabilities: [-1, 0.25, 3], inferenceMode: 'causal', lightChannels: [2, 2, 9],
    }));
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].confidence, 1);
    assert.deepEqual(result.records[0].probabilities, [0, .25, 1]);
    assert.deepEqual(result.records[0].lightChannels, [2]);
    assert.equal(result.records[0].stage, '<unsafe>');
});

test('online sleep metrics deduplicate causal/center outputs and separate N3 quality states', () => {
    const event = (epochIndex, mode, fields = {}) => ({
        action: 'sleep_stage_inferred', epochIndex, inferenceMode: mode,
        ts: `2026-08-30T01:00:${String(epochIndex).padStart(2, '0')}+08:00`,
        quality: { ok: true }, stage: 'W', modelStage: 'W', candidateStage: 'W', ...fields,
    });
    const records = [
        event(0, 'center'), event(0, 'causal'),
        event(1, 'center', { stage: 'N1', modelStage: 'N1', candidateStage: 'N1' }),
        event(1, 'causal', { stage: 'N1', modelStage: 'N1', candidateStage: 'N1' }),
        event(2, 'causal', { stage: 'UNKNOWN', modelStage: 'N3', candidateStage: 'N3', n3Status: 'suppressed' }),
        event(3, 'causal', { stage: 'N2', modelStage: 'N2', candidateStage: 'N2' }),
        event(4, 'causal', { stage: 'N3', modelStage: 'N3', candidateStage: 'N3', n3Status: 'trusted' }),
        event(5, 'causal'),
        event(6, 'causal', { stage: 'UNKNOWN', modelStage: 'N3', candidateStage: 'N3', quality: { ok: false, reason: 'amplitude' } }),
    ];
    const metrics = computeOnlineSleepMetrics(records.map(JSON.stringify).map(JSON.parse));
    assert.equal(metrics.sourceRecordCount, 9);
    assert.equal(metrics.recordCount, 7);
    assert.equal(metrics.scoredEpochs, 5);
    assert.deepEqual(metrics.stageCounts, { W: 2, N1: 1, N2: 1, N3: 1, REM: 0 });
    assert.equal(metrics.totalSleepSeconds, 90);
    assert.equal(metrics.sleepEfficiencyPercent, 60);
    assert.equal(metrics.sleepOnsetEpoch, 1);
    assert.equal(metrics.wasoEpochs, 1);
    assert.equal(metrics.wasoSeconds, 30);
    assert.equal(metrics.transitionCount, 3);
    assert.equal(metrics.longestBouts.N3, 30);
    assert.equal(metrics.n3CandidateEpochs, 2);
    assert.equal(metrics.n3ConfirmedEpochs, 1);
    assert.equal(metrics.n3SuppressedEpochs, 1);
    assert.equal(metrics.n3QualityRejectedEpochs, 1);
    assert.equal(metrics.qualityRejectedEpochs, 1);
    assert.equal(metrics.unknownEpochs, 2);
});

test('canonical online staging selection uses the newest record within one mode', () => {
    const selected = selectCanonicalStagingRecords([
        { action: 'sleep_stage_inferred', epochIndex: 0, inferenceMode: 'center', ts: '2026-08-30T01:00:01+08:00', stage: 'W', quality: { ok: true } },
        { action: 'sleep_stage_inferred', epochIndex: 0, inferenceMode: 'center', ts: '2026-08-30T01:00:02+08:00', stage: 'N1', quality: { ok: true } },
        { action: 'sleep_stage_inferred', epochIndex: 1, inferenceMode: 'center', ts: '2026-08-30T01:00:03+08:00', stage: 'N2', quality: { ok: true } },
        { action: 'sleep_stage_inferred', epochIndex: 1, inferenceMode: 'causal', ts: '2026-08-30T00:59:00+08:00', stage: 'REM', quality: { ok: true } },
    ]);
    assert.deepEqual(selected.map(record => record.stage), ['N1', 'REM']);
});

test('online sleep metrics safely handle empty and old records', () => {
    const empty = computeOnlineSleepMetrics();
    assert.equal(empty.recordCount, 0);
    assert.equal(empty.sleepOnsetEpoch, null);
    assert.equal(empty.sleepEfficiencyPercent, null);
    assert.deepEqual(empty.stageCounts, { W: 0, N1: 0, N2: 0, N3: 0, REM: 0 });

    const old = computeOnlineSleepMetrics({ records: [
        { epochIndex: 0, stage: 'N3', mode: 'center', quality: true },
    ] });
    assert.equal(old.recordCount, 1);
    assert.equal(old.stageCounts.N3, 1);
    assert.equal(old.n3CandidateEpochs, 1);
    assert.equal(old.n3ConfirmedEpochs, 1);
});
