'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { EdfWriter, readEdf } = require('../src/edf');
const SDK = require('../src/vendor/BrainLume_Lib');

test('EDF writer preserves raw sample count and records final padding explicitly', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'brainlume-edf-'));
    const partial = path.join(directory, 'eeg_raw.edf.partial');
    const final = path.join(directory, 'eeg_raw.edf');
    try {
        const writer = await EdfWriter.create(partial, {
            startTime: '2026-08-27T20:00:00+08:00', label: 'EEG CH2', sampleRateHz: 250,
        });
        await writer.appendSamples(Array.from({ length: 255 }, (_value, index) => index - 100));
        const result = await writer.finalize();
        await fs.rename(partial, final);
        const edf = await readEdf(final);
        assert.equal(result.receivedSamples, 255);
        assert.equal(result.records, 2);
        assert.equal(result.paddedSamples, 245);
        assert.equal(edf.values.length, 500);
        assert.equal(edf.sampleRateHz, 250);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('sleep model exposes the exact training filter preset at 250 Hz', () => {
    const filter = new SDK.filters.EegFilterBank(250, 1, SDK.filters.MODEL_TRAINING_PRESET, {
        initialization: 'zero', implementation: 'direct2t',
    });
    assert.equal(filter.supported, true);
    const values = Array.from({ length: 5000 }, (_value, index) => 19000 + Math.sin(index / 20));
    for (const value of values) assert.equal(Number.isFinite(filter.process(0, value)), true);
});

test('direct-form-II-transposed filter uses zero initial state when requested', () => {
    const filter = new SDK.filters.IirFilter({ b: [1, 0], a: [1, -0.5] }, {
        initialization: 'zero', implementation: 'direct2t',
    });
    assert.deepEqual([1, 0, 0].map(value => Number(filter.process(value).toFixed(8))), [1, 0.5, 0.25]);
    filter.reset();
    assert.equal(Number(filter.process(1).toFixed(8)), 1);
});
