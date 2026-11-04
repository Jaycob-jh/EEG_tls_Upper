/* Injected only by the isolated workflow runner, never loaded by the app. */
(() => {
    const sim = window.workflowDevice = { connected: false, eeg: false, light: { 1: false, 2: false },
        seq: 0, samples: 0, clock: 0, commands: [], failStart: false, failStopEeg: false,
        failStopLight: false, stage: null, rawProbabilities: [], corruptedFrames: 0 };
    const origin = performance.now();
    const realNow = Date.now;
    let dateOffset = 0;
    Date.now = () => realNow() + dateOffset;
    sim.advance = milliseconds => { dateOffset += milliseconds; };
    Object.defineProperty(performance, 'now', { value: () => origin + sim.clock });
    const device = new EventTarget();
    const notify = new EventTarget();
    notify.startNotifications = async () => notify;
    notify.stopNotifications = async () => notify;
    const emit = bytes => {
        notify.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        notify.dispatchEvent(new Event('characteristicvaluechanged'));
    };
    let registers = new Uint8Array(31);
    const write = { writeValueWithoutResponse: async bytes => {
        const sdk = window.BrainLume;
        if (!sim.commandParser) sim.commandParser = new sdk.protocol.ActionBusParser();
        const frame = sim.commandParser.feed(new Uint8Array(bytes))[0];
        if (!frame) return;
        sim.commands.push({ func: frame.func, stat: frame.stat, data: Array.from(frame.data) });
        let data = [], stat = 0;
        switch (frame.func) {
        case 0xf0: data = [[1, 0], [1, 2, 3, 4, 5], [0], [0, 0, 1, 0], [1]][frame.data[0]]; break;
        case 0xfe: data = [1]; break;
        case 0x01: data = [80, 0, +sim.eeg, +sim.light[1], +sim.light[2], 0, 0, 0, 0, 0, 0, 1, 0]; break;
        case 0x20: registers.set(frame.data, 1); break;
        case 0x23: data = registers; break;
        case 0x21:
            if (!(frame.stat & 1) && sim.failStopEeg) { stat = 0x80; data = [1]; }
            else { sim.eeg = !!(frame.stat & 1); stat = +sim.eeg; }
            break;
        case 0x12: case 0x13: {
            const channel = frame.func === 0x12 ? 1 : 2;
            if (((frame.stat & 1) && (sim.failStart === true || sim.failStart === channel)) || (!(frame.stat & 1) && sim.failStopLight)) { stat = 0x80; data = [1]; }
            else { sim.light[channel] = !!(frame.stat & 1); stat = +sim.light[channel]; }
            break;
        }
        case 0x02: stat = frame.stat & 1; break;
        }
        emit(sdk.protocol.buildFrame(1, frame.func, stat, data));
    } };
    const server = { getPrimaryService: async () => ({ getCharacteristic: async uuid => uuid.includes('abf1') ? write : notify }) };
    device.name = 'BrainLume2.0C'; device.id = 'SIMULATED-NO-HARDWARE';
    device.gatt = { connected: false, connect: async () => { device.gatt.connected = sim.connected = true; return server; },
        disconnect: () => { device.gatt.connected = sim.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); } };
    Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device, getDevices: async () => [device] } });
    sim.disconnect = () => device.gatt.disconnect();
    sim.feed = async (count, mode = 'normal') => {
        if (!sim.connected || !sim.eeg) throw Error('Mock EEG is not running');
        const sdk = window.BrainLume;
        for (let i = 0; i < count; i++) {
            const payload = new Uint8Array(29);
            payload[0] = sim.seq >>> 8; payload[1] = sim.seq & 255;
            sim.seq = (sim.seq + 1) & 65535;
            const t = sim.samples / 250;
            const impedanceMode = registers[4] === 0x05;
            const code = mode === 'saturated' ? 8388607 : mode === 'flat' ? 0
                : impedanceMode ? Math.round(6000 * Math.sin(2 * Math.PI * 7.8125 * t))
                : Math.round(1800 * Math.sin(2 * Math.PI * 1.2 * t) + 450 * Math.sin(2 * Math.PI * 10 * t));
            for (let ch = 0; ch < 8; ch++) {
                const p = 5 + ch * 3; payload[p] = (code >>> 16) & 255; payload[p + 1] = (code >>> 8) & 255; payload[p + 2] = code & 255;
            }
            sim.clock += 4; sim.samples++;
            const bytes = sdk.protocol.buildFrame(1, 0x22, 0, payload);
            if (mode === 'corrupt' && i === 0) { bytes[10] ^= 1; sim.corruptedFrames++; }
            // Exercise the real BLE transport and parser with split notifications.
            if (i % 17 === 0) { emit(bytes.slice(0, 7)); emit(bytes.slice(7)); } else emit(bytes);
            if (i % 250 === 249) await new Promise(resolve => setTimeout(resolve, 0));
        }
    };
    sim.overrideStage = stage => {
        sim.stage = stage;
        if (sim.originalSmoothing) return;
        const prototype = window.BrainLumeRealtimeSleep.SleepStageSmoother.prototype;
        sim.originalSmoothing = prototype.update;
        prototype.update = function (values) {
            const result = sim.originalSmoothing.call(this, values);
            sim.rawProbabilities.push(Array.from(values));
            if (sim.stage == null) return result;
            const stageIndex = ['W', 'N1', 'N2', 'N3', 'REM'].indexOf(sim.stage);
            const probabilities = [0.0025, 0.0025, 0.0025, 0.0025, 0.0025]; probabilities[stageIndex] = 0.99;
            return { ...result, probabilities, stageIndex, confidence: 0.99, margin: 0.9875 };
        };
    };
})();
