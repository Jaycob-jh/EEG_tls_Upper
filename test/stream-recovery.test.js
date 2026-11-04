'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SDK = require('../src/vendor/BrainLume_Lib');
const Sleep = require('../src/realtime-sleep');

test('a false long header does not stall the next complete verified EEG frame', () => {
    const errors = [];
    const parser = new SDK.protocol.ActionBusParser({ onError: e => errors.push(e) });
    const good = SDK.protocol.buildFrame(1, 0x22, 0, new Uint8Array(29));
    const frames = parser.feed(Uint8Array.from([0xaa, 0x55, 1, 0x22, 0, 255, 0, 0, ...good]));
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].raw, good);
    assert.equal(errors.length, 1);
});

test('all split positions preserve valid frames, including an embedded header', () => {
    const payload = new Uint8Array(29); payload[8] = 0xaa; payload[9] = 0x55;
    const good = SDK.protocol.buildFrame(1, 0x22, 0, payload);
    for (let split = 1; split < good.length; split++) {
        const parser = new SDK.protocol.ActionBusParser();
        assert.equal(parser.feed(good.slice(0, split)).length, 0);
        assert.deepEqual(parser.feed(good.slice(split))[0].raw, good);
    }
});

test('CRC-corrupted EEG never enters the received frame list', () => {
    const good = SDK.protocol.buildFrame(1, 0x22, 0, new Uint8Array(29));
    const bad = good.slice(); bad[10] ^= 1;
    const parser = new SDK.protocol.ActionBusParser();
    const frames = parser.feed(Uint8Array.from([...bad, ...good]));
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].raw, good);
});

test('raw ADC saturation rejects an otherwise normal filtered model epoch', () => {
    const p = new Sleep.RealtimeSleepPipeline();
    let epoch;
    for (let i = 0; i < 7500; i++) epoch = p.push(20 * Math.sin(i * .05), { rawCode: i === 1 ? 8388607 : 1000 });
    assert.equal(epoch.quality.reason, 'raw_saturation');
    assert.equal(epoch.quality.rawSaturatedSamples, 1);
    assert.equal(p.onlineInferenceInput().controlEligible, false);
});

test('a sequence gap spanning epochs stays invalid in every affected epoch', () => {
    const p = new Sleep.RealtimeSleepPipeline();
    const first = p.push(10, { seqGap: 15000 });
    assert.equal(first.gapSamples, 7500);
    const second = p.push(10);
    assert.equal(second.gapSamples, 7500);
    assert.equal(second.quality.ok, false);
    assert.equal(p.onlineInferenceInput(), null);
});
