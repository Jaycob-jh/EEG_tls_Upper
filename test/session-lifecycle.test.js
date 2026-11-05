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

test('repeated stop requests share one bounded device transaction and retain the record until confirmation', async () => {
    let stopCalls=0,statusCalls=0,release;
    const waiting=new Promise(resolve=>{release=resolve;});
    const state={eegRunning:true,activeSession:{id:'night'}};
    const context=vm.createContext({state,updateEegUi(){},formatTime:()=>'', $:()=>({}),requireClient:()=>({
        stopEeg:async options=>{stopCalls++;assert.equal(options.timeoutMs,15000);await waiting;},
        getStatus:async options=>{statusCalls++;assert.equal(options.timeoutMs,10000);return {eegRunning:false};},
    })});
    vm.runInContext(extract('    async function stopEegOnDevice(', '    async function stopEeg(reason'),context);
    const first=context.stopEegOnDevice(),second=context.stopEegOnDevice();
    assert.equal(stopCalls,1);assert.equal(state.activeSession.id,'night');assert.ok(state.eegStopPromise);
    release();await Promise.all([first,second]);
    assert.equal(statusCalls,1);assert.equal(state.deviceEegRunning,false);assert.equal(state.eegStopError,null);assert.equal(state.eegStopPromise,null);
});

test('failed impedance stop does not reconfigure a device that may still be sampling', async () => {
    const state={eegRunning:false,processor:{reset(){},impedance:null},selectedChannel:2};const writes=[];
    const client={readAds1299Registers:async()=>({values:[]}),startEeg:async()=>{throw Error('measurement failed');}};
    const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
    const context=vm.createContext({state,$,setTimeout,clearTimeout,requireClient:()=>client,
        applyChannel:async(_channel,impedance)=>{writes.push(impedance);return [];},
        SDK:{ads1299:{compareAdsConfig:()=>[]},impedance:{ImpedanceEstimator:class {}}},
        stopEegOnDevice:async()=>{throw Error('stop not confirmed');},
        audit:async()=>{},renderNextAction(){},logProtocol(){},updateEegUi(){},Core:{bytesToHex:()=>''},
    });
    vm.runInContext(extract('    async function measureImpedance(', '    const LIGHT_MAX_ATTEMPTS'),context);
    await assert.rejects(context.measureImpedance(),/stop not confirmed/);
    assert.deepEqual(writes,[true]);assert.equal(state.impedanceMode,true);
});

test('impedance cleanup distinguishes failed restoration from an unconfirmed stop and retains measurement error', async () => {
    const state={eegRunning:false,processor:{reset(){},impedance:null},selectedChannel:2};
    const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
    const context=vm.createContext({state,$,setTimeout,clearTimeout,
        requireClient:()=>({readAds1299Registers:async()=>({values:[]}),startEeg:async()=>{throw Error('measurement rejected');}}),
        applyChannel:async(_channel,impedance)=>{if(!impedance)throw Error('restore rejected');return [];},
        SDK:{ads1299:{compareAdsConfig:()=>[]},impedance:{ImpedanceEstimator:class {}}},
        stopEegOnDevice:async()=>{state.deviceEegRunning=false;},
        audit:async()=>{},renderNextAction(){},logProtocol(){},updateEegUi(){},Core:{bytesToHex:()=>''},
    });
    vm.runInContext(extract('    async function measureImpedance(', '    const LIGHT_MAX_ATTEMPTS'),context);
    await assert.rejects(context.measureImpedance(),/measurement rejected.*restore rejected/);
    assert.equal(state.impedanceMode,false);assert.equal(state.impedanceBusy,false);
    assert.match(elements.get('metric-impedance-state').textContent,/采集已停止.*恢复脑电配置失败/);
    assert.doesNotMatch(elements.get('metric-impedance-state').textContent,/重试停止/);
});

test('battery refresh during EEG uses an explicitly labelled previous reading and sends no device command', async () => {
    let requests=0,notices=0;const elements=new Map();
    const state={eegRunning:true,lastDeviceStatus:{batteryLevel:80},lastDeviceStatusTime:'12:00:00'};
    const context=vm.createContext({state,$:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
        toast:()=>{notices++;},requireClient:()=>({getStatus:async()=>{requests++;}})});
    vm.runInContext(extract('    async function queryStatus(', '    async function toggleIndicator('),context);
    assert.equal((await context.queryStatus()).cached,true);await context.queryStatus();
    assert.equal(requests,0);assert.equal(notices,1);assert.match(elements.get('metric-battery-update').textContent,/上次读取.*停止采集后刷新/);
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
