'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('unexpected disconnect removes the old notification listener before a characteristic is reused', () => {
    delete require.cache[require.resolve('../src/transport.js')];
    require('../src/transport.js');
    try {
        const { BleTransport } = globalThis.BrainLumeBle;
        const notify = new EventTarget();
        const old = new BleTransport(), current = new BleTransport();
        let oldSamples=0, currentSamples=0;
        old.onData(() => oldSamples++); current.onData(() => currentSamples++);
        old.notifyCharacteristic = notify;
        notify.addEventListener('characteristicvaluechanged', old._onNotification);
        old._onDisconnected();
        current.notifyCharacteristic = notify;
        notify.addEventListener('characteristicvaluechanged', current._onNotification);
        notify.value = new DataView(Uint8Array.from([1,2,3]).buffer);
        notify.dispatchEvent(new Event('characteristicvaluechanged'));
        assert.equal(oldSamples, 0);
        assert.equal(currentSamples, 1);
        current._clearGattState(false);
    } finally { delete globalThis.BrainLumeBle; }
});

test('desktop app keeps a bounded extended Windows GATT recovery window', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    assert.match(source, /const BLE_CONNECT_ATTEMPTS = 6;/);
    assert.match(source, /const BLE_CONNECT_RETRY_DELAY_MS = 1000;/);
    assert.match(source, /connectAttempts: BLE_CONNECT_ATTEMPTS/);
    assert.match(source, /connectRetryDelayMs: BLE_CONNECT_RETRY_DELAY_MS/);
});

test('BLE transport retries only the selected device GATT connection', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const statuses = [];
    let connectCalls = 0;
    let requestCalls = 0;
    let disconnectCalls = 0;
    let requestOptions = null;

    const notifyCharacteristic = {
        addEventListener() {},
        removeEventListener() {},
        async startNotifications() {},
        async stopNotifications() {},
    };
    const writeCharacteristic = {
        async writeValueWithoutResponse() {},
    };
    const service = {
        async getCharacteristic(uuid) {
            return uuid.endsWith('abf1-0000-1000-8000-00805f9b34fb')
                ? writeCharacteristic
                : notifyCharacteristic;
        },
    };
    const server = {
        async getPrimaryService() { return service; },
    };
    const device = {
        name: 'BrainLume2.0C',
        id: 'selected-device',
        addEventListener() {},
        removeEventListener() {},
        gatt: {
            connected: false,
            async connect() {
                connectCalls += 1;
                if (connectCalls < 3) throw new Error('Connection attempt failed.');
                this.connected = true;
                return server;
            },
            disconnect() {
                disconnectCalls += 1;
                this.connected = false;
            },
        },
    };

    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            bluetooth: {
                async requestDevice(options) {
                    requestCalls += 1;
                    requestOptions = options;
                    return device;
                },
            },
        },
    });

    try {
        delete require.cache[require.resolve('../src/transport.js')];
        require('../src/transport.js');
        const transport = new globalThis.BrainLumeBle.BleTransport({
            connectAttempts: 3,
            connectRetryDelayMs: 1,
        });
        transport.onStatus(status => statuses.push(status));

        await transport.connect();

        assert.equal(requestCalls, 1);
        assert.deepEqual(requestOptions.filters, [
            { name: 'BrainLume2.0C' },
            { services: ['0000abf0-0000-1000-8000-00805f9b34fb'] },
        ]);
        assert.equal(connectCalls, 3);
        assert.equal(disconnectCalls, 0);
        assert.equal(transport.isConnected(), true);
        assert.equal(statuses.filter(status => status.phase === 'attempt_failed').length, 2);
        assert.equal(statuses.at(-1).phase, 'connected');
    } finally {
        delete globalThis.BrainLumeBle;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
    }
});

test('BLE transport reports the final failing stage after bounded retries', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let connectCalls = 0;
    const device = {
        name: 'BrainLume2.0C',
        id: 'selected-device',
        addEventListener() {},
        removeEventListener() {},
        gatt: {
            connected: false,
            async connect() {
                connectCalls += 1;
                throw new Error('Connection attempt failed.');
            },
            disconnect() { this.connected = false; },
        },
    };

    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { bluetooth: { async requestDevice() { return device; } } },
    });

    try {
        delete require.cache[require.resolve('../src/transport.js')];
        require('../src/transport.js');
        const transport = new globalThis.BrainLumeBle.BleTransport({
            connectAttempts: 2,
            connectRetryDelayMs: 1,
        });

        await assert.rejects(
            transport.connect(),
            error => error.code === 'BLE_CONNECT_RETRIES_EXHAUSTED'
                && error.bleStage === 'gatt_connect'
                && error.attempts === 2,
        );
        assert.equal(connectCalls, 2);
    } finally {
        delete globalThis.BrainLumeBle;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
    }
});

test('a pending system GATT connection times out without overlapping a retry', async () => {
    const sandbox = { navigator: { bluetooth: {} }, setTimeout, clearTimeout };
    const source = fs.readFileSync(require.resolve('../src/transport.js'), 'utf8');
    require('node:vm').runInNewContext(source, sandbox);
    const { BleTransport } = sandbox.BrainLumeBle;
    const transport = new BleTransport({ connectAttempts: 6, connectTimeoutMs: 10 });
    let connectCalls = 0;
    let disconnectCalls = 0;
    let complete;
    transport.device = {
        gatt: {
            connected: false,
            connect() {
                connectCalls++;
                return new Promise(resolve => { complete = resolve; });
            },
            disconnect() { disconnectCalls++; },
        },
    };
    await assert.rejects(transport.connect(), error => error.code === 'BLE_GATT_TIMEOUT'
        && error.bleStage === 'gatt_connect' && error.attempts === 1);
    complete({});
    await Promise.resolve();
    assert.equal(connectCalls, 1);
    assert.equal(disconnectCalls, 1);
    assert.equal(transport.server, null);
});
