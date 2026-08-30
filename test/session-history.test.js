'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSessionStagingHistory } = require('../src/session-history');

test('session staging history keeps both inference modes and sorts by epoch', () => {
    const result = parseSessionStagingHistory([
        JSON.stringify({ ts: '2026-08-30T01:00:02+08:00', action: 'sleep_stage_inferred', epochIndex: 1, stage: 'N2', modelStage: 'N3', n3Status: 'suppressed', n3Reason: 'n3_probability_below_enter', n3Postprocessed: false, confidence: .8, probabilities: [0, 0, .8, .1, .1], inferenceMode: 'causal', modelDelaySeconds: 0, quality: { ok: true }, lightChannels: [2] }),
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
