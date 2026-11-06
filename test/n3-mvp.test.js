'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assess, buildN3Mvp, FEATURE_VERSION } = require('../src/n3-mvp');
const row = { epochIndex: 0, startSec: 0, endSec: 30, anysleep: 'W',
    anysleepDetrended: 'N3', yasa: 'N3', caocao: 'N2', caocaoQuality: 'ok' };
const clean = { epochIndex: 0, strictSlowSeconds: 6, railSamples: 0,
    flatSeconds: .04, rawStepUv: 35, hpPeakUv: 65, rawDriftPercent: 5, inputClippedPercent: 0 };

test('Offline N3 candidate needs physical slow waves plus distinct models; it does not override the stage', () => {
    const mvp = buildN3Mvp([row], { settings: { version: FEATURE_VERSION }, rows: [clean] });
    assert.equal(mvp.offlineOnly, true);
    assert.equal(mvp.counts.candidate, 1);
    assert.equal(mvp.rows[0].caocao, 'N2');
    assert.equal(mvp.rows[0].status, 'candidate');
    assert.equal(Object.hasOwn(mvp.rows[0], 'controlEligible'), false);
    assert.equal(assess({ ...row, anysleep: 'N3', yasa: 'N2' }, clean).status, 'review');
    assert.equal(assess(row, { ...clean, strictSlowSeconds: 5.996 }).status, 'review');
});

test('Quality rejection and warnings cannot become priority N3 candidates', () => {
    for (const bad of [{ railSamples: 1 }, { rawStepUv: 250 }, { hpPeakUv: 501 }, { flatSeconds: 2 }]) {
        assert.equal(assess(row, { ...clean, ...bad }).status, 'insufficient');
    }
    const drift = assess(row, { ...clean, rawDriftPercent: 95 });
    assert.equal(drift.status, 'review');
    assert.ok(drift.reasons.includes('quality_warning'));
    assert.ok(drift.warnings.includes('drift_dominant'));
    assert.equal(assess(row, { ...clean, inputClippedPercent: 1 }).status, 'review');
    const missing = assess({ ...row, caocaoQuality: 'center_context_edge' }, clean);
    assert.deepEqual(missing.reasons, ['center_unavailable']);
});

test('No alert does not hide strong slow waves; mismatched evidence cannot be assigned to an epoch', () => {
    const negative = { ...row, anysleepDetrended: 'W', yasa: 'N2' };
    assert.equal(assess(negative, { ...clean, strictSlowSeconds: 0 }).status, 'no_alert');
    assert.equal(assess(negative, clean).status, 'review');
    assert.throws(() => buildN3Mvp([row], { settings: { version: FEATURE_VERSION }, rows: [{ ...clean, epochIndex: 1 }] }), /对齐/);
});
