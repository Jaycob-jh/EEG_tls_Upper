'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../src/core');
const BrainLume = require('../src/vendor/BrainLume_Lib');
const { parseArgs } = require('../debug-cli');
const QualityAudit = require('../scripts/audit-quality-thresholds');

test('ActionBus F0/00 frame matches the known CRC vector', () => {
    const frame = BrainLume.protocol.encodeCommand(BrainLume.commands.protocolVersion(0x01));
    assert.equal(Core.bytesToHex(frame), 'AA5501F0100100952A');
});
test('indicator control function 0x02 matches the device frame vectors', () => {
    const stop = BrainLume.protocol.encodeCommand(BrainLume.commands.stopIndicator(0x01));
    const start = BrainLume.protocol.encodeCommand(BrainLume.commands.startIndicator(0x01));
    assert.equal(Core.bytesToHex(stop), 'AA5501021000D8AD');
    assert.equal(Core.bytesToHex(start), 'AA550102110048AC');
    assert.equal(BrainLume.FUNC.INDICATOR_CONTROL, 0x02);
});
test('CH2 normal and impedance ADS1299 images match the device specification', () => {
    const normal = BrainLume.ads1299.createRecommendedConfig({ impedance: false, channels: [2] });
    const impedance = BrainLume.ads1299.createRecommendedConfig({ impedance: true, channels: [2] });
    assert.equal(Core.bytesToHex(normal), '96C0EC008160818181818181020000000000000020000000CF8063800300');
    assert.equal(Core.bytesToHex(impedance), '96C0EC058160818181818181000200020000000020000000CF8063800300');
    assert.equal(normal[0x0D - 1], 0x02);
    assert.equal(impedance[0x0D - 1], 0x00);
});

test('device operation presentation distinguishes live hardware state from the next plan action', () => {
    assert.deepEqual(Core.deviceOperationPresentation({
        connected: true, verified: true, channel: 2, impedanceMode: true,
        eegRunning: true, lightRunning: { 1: false, 2: false },
    }), {
        tone: 'active', operation: 'impedance_check', label: '检测阻抗', detail: 'CH2 · 当前设备操作',
    });
    assert.deepEqual(Core.deviceOperationPresentation({
        connected: true, verified: true, channel: 2, eegRunning: false,
        lightRunning: { 1: false, 2: true },
    }), {
        tone: 'active', operation: 'light', label: 'CH2 光刺激中', detail: '设备状态回读确认',
    });
    assert.deepEqual(Core.deviceOperationPresentation({
        connected: true, verified: true, channel: 2, eegRunning: false,
        lightRunning: { 1: false, 2: false },
    }), {
        tone: 'off', operation: 'idle', label: '待机', detail: '未检测到 EEG、阻抗检测或光刺激运行',
    });
});

test('plan engine exposes the action currently being executed', async () => {
    let release;
    const engine = new Core.PlanEngine({
        monotonicNow: () => 0,
        execute: async () => new Promise(resolve => { release = resolve; }),
    });
    engine.setPlans([{ id: 'relative', name: 'relative', mode: 'relative', enabled: true, eegChannel: 2,
        actions: [{ id: 'impedance', offsetSeconds: 0, type: 'impedance_check' }] }]);
    engine.startRelative('relative');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(engine.getCurrentAction().action.type, 'impedance_check');
    assert.equal(engine.getRelativeStatus().currentAction.action.id, 'impedance');
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(engine.getCurrentAction(), null);
});

test('firmware error codes and request context are preserved', async () => {
    let onData;
    const transport = {
        onData(callback) { onData = callback; return () => { onData = null; }; },
        isConnected: () => true,
        async write(bytes) {
            const request = BrainLume.protocol.parseFrame(bytes);
            onData(BrainLume.protocol.buildFrame(request.addr, request.func, BrainLume.STAT.ERROR, [0x06]));
        },
    };
    const client = new BrainLume.BrainLumeClient({ transport, timeoutMs: 100 });
    await assert.rejects(client.getStatus(), error => {
        assert.equal(error.name, 'DeviceError');
        assert.equal(error.message, 'Device error 0x06: Internal error');
        assert.equal(error.addr, 0x01);
        assert.equal(error.func, BrainLume.FUNC.STATUS);
        assert.equal(error.request.stat, BrainLume.STAT.HOST_QUERY);
        assert.equal(error.request.len, 0);
        return true;
    });
});

test('ADS1299 config comparison ignores read-only lead-off status registers', () => {
    const expected = BrainLume.ads1299.createRecommendedConfig({ channels: [2] });
    const readback = Uint8Array.from([0x1E, ...expected]);
    readback[0x12] = 0xAA;
    readback[0x13] = 0x55;
    readback[0x1E] = 0x7F;
    assert.deepEqual(BrainLume.ads1299.compareAdsConfig(expected, readback), []);
    readback[0x06] ^= 0x01;
    assert.deepEqual(BrainLume.ads1299.compareAdsConfig(expected, readback), [{ address: 0x06, expected: expected[0x05], actual: readback[0x06] }]);
});

test('debug CLI validates commands and raw frame options', () => {
    assert.deepEqual(parseArgs(['status']), { command: 'status' });
    assert.deepEqual(parseArgs(['start-eeg', '--channel', '2', '--seconds', '3']), { command: 'start-eeg', channel: 2, seconds: 3 });
    assert.deepEqual(parseArgs(['raw', '--addr', '1', '--func', '0x20', '--stat', '0x11', '--data', '96c0']), { command: 'raw', addr: 1, func: 32, stat: 17, data: [0x96, 0xC0] });
    assert.throws(() => parseArgs(['raw', '--addr', '1']), /raw requires/);
});

test('plan validation requires paired EEG and light actions', () => {
    const invalid = {
        id: 'p1', name: 'invalid', enabled: true, eegChannel: 2,
        actions: [{ id: 'a1', time: '12:00:00', type: 'eeg_start' }],
    };
    assert.match(Core.validatePlan(invalid).join(';'), /EEG/);

    const valid = {
        id: 'p2', name: 'valid', enabled: true, eegChannel: 2,
        actions: [
            { id: 'a1', time: '12:00:00', type: 'eeg_start' },
            { id: 'a2', time: '12:01:00', type: 'light_start', lightChannel: 2, light: { frequencyHz: 10, durationMs: 0, powerPercent: 5 } },
            { id: 'a3', time: '12:02:00', type: 'light_stop', lightChannel: 2 },
            { id: 'a4', time: '12:03:00', type: 'eeg_stop' },
        ],
    };
    assert.deepEqual(Core.validatePlan(valid), []);

    const eegOnly = {
        id: 'p-eeg-only', name: '纯 EEG 采集', enabled: true, eegChannel: 2,
        actions: [
            { id: 'start', time: '22:00:00', type: 'eeg_start' },
            { id: 'stop', time: '06:00:00', type: 'eeg_stop' },
        ],
    };
    assert.deepEqual(Core.validatePlan(eegOnly), []);

    valid.actions[1].light.durationMs = -1;
    assert.match(Core.validatePlan(valid).join(';'), /时长不能小于 0/);

    assert.match(Core.validatePlan({ ...valid, eegChannel: 1 }).join(';'), /固定为 CH2/);
    assert.equal(Core.normalizePlan({ ...valid, eegChannel: 1 }).eegChannel, 2);

    const wrongLightChannel = Core.normalizePlan({
        ...valid,
        actions: valid.actions.map(action => action.type.startsWith('light_') ? { ...action, lightChannel: 1 } : action),
    });
    assert.equal(wrongLightChannel.actions[1].lightChannel, 2);
    assert.match(Core.validatePlan({
        ...valid,
        actions: valid.actions.map(action => action.type.startsWith('light_') ? { ...action, lightChannel: 1 } : action),
    }).join(';'), /光刺激通道固定为 CH2/);
});

test('plan validation accepts a pure EEG plan without light actions', () => {
    const pureEeg = {
        id: 'p-eeg-only', name: '纯 EEG 采集', enabled: true, eegChannel: 2,
        actions: [
            { id: 'impedance', time: '22:00:00', type: 'impedance_check' },
            { id: 'start', time: '22:01:00', type: 'eeg_start' },
            { id: 'stop', time: '06:00:00', type: 'eeg_stop' },
        ],
    };
    assert.deepEqual(Core.validatePlan(pureEeg), []);
    assert.equal(pureEeg.actions.some(action => action.type === 'light_start' || action.type === 'light_stop'), false);
});

test('new plan defaults and persisted stimulus protocol do not auto-enable light output', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const start = source.indexOf('function defaultPlanActions');
    const end = source.indexOf('function openPlanDialog', start);
    assert.ok(start >= 0 && end > start);
    assert.doesNotMatch(source.slice(start, end), /light_(?:start|stop)/);
    assert.match(source, /const protocol = \{ \.\.\.Sleep\.normalizeStimulusProtocol\(stored\), enabled: false \}/);
});

test('stimulus control mode keeps manual and model triggers explicitly selectable', () => {
    assert.equal(Core.normalizeStimulusControlMode('manual'), 'manual');
    assert.equal(Core.normalizeStimulusControlMode('invalid'), 'manual');
    assert.equal(Core.stimulusControlModeAllows('manual', 'manual'), true);
    assert.equal(Core.stimulusControlModeAllows('manual', 'model'), false);
    assert.equal(Core.stimulusControlModeAllows('model', 'manual'), false);
    assert.equal(Core.stimulusControlModeAllows('model', 'model'), true);
    assert.equal(Core.stimulusControlModeAllows('both', 'manual'), true);
    assert.equal(Core.stimulusControlModeAllows('both', 'model'), true);
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(html, /id="stimulus-control-mode"/);
    assert.match(html, /id="home-light-start"/);
    assert.match(html, /光 CH2 固定/);
    assert.match(app, /当前控制方式为模型判别，请切换为“手动 \/ 方案”或“两者都可”/);
});

test('plan editor fixes all light actions to CH2', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(source, /action-light-channel" disabled/);
    assert.match(source, /光 CH2（固定）/);
    assert.match(source, /action\.lightChannel = Core\.FIXED_PLAN_LIGHT_CHANNEL/);
});

test('plan engine executes a due action only once', async () => {
    const calls = [];
    const now = new Date(2026, 7, 7, 12, 0, 1);
    const engine = new Core.PlanEngine({ now: () => now, execute: async (_plan, action) => calls.push(action.id) });
    engine.setPlans([{
        id: 'p1', name: 'daily', enabled: true, eegChannel: 2,
        actions: [
            { id: 'a1', time: '12:00:00', type: 'status_query' },
        ],
    }]);
    await engine.tick();
    await engine.tick();
    assert.deepEqual(calls, ['a1']);
});

test('local ISO timestamps keep wall-clock fields and an explicit offset', () => {
    const local = new Date(2026, 7, 7, 15, 30, 12, 345);
    assert.match(Core.formatLocalIso(local), /^2026-08-07T15:30:12\.345[+-]\d{2}:\d{2}$/);
});

test('relative plan uses monotonic elapsed time and pauses daily plans', async () => {
    let monotonic = 0;
    const calls = [];
    const events = [];
    const engine = new Core.PlanEngine({
        now: () => new Date(2026, 7, 7, 12, 0, 0),
        monotonicNow: () => monotonic,
        execute: async (plan, action) => calls.push(`${plan.id}:${action.id}`),
        onEvent: event => events.push(event.phase),
    });
    engine.setPlans([
        { id: 'daily', name: 'daily', mode: 'clock', enabled: true, eegChannel: 2, actions: [{ id: 'daily-action', time: '12:00:00', type: 'status_query' }] },
        { id: 'relative', name: 'relative', mode: 'relative', enabled: true, eegChannel: 2, actions: [
            { id: 'r0', offsetSeconds: 0, type: 'status_query' },
            { id: 'r10', offsetSeconds: 10, type: 'status_query' },
        ] },
    ]);
    engine.startRelative('relative');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['relative:r0']);
    monotonic = 10000;
    await engine.tick();
    assert.deepEqual(calls, ['relative:r0', 'relative:r10']);
    assert.equal(engine.getRelativeStatus(), null);
    assert.ok(events.includes('run-completed'));
    assert.ok(!calls.includes('daily:daily-action'));
});

test('daily plan can be selected for immediate execution without changing its saved clock schedule', async () => {
    let monotonic = 0;
    const calls = [];
    const source = { id: 'daily', name: 'test', mode: 'clock', enabled: true, eegChannel: 2, actions: [
        { id: 'first', time: '16:34:12', type: 'status_query' },
        { id: 'second', time: '16:35:12', type: 'status_query' },
    ] };
    const engine = new Core.PlanEngine({
        monotonicNow: () => monotonic,
        execute: async (plan, action) => calls.push(`${plan.mode}:${action.id}`),
    });
    engine.setPlans([source]);
    engine.startManual('daily');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['relative:first']);
    assert.equal(source.mode, 'clock');
    assert.equal(source.actions[0].time, '16:34:12');
    monotonic = 60000;
    await engine.tick();
    assert.deepEqual(calls, ['relative:first', 'relative:second']);
});

test('relative plan rejects overdue actions instead of catching up', async () => {
    let monotonic = 0;
    const calls = [];
    const events = [];
    const engine = new Core.PlanEngine({ monotonicNow: () => monotonic, execute: async (_plan, action) => calls.push(action.id), onEvent: event => events.push(event.phase) });
    engine.setPlans([{ id: 'relative', name: 'relative', mode: 'relative', enabled: true, eegChannel: 2, actions: [{ id: 'late', offsetSeconds: 10, type: 'status_query' }] }]);
    engine.startRelative('relative');
    await new Promise(resolve => setImmediate(resolve));
    monotonic = 16000;
    await engine.tick();
    assert.deepEqual(calls, []);
    assert.equal(engine.getRelativeStatus(), null);
    assert.deepEqual(events.slice(-2), ['skipped', 'run-failed']);
});

test('daily plan startup baseline does not replay overdue actions or safety stops', async () => {
    const calls = [];
    const events = [];
    const engine = new Core.PlanEngine({
        now: () => new Date(2026, 7, 7, 12, 2, 0),
        execute: async (_plan, action) => calls.push(action.id),
        onEvent: event => events.push({ phase: event.phase, id: event.action?.id, reason: event.reason }),
    });
    engine.setPlans([{ id: 'p', name: 'late light', mode: 'clock', enabled: true, eegChannel: 2, actions: [
        { id: 'start', time: '12:00:00', type: 'light_start', lightChannel: 2, light: { frequencyHz: 40, durationMs: 0, powerPercent: 50 } },
        { id: 'stop', time: '12:01:00', type: 'light_stop', lightChannel: 2 },
    ] }]);
    await engine.tick();
    assert.deepEqual(calls, []);
    assert.deepEqual(events, [{ phase: 'startup-baseline', id: undefined, reason: 'clock_action_overdue' }]);
});

test('daily plan executes a safety stop after a successful start in the same app run', async () => {
    let now = new Date(2026, 7, 7, 12, 0, 1);
    const calls = [];
    const engine = new Core.PlanEngine({
        now: () => now,
        execute: async (_plan, action) => calls.push(action.id),
    });
    engine.setPlans([{ id: 'p', name: 'active light', mode: 'clock', enabled: true, eegChannel: 2, actions: [
        { id: 'start', time: '12:00:00', type: 'light_start', lightChannel: 2, light: { frequencyHz: 40, durationMs: 0, powerPercent: 50 } },
        { id: 'stop', time: '12:01:00', type: 'light_stop', lightChannel: 2 },
    ] }]);
    await engine.tick();
    now = new Date(2026, 7, 7, 12, 1, 12);
    await engine.tick();
    assert.deepEqual(calls, ['start', 'stop']);
});

test('daily plan does not replay a safety stop after its start failed', async () => {
    const calls = [];
    const engine = new Core.PlanEngine({
        now: () => new Date(2026, 7, 7, 12, 0, 1),
        execute: async (_plan, action) => {
            calls.push(action.id);
            if (action.id === 'start') throw new Error('start failed');
        },
    });
    engine.setPlans([{ id: 'p', name: 'failed light', mode: 'clock', enabled: true, eegChannel: 2, actions: [
        { id: 'start', time: '12:00:00', type: 'light_start', lightChannel: 2, light: { frequencyHz: 40, durationMs: 0, powerPercent: 50 } },
        { id: 'stop', time: '12:01:00', type: 'light_stop', lightChannel: 2 },
    ] }]);
    await engine.tick();
    assert.deepEqual(calls, ['start']);
});

test('relative plan catches up an overdue safety stop', async () => {
    let monotonic = 0;
    const calls = [];
    const engine = new Core.PlanEngine({ monotonicNow: () => monotonic, execute: async (_plan, action) => calls.push(action.id) });
    engine.setPlans([{ id: 'relative', name: 'relative', mode: 'relative', enabled: true, eegChannel: 2, actions: [
        { id: 'start', offsetSeconds: 0, type: 'light_start', lightChannel: 2, light: { frequencyHz: 40, durationMs: 0, powerPercent: 50 } },
        { id: 'stop', offsetSeconds: 10, type: 'light_stop', lightChannel: 2 },
    ] }]);
    engine.startRelative('relative');
    await new Promise(resolve => setImmediate(resolve));
    monotonic = 30000;
    await engine.tick();
    assert.deepEqual(calls, ['start', 'stop']);
    assert.equal(engine.getRelativeStatus(), null);
});

test('plan dialog cancel controls bypass required-field submission and time input stays readable', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    assert.match(html, /type="button" class="icon-button" id="plan-dialog-close"/);
    assert.match(html, /type="button" class="button secondary" id="plan-dialog-cancel"/);
    assert.match(css, /grid-template-columns:\s*140px 170px 90px/);
    assert.match(css, /\.action-time, \.action-offset-minutes/);
});

test('light editor labels parameters and forces duration to zero', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(app, /频率 \(Hz\)/);
    assert.match(app, /时间 \(ms，固定\)/);
    assert.match(app, /功率\/占空比 \(%\)/);
    assert.match(app, /class="action-duration"[^>]*value="0" readonly/);
    assert.match(app, /durationMs:\s*0/);
});

test('device realtime waveform shows only the preprocessed EEG stream', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(html, /CH2 预处理实时波形/);
    assert.match(html, /id="eeg-canvas"/);
    assert.match(html, /id="wave-x-range"/);
    assert.match(html, /id="wave-refresh-rate"/);
    assert.match(html, /id="metric-recording-detail"/);
    assert.match(html, /id="wave-range"/);
    assert.match(html, /<th>时长<\/th>/);
    for (const seconds of [5, 10, 20, 30, 60]) {
        assert.match(html, new RegExp(`<option value="${seconds}"`));
    }
    assert.match(html, /0\.5–45Hz \+ 50Hz 陷波/);
    assert.doesNotMatch(html, /raw-eeg-canvas|原始 EEG 预览|raw-wave-range|raw-wave-value/);
    assert.doesNotMatch(app, /rawWaveform/);
    assert.match(app, /result\.filteredMicrovolts\[channelIndex\]/);
    assert.match(app, /waveformWindowPoints/);
    assert.match(app, /waveformRefreshFps/);
    assert.match(app, /Core\.waveformScale/);
    assert.match(app, /timelineLabel/);
    assert.match(app, /Core\.formatDuration/);
    assert.match(app, /color:\s*'#111111'/);
    assert.doesNotMatch(app, /fill:\s*'rgba\(0,143,114/);
    assert.match(css, /\.wave-canvas-wrap\s*\{[^}]*height:\s*clamp\(340px, 52vh, 560px\)/s);
    assert.match(css, /@media\s*\(min-width:\s*1221px\)\s*and\s*\(min-height:\s*1180px\)[\s\S]*?height:\s*clamp\(560px, 52vh, 620px\)/);
    assert.match(css, /\.wave-footer span:not\(:first-child\)/);
});

test('waveform display settings constrain the X-axis range and refresh speed', () => {
    assert.deepEqual(Core.normalizeWaveformDisplay(), { xRangeSeconds: 20, refreshFps: 30 });
    assert.deepEqual(Core.normalizeWaveformDisplay({ xRangeSeconds: 60, refreshFps: 10 }), {
        xRangeSeconds: 60, refreshFps: 10,
    });
    assert.deepEqual(Core.normalizeWaveformDisplay({ xRangeSeconds: 7, refreshFps: 120 }), {
        xRangeSeconds: 20, refreshFps: 30,
    });
});

test('recording duration is readable without manual sample-rate arithmetic', () => {
    assert.equal(Core.sampleCountToSeconds(37549, 250), 150.196);
    assert.equal(Core.formatDuration(Core.sampleCountToSeconds(37549, 250)), '02:30');
    assert.equal(Core.formatDuration(3661), '1:01:01');
    assert.equal(Core.formatDuration(-1), '00:00');
});

test('waveform display scale keeps a startup transient from flattening the live trace', () => {
    const scale = Core.waveformScale([50000, ...Array.from({ length: 100 }, (_, index) => 1000 + (index % 5) * 2)]);
    assert.ok(scale.min > 900);
    assert.ok(scale.max < 1100);
    assert.equal(scale.clipped, true);
});

test('EEG stream statistics count gaps, missing frames and loss rate once per frame', () => {
    const stats = Core.createEegStreamStats();
    assert.deepEqual(Core.trackEegStreamFrame(stats, 100, 0), { delta: null, seqGap: 0, sequenceReset: false });
    assert.deepEqual(Core.trackEegStreamFrame(stats, 101, 4), { delta: 1, seqGap: 0, sequenceReset: false });
    assert.deepEqual(Core.trackEegStreamFrame(stats, 104, 8), { delta: 3, seqGap: 2, sequenceReset: false });
    assert.deepEqual(Core.trackEegStreamFrame(stats, 109, 12), { delta: 5, seqGap: 4, sequenceReset: false });
    assert.equal(stats.receivedFrames, 4);
    assert.equal(stats.gapEvents, 2);
    assert.equal(stats.lostFrames, 6);
    assert.equal(Core.eegStreamLossRate(stats), 0.6);
});

test('EEG stream statistics handle uint16 wrap, duplicates and backward resets', () => {
    const stats = Core.createEegStreamStats();
    Core.trackEegStreamFrame(stats, 65535, 0);
    assert.deepEqual(Core.trackEegStreamFrame(stats, 0, 4), { delta: 1, seqGap: 0, sequenceReset: false });
    assert.deepEqual(Core.trackEegStreamFrame(stats, 0, 8), { delta: 0, seqGap: 0, sequenceReset: false });
    assert.deepEqual(Core.trackEegStreamFrame(stats, 65000, 12), { delta: 65000, seqGap: 0, sequenceReset: true });
    assert.deepEqual(Core.trackEegStreamFrame(stats, 32232, 16), { delta: 32768, seqGap: 0, sequenceReset: true });
    assert.equal(stats.gapEvents, 0);
    assert.equal(stats.lostFrames, 0);
});

test('EEG rolling frame rate reports a stable 250 FPS and expires stale samples', () => {
    const stats = Core.createEegStreamStats(2000);
    for (let index = 0; index <= 500; index++) Core.trackEegStreamFrame(stats, index, index * 4);
    assert.equal(Core.eegStreamFrameRate(stats, 2000), 250);
    assert.equal(Core.eegStreamFrameRate(stats, 2500), 250);
    assert.equal(Core.eegStreamFrameRate(stats, 4001), 0);
    const justStarted = Core.createEegStreamStats();
    Core.trackEegStreamFrame(justStarted, 1, 100);
    assert.equal(Core.eegStreamFrameRate(justStarted, 100), 0);
});

test('EEG CSV preserves existing columns and stores device seq as sample_index', () => {
    assert.deepEqual(Core.EEG_CSV_COLUMNS.slice(-2), ['seq_gap', 'row_index']);
    const line = Core.eegCsvLine({
        session_id: 'session-1', selected_channel: 2, sample_index: 65535, seq: 65535,
        raw_code: -123, voltage_uv: -1.25, seq_gap: 3, row_index: 7,
    });
    const fields = line.split(',');
    const values = Object.fromEntries(Core.EEG_CSV_COLUMNS.map((column, index) => [column, fields[index]]));
    assert.equal(values.sample_index, '65535');
    assert.equal(values.seq, '65535');
    assert.equal(values.seq_gap, '3');
    assert.equal(values.row_index, '7');
});

test('device overview exposes four live stream quality metrics in a five-column grid', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
    for (const id of ['metric-frame-rate', 'metric-gap-events', 'metric-lost-frames', 'metric-loss-rate']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(css, /\.metrics-grid\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
    assert.match(css, /@media\s*\(max-width:\s*1220px\)[\s\S]*?\.metrics-grid\s*\{[^}]*repeat\(3,/);
});

test('device toolbar exposes the function 0x02 indicator toggle', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(html, /id="indicator-toggle-button"/);
    assert.doesNotMatch(html, /id="screenshot-button"/);
    assert.doesNotMatch(app, /screenshot-button/);
    assert.match(app, /async function toggleIndicator\(\)/);
    assert.match(app, /SDK\.FUNC\.INDICATOR_CONTROL/);
    assert.match(app, /client\.startIndicator\(\)/);
    assert.match(app, /client\.stopIndicator\(\)/);
});

test('application menu groups directories, exports and screenshots under tools', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(main, /label: '工具'/);
    assert.match(main, /保存当前页面截图/);
    assert.match(main, /导出当前分析报告/);
});

test('realtime page exposes a 30-second sleep-stage stimulus protocol with safety gates', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(html, /id="sleep-stimulus-enabled"/);
    for (const stage of ['W', 'N1', 'N2', 'N3', 'REM']) {
        assert.match(html, new RegExp(`name="sleep-stimulus-stage" value="${stage}"`));
    }
    assert.match(html, /id="sleep-stimulus-confidence"/);
    assert.match(html, /id="sleep-stimulus-n3-mode"/);
    assert.match(html, /id="sleep-stimulus-n3-probability"/);
    assert.match(html, /id="sleep-stimulus-consecutive"/);
    assert.match(html, /id="sleep-stimulus-cooldown"/);
    assert.match(html, /id="realtime-light-state"/);
    assert.match(html, /id="realtime-light-detail"/);
    assert.match(html, /id="sleep-stimulus-device-state"/);
    assert.match(html, /id="sleep-stimulus-shadow-mode"/);
    assert.match(html, /<th>光刺激<\/th>/);
    assert.match(app, /function renderLightStimulusState\(\)/);
    assert.match(app, /lightStateVerified/);
    assert.match(app, /sleepEpochLightChannels/);
    assert.match(app, /onlineInferenceInput\(\)/);
    assert.match(app, /sleepInferenceGeneration/);
    assert.match(html, /当前因果候选从首个 epoch 开始显示/);
    assert.match(html, /当前因果输出/);
    assert.match(html, /候选概率达到阈值/);
    assert.match(html, /sleep-stage-postprocess\.js/);
    assert.match(html, /保守后处理/);
    assert.match(app, /sleepN3Postprocessors/);
    assert.match(app, /n3Postprocessed/);
});

test('user-visible product name is Cao Cao while the historical data directory stays compatible', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const report = fs.readFileSync(path.join(__dirname, '..', 'src', 'analysis-report.js'), 'utf8');
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.match(html, /<title>曹操 v0\.3\.1<\/title>/);
    assert.match(html, /<strong>曹操<\/strong><span>EEG 闭环平台<\/span>/);
    assert.match(main, /title:\s*'曹操'/);
    assert.match(main, /'BrainLume Desktop'/);
    assert.match(report, /曹操 v0\.3\.1/);
    assert.match(readme, /^# 曹操$/m);
});

test('Cao Cao artwork is used for the app icon and animated launch screen', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const splashPath = path.join(__dirname, '..', 'src', 'splash.html');
    const iconPath = path.join(__dirname, '..', 'assets', 'cao-cao-icon-original.png');
    const artworkPath = path.join(__dirname, '..', 'assets', 'cao-cao-splash-original.png');
    assert.equal(fs.existsSync(iconPath), true);
    assert.equal(fs.existsSync(artworkPath), true);
    assert.equal(fs.existsSync(splashPath), true);
    const splash = fs.readFileSync(splashPath, 'utf8');
    assert.match(html, /<img class="brand-icon" src="\.\.\/assets\/cao-cao-icon-original\.png"/);
    assert.match(splash, /cao-cao-splash-original\.png/);
    assert.match(splash, /@keyframes splashZoom/);
    assert.match(main, /function createSplashWindow\(\)/);
    assert.match(main, /app\.dock\.setIcon/);
});

test('macOS packaging produces an Apple Silicon Cao Cao app with its custom icon', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const iconPath = path.join(__dirname, '..', 'assets', 'cao-cao-original.icns');
    const packageCommand = packageJson.scripts['package:mac'];
    const arm64Command = packageJson.scripts['package:mac:arm64'];
    assert.equal(packageJson.productName, '曹操');
    assert.match(packageCommand, /package:mac:arm64/);
    assert.match(arm64Command, /--platform darwin --arch arm64/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-release.js'), 'utf8'), /cao-cao-original\.icns/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-release.js'), 'utf8'), /codesign/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-release.js'), 'utf8'), /packagedPath/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-release.js'), 'utf8'), /\$\{PACKAGE\.productName\}\.app/);
    assert.equal(fs.existsSync(iconPath), true);
});

test('cross-platform packaging has explicit Windows x64 and macOS arm64 entry points', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-release.js'), 'utf8');
    assert.match(packageJson.scripts['package:win:x64'], /--platform win32 --arch x64/);
    assert.match(packageJson.scripts['package:mac:arm64'], /--platform darwin --arch arm64/);
    assert.match(script, /macOS arm64 成品必须在 Apple Silicon Mac 上构建/);
    assert.match(script, /onnxruntime-node/);
});

test('CSV escaping preserves commas, quotes and newlines', () => {
    assert.equal(Core.csvEscape('plain'), 'plain');
    assert.equal(Core.csvEscape('a,b'), '"a,b"');
    assert.equal(Core.csvEscape('a"b'), '"a""b"');
    assert.equal(Core.csvEscape('a\nb'), '"a\nb"');
});

test('quality audit keeps raw/model threshold semantics and the offline N3 grid bounded', () => {
    assert.equal(QualityAudit.thresholdQuality({ modelMaxAbsUv: 500, modelStdUv: 1 }, 500), true);
    assert.equal(QualityAudit.thresholdQuality({ modelMaxAbsUv: 500.1, modelStdUv: 1 }, 500), false);
    const rows = [
        { modelMaxAbsUv: 120, modelStdUv: 20, loggedQualityOk: true },
        { modelMaxAbsUv: 900, modelStdUv: 20, loggedQualityOk: false },
    ];
    const sweep = QualityAudit.qualityThresholdSweep(rows, [500, 1000]);
    assert.deepEqual(sweep.map(item => item.passEpochs), [1, 2]);
    const n3Rows = [
        { session: 's1', epochIndex: 0, inferenceMode: 'causal', loggedQualityOk: true, candidateStage: 'N3', n3Probability: 0.55 },
        { session: 's1', epochIndex: 1, inferenceMode: 'causal', loggedQualityOk: true, candidateStage: 'N3', n3Probability: 0.75 },
    ];
    const n3Sweep = QualityAudit.n3ProbabilitySweep(n3Rows);
    assert.equal(n3Sweep[0].threshold, 0.5);
    assert.equal(n3Sweep.at(-1).threshold, 0.95);
    assert.equal(n3Sweep.find(item => item.threshold === 0.5).consecutiveRunsAtLeast2, 1);
});
