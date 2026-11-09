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

test('a complete frame-shaped byte sequence inside fragmented EEG stays payload', () => {
    const embedded = SDK.protocol.buildFrame(1, 0x01, 0, []);
    const payload = new Uint8Array(29);
    payload.set(embedded, 8);
    const eeg = SDK.protocol.buildFrame(1, 0x22, 1, payload);
    const split = 6 + 8 + embedded.length;
    const parser = new SDK.protocol.ActionBusParser();
    assert.deepEqual(parser.feed(eeg.slice(0, split)), []);
    assert.deepEqual(parser.feed(eeg.slice(split)).map(frame => frame.raw), [eeg]);
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

test('truncated EEG frames at observed offsets do not consume the next valid frame', () => {
    const buildEeg = sequence => {
        const payload = new Uint8Array(29);
        payload[1] = sequence;
        payload[2] = 0xc0;
        return SDK.protocol.buildFrame(1, 0x22, 1, payload);
    };
    const previous = buildEeg(10);
    const next = buildEeg(11);
    for (const offset of [25, 31]) {
        const bytes = Uint8Array.from([...previous.slice(0, offset), ...next]);
        for (let split = 1; split < bytes.length; split++) {
            const errors = [];
            const parser = new SDK.protocol.ActionBusParser({ onError: error => errors.push(error) });
            const frames = [...parser.feed(bytes.slice(0, split)), ...parser.feed(bytes.slice(split))];
            assert.deepEqual(frames.map(frame => frame.raw), [next]);
            assert.ok(errors.some(error => error.name === 'CrcError'));
        }
    }
});
