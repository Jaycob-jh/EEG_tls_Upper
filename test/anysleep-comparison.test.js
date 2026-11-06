'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { alignStages } = require('../src/anysleep-comparison');

test('Both AnySleep paths align by EDF epoch and report separate three-model N3 disagreements', () => {
    const center = (epochIndex, stage, ok = true) => ({ epochIndex, stage, modelStage: stage, quality: { ok, reason: ok ? 'ok' : 'artifact' } });
    const result = alignStages({
        epochCount: 7,
        anysleep: ['N3', 'N3', 'N3', 'N3', 'N3', 'N2', 'W'],
        anysleepDetrended: ['N2', 'N3', 'N3', 'N3', 'N3', 'N3', 'N3'],
        anysleepDetrendedN3Probability: [0.1, 0.8, 0.7, 0.6, 0.9, 0.7, 0.8],
        yasa: ['N2', 'N2', 'N2', 'N2', 'N2', 'N3', 'N3'],
    }, [center(1, 'N2'), center(2, 'N2'), center(3, 'N2', false),
        center(4, 'N2'), center(5, 'N2'), center(6, 'N3')]);

    assert.equal(result.rows[0].caocao, null);
    assert.equal(result.rows[3].caocao, null);
    assert.equal(result.rows[3].caocaoCandidate, 'N2');
    assert.equal(result.rows[1].anysleepDetrendedN3Probability, 0.8);
    assert.equal(result.stats.stageCounts.anysleep.W, 1);
    assert.equal(result.stats.stageCounts.anysleepDetrended.N3, 6);
    assert.equal(result.stats.available.caocao, 5);
    const { original, detrended } = result.comparisons;
    assert.equal(original.commonEpochs, 5);
    assert.equal(detrended.commonEpochs, 5);
    assert.equal(original.allN3, 0);
    assert.equal(detrended.allN3, 1);
    assert.equal(original.n3Disagreements, 5);
    assert.equal(detrended.n3Disagreements, 4);
    assert.deepEqual(original.intervals.map(item => [item.startSec, item.endSec, item.pattern]),
        [[30, 90, 'anysleep'], [120, 150, 'anysleep'], [150, 180, 'yasa'], [180, 210, 'yasa+caocao']]);
    assert.deepEqual(detrended.intervals.map(item => [item.startSec, item.endSec, item.pattern]),
        [[30, 90, 'anysleepDetrended'], [120, 150, 'anysleepDetrended'], [150, 180, 'anysleepDetrended+yasa']]);
});

test('AnySleep rejects unequal output lengths and duplicate center indices', () => {
    assert.throws(() => alignStages({ epochCount: 1, anysleep: ['N2'], anysleepDetrended: [], yasa: ['N2'] }, []), /片段数/);
    assert.throws(() => alignStages({ epochCount: 1, anysleep: ['N2'], anysleepDetrended: ['N2'], yasa: ['N2'] },
        [{ epochIndex: 0 }, { epochIndex: 0 }]), /重复/);
});

test('N3 outside CaoCao coverage remains visible without being counted as disagreement', () => {
    const result = alignStages({ epochCount: 1, anysleep: ['W'], anysleepDetrended: ['N3'], yasa: ['N3'] }, []);
    assert.equal(result.stats.stageCounts.anysleepDetrended.N3, 1);
    assert.equal(result.comparisons.detrended.commonN3Counts.anysleepDetrended, 0);
    assert.equal(result.comparisons.detrended.commonEpochs, 0);
    assert.deepEqual(result.comparisons.detrended.intervals, []);
});
