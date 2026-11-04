'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SDK = require('../src/vendor/BrainLume_Lib');
test('removing unused streaming diagnostics preserves raw and display-filtered sample values', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    const start = source.indexOf('            const processor = new SDK.EegProcessor(');
    const end = source.indexOf('            const sleepModelFilter =', start);
    const context = vm.createContext({ SDK, state: { waveformMax: 15000 } });
    vm.runInContext(source.slice(start, end) + '\nglobalThis.processor = processor;', context);
    const actual = context.processor;
    const previous = new SDK.EegProcessor({ sampleRateHz: 250, historyPoints: 15000,
        filter: { enabled: true, preset: 'eeg-display-0p5-45' },
        fft: { enabled: true, size: 256, updateEvery: 25, maxHz: 60, log10: true },
        impedance: { preset: 'brainlume-24na-v1' } });
    const payload = new Uint8Array(29);
    for (let i=0; i<1300; i++) {
        payload[0] = i >>> 8; payload[1] = i & 255;
        for(let ch=0; ch<8; ch++) { const code=Math.round(1500*Math.sin(i*.03+ch));const p=5+ch*3;payload[p]=code>>>16&255;payload[p+1]=code>>>8&255;payload[p+2]=code&255; }
        const a=actual.processPayload(payload), b=previous.processPayload(payload);
        assert.deepEqual(a.rawCodes, b.rawCodes);
        assert.deepEqual(a.filteredMicrovolts, b.filteredMicrovolts);
    }
    assert.equal(actual.impedance, null);
    assert.equal(actual.options.fft.enabled, false);
    assert.equal(actual.history[0].length, 256);
});
