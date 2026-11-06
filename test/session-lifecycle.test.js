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
    vm.runInContext(extract('    function cancelImpedanceMeasurement(', '    const LIGHT_MAX_ATTEMPTS'),context);
    await assert.rejects(context.measureImpedance(),/stop not confirmed/);
    assert.deepEqual(writes,[true]);assert.equal(state.impedanceMode,true);
});

test('impedance cleanup distinguishes failed restoration from an unconfirmed stop and retains measurement error', async () => {
    const state={eegRunning:false,processor:{reset(){},impedance:null},selectedChannel:2};
    const client={readAds1299Registers:async()=>({values:[]}),startEeg:async()=>{throw Error('measurement rejected');}};
    const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
    const context=vm.createContext({state,$,setTimeout,clearTimeout,
        requireClient:()=>client,
        applyChannel:async(_channel,impedance)=>{if(!impedance)throw Error('restore rejected');return [];},
        SDK:{ads1299:{compareAdsConfig:()=>[]},impedance:{ImpedanceEstimator:class {}}},
        stopEegOnDevice:async()=>{state.deviceEegRunning=false;},
        audit:async()=>{},renderNextAction(){},logProtocol(){},updateEegUi(){},Core:{bytesToHex:()=>''},
    });
    vm.runInContext(extract('    function cancelImpedanceMeasurement(', '    const LIGHT_MAX_ATTEMPTS'),context);
    await assert.rejects(context.measureImpedance(),/measurement rejected.*restore rejected/);
    assert.equal(state.impedanceMode,false);assert.equal(state.impedanceBusy,false);
    assert.match(elements.get('metric-impedance-state').textContent,/采集已停止.*恢复脑电配置失败/);
    assert.doesNotMatch(elements.get('metric-impedance-state').textContent,/重试停止/);
});

test('configuration reply failure requires matching register readback before accepting the applied settings', async () => {
    for (const applied of [true,false]) {
        let reads=0;const state={eegRunning:false};const audits=[];
        const client={getStatus:async()=>({eegRunning:false}),configureEeg:async()=>{throw Error('Device error 0x06');},readAds1299Registers:async()=>({values:[++reads>1&&applied?1:0]})};
        const context=vm.createContext({state,requireClient:()=>client,buildEegConfig:()=>[1],setTimeout,SDK:{ads1299:{compareAdsConfig:(expected,values)=>expected[0]===values[0]?[]:[{address:1,expected:1,actual:0}]}},Core:{bytesToHex:()=>''},audit:async a=>audits.push(a),logProtocol(){}});
        vm.runInContext(extract('    async function configureEegVerified(', '    async function applyChannel('),context);
        if(applied){await context.configureEegVerified(2,false);assert.ok(audits.includes('eeg_config_reply_failed_but_verified'));}
        else await assert.rejects(context.configureEegVerified(2,false),/0x06/);
    }
});

test('a complete saturated impedance window is reported as an unusable signal rather than missing data', async () => {
    const state={eegRunning:false,processor:{reset(){},impedance:null},selectedChannel:2};
    const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);};
    const context=vm.createContext({state,$,setTimeout:(fn,delay)=>delay===8000?setTimeout(fn,0):setTimeout(fn,0),clearTimeout,
        requireClient:()=>({readAds1299Registers:async()=>({values:[]}),startEeg:async()=>{Object.assign(state.impedanceDiagnostics,{received:1248,saturated:1248,windows:225,lastKohm:0});}}),
        applyChannel:async()=>[],SDK:{ads1299:{compareAdsConfig:()=>[]},impedance:{ImpedanceEstimator:class {}}},
        stopEegOnDevice:async()=>{},audit:async()=>{},renderNextAction(){},logProtocol(){},updateEegUi(){},Core:{bytesToHex:()=>''},
    });
    vm.runInContext(extract('    function cancelImpedanceMeasurement(', '    const LIGHT_MAX_ATTEMPTS'),context);
    await assert.rejects(context.measureImpedance(),/阻抗信号超出设备量程/);
    assert.equal(state.impedanceMode,false);assert.equal(state.impedanceBusy,false);
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
        edfFlushPromise: Promise.resolve(), pendingGapEvents: [] };
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
    const context = vm.createContext({ activeRecordings, path, recordingPowerBlocker: null,
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

for (const durationSeconds of [60, 1800]) test(`device diagnostic captures and saves ${durationSeconds} seconds without counting stop latency`, async () => {
    let clock = 0;
    let onData;
    const listeners = new Map();
    const reports = [];
    const expectedSamples = durationSeconds * 250;
    const state = {
        connected: true, eegRunning: false, activeSession: null,
        streamStats: { receivedFrames: 0, lostFrames: 0, gapEvents: 0 },
        transport: { name: 'BrainLume2.0C', onData: callback => { onData = callback; return () => {}; } },
    };
    const client = {
        on: (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); },
        readAds1299Registers: async () => ({ values: [0x1e, 0x96] }),
    };
    const context = vm.createContext({
        state, structuredClone, $: () => ({}), Core: { formatLocalIso: () => 'test' },
        SDK: { VERSION: 'test', FUNC: { EEG_RAW: 0x22 }, ads1299: { sampleRateFromConfig1: value => value === 0x96 ? 250 : null } },
        performance: { now: () => clock }, connectBle: async () => true, requireClient: () => client,
        queryStatus: async () => ({ eegRunning: false, light1Running: false, light2Running: false }),
        startEeg: async () => { state.eegRunning = true; state.activeSession = { id: 'test' }; },
        delay: async milliseconds => {
            clock += milliseconds;
            for (let index = 0; index < 1250; index++) {
                onData(new Uint8Array(37));
                listeners.get('frame')({ func: 0x22 });
                listeners.get('eeg')();
                state.streamStats.receivedFrames++;
            }
        },
        stopEeg: async () => { clock += 4000; state.eegRunning = false; state.activeSession = null; },
        window: { desktopAPI: {
            listSessions: async () => [{ id: 'test', rows: expectedSamples, status: 'completed' }],
            completeDiagnostic: async report => reports.push(report),
        } },
    });
    vm.runInContext(extract('    async function runDeviceDiagnostic(', '    function renderHistoryReplay('), context);
    await context.runDeviceDiagnostic(durationSeconds);
    assert.equal(reports[0].success, true);
    assert.equal(reports[0].eegStream.elapsedSeconds, durationSeconds);
    assert.equal(reports[0].eegStream.samplesPerSecond, 250);
    assert.equal(reports[0].eegStream.incoming.notifications, expectedSamples);
    assert.equal(reports[0].eegStream.incoming.validEegFrames, expectedSamples);
    assert.equal(reports[0].eegStream.incoming.decodedEegFrames, expectedSamples);
    assert.equal(reports[0].recording.rows, expectedSamples);
});
