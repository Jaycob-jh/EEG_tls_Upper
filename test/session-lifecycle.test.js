'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sleep = require('../src/realtime-sleep');
const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
function extract(first, next) { return source.slice(source.indexOf(first), source.indexOf(next)); }

test('turning automatic light off and on does not erase the last trigger interval', async () => {
    const gate = new Sleep.SleepStageStimulusGate({ enabled: true });
    gate.lastTriggeredAt = 123456;
    const state = { sleepStimulusProtocol: { ...gate.protocol }, sleepStimulusGate: gate };
    const context = vm.createContext({ state, clearTimeout, $: () => ({}),
        setSleepStimulusStatus() {}, audit: async () => {}, withLightLease: async fn => fn(), stopLight: async () => {} });
    vm.runInContext(extract('    async function disableSleepStimulus(', '    async function preemptSleepStimulus('), context);
    await context.disableSleepStimulus('test');
    assert.equal(gate.lastTriggeredAt, 123456);
    assert.equal(gate.protocol.enabled, false);
});

test('a rejected EEG stop must retain acquisition and its open recording for a retry', async () => {
    let finished = 0;
    const state = { eegRunning: true, activeSession: { id: 'night' } };
    const context = vm.createContext({ state,
        disableSleepStimulus: async () => {}, requireClient: () => ({ stopEeg: async () => { throw Error('device refused stop'); }, getStatus: async () => ({ eegRunning: true }) }),
        logProtocol() {}, audit: async () => {}, updateEegUi() {}, renderNextAction() {}, addActivity() {},
        finishSession: async () => { finished++; },
    });
    vm.runInContext(extract('    async function stopEegOnDevice(', '    async function measureImpedance('), context);
    await assert.rejects(context.stopEeg());
    assert.equal(state.eegRunning, true);
    assert.equal(finished, 0);
});

test('disk-write failure stops acquisition without awaiting its own pending flush', async () => {
    let stopped = false, stopCount = 0;
    const state = { activeSession: { id: 'night' }, edfQueue: [{ rawCode: 1, seq: 1, elapsedMs: 4 }],
        edfFlushPromise: Promise.resolve(), sessionEventPromise: Promise.resolve() };
    const context = vm.createContext({ state, Promise, setTimeout, queueMicrotask,
        window: { desktopAPI: { appendSessionSamples: async () => { throw Error('disk full'); }, stopSession: async () => { stopped = true; return {}; } } },
        logProtocol() {}, toast() {}, audit: async () => {}, updateEegUi() {}, loadSessions: async () => {}, addActivity() {},
        safeStop: async () => { stopCount++; await context.finishSession('interrupted', 'edf_write_failed'); },
    });
    vm.runInContext(extract('    function flushEdfQueue(', '    async function executePlanAction('), context);
    await Promise.race([context.flushEdfQueue(), new Promise((_, reject) => setTimeout(() => reject(Error('write failure deadlocked')), 200))]);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(stopped, true);
    assert.equal(stopCount, 1);
});

function recordingHarness({ appendFailure = false, metadataFailure = false } = {}) {
    let finalized = 0, metadataAttempts = 0;
    const renames = [];
    const recording = { appendPromise: appendFailure ? Promise.reject(Error('disk full')) : Promise.resolve(),
        session: { id: 'night', directory: '/test/night' },
        edfPartial: '/test/night/eeg_raw.edf.partial', edfFinal: '/test/night/eeg_raw.edf',
        rawPartial: '/test/night/raw_adc.bin.partial', eventsPath: '/test/night/events.jsonl',
        edfWriter: { finalize: async () => { finalized++; return { receivedSamples: 512, records: 3, paddedSamples: 238 }; } },
    };
    const activeRecordings = new Map([['night', recording]]);
    const context = vm.createContext({ activeRecordings, path,
        fsp: { appendFile: async () => {}, rename: async (from, to) => { assert.ok(!renames.includes(from)); renames.push(from); } },
        nowIso: () => '2026-11-04T18:00:00+08:00',
        prepareAutomaticGithubUpload: async () => ({ status: 'disabled' }),
        writeJsonAtomic: async () => { if (metadataFailure && metadataAttempts++ === 0) throw Error('temporarily full'); },
        processGithubUploadQueue: async () => {},
    });
    const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    vm.runInContext(main.slice(main.indexOf('async function stopRecording('), main.indexOf('async function listSessions(')), context);
    return { context, activeRecordings, counts: () => ({ finalized, renames: renames.length }) };
}

test('failed sample append can finalize the partial recording and records the failure', async () => {
    const h = recordingHarness({ appendFailure: true });
    const result = await h.context.stopRecording('night');
    assert.equal(result.status, 'failed');
    assert.equal(result.writeError, 'disk full');
    assert.equal(result.rows, 512);
    assert.equal(h.activeRecordings.size, 0);
});

test('concurrent session stops finalize and rename the recording only once', async () => {
    const h = recordingHarness();
    const result = await Promise.all([h.context.stopRecording('night'), h.context.stopRecording('night')]);
    assert.equal(result[0].rows, result[1].rows);
    assert.deepEqual(h.counts(), { finalized: 1, renames: 2 });
});

test('metadata save failure leaves finalization retryable without renaming finalized files again', async () => {
    const h = recordingHarness({ metadataFailure: true });
    await assert.rejects(h.context.stopRecording('night'));
    assert.equal(h.activeRecordings.size, 1);
    await h.context.stopRecording('night');
    assert.equal(h.activeRecordings.size, 0);
    assert.deepEqual(h.counts(), { finalized: 1, renames: 2 });
});
