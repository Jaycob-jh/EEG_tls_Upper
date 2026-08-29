(function () {
    'use strict';
    const SDK = window.BrainLume;
    const { BleTransport } = window.BrainLumeBle;
    const request = window.desktopAPI.getDebugRequest();
    const tx = [];
    const rx = [];
    const hex = bytes => Array.from(bytes || [], byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    const jsonBytes = value => value instanceof Uint8Array ? hex(value) : value;
    const errorContext = error => ({
        name: error?.name, message: error?.message, code: error?.code,
        addr: error?.addr, func: error?.func, stat: error?.stat, len: error?.len,
        dataHex: error?.data ? hex(error.data) : undefined,
        request: error?.request ? { ...error.request, dataHex: hex(error.request.data), frameHex: hex(error.request.frame) } : undefined,
    });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function run() {
        const startedAt = Date.now();
        const result = { ok: false, command: request, device: null, request: [], response: [], timing: {} };
        const transport = new BleTransport({ reuseGrantedDevice: true, requireGrantedDevice: true });
        try {
            const originalWrite = transport.write.bind(transport);
            transport.write = bytes => { tx.push({ hex: hex(bytes), length: bytes.length }); return originalWrite(bytes); };
            const client = new SDK.BrainLumeClient({ transport, address: 0x01, timeoutMs: 3000 });
            client.on('frame', frame => { if (frame.func !== SDK.FUNC.EEG_RAW) rx.push({ addr: frame.addr, func: frame.func, stat: frame.stat, len: frame.len, dataHex: hex(frame.data), frameHex: hex(frame.raw) }); });
            let sampleCount = 0; let firstSeq = null; let lastSeq = null; let seqGaps = 0;
            client.on('eeg', (_decoded, frame) => {
                sampleCount++;
                const seq = (frame.data[0] << 8) | frame.data[1];
                if (lastSeq != null) { const gap = (seq - lastSeq + 65536) % 65536; if (gap > 1) seqGaps += gap - 1; }
                if (firstSeq == null) firstSeq = seq;
                lastSeq = seq;
            });
            await client.connect();
            result.device = { name: transport.name, id: transport.id, availableDevices: transport.availableDevices };
            const command = request.command;
            if (command === 'discover') result.value = await client.discover();
            else if (command === 'status') result.value = await client.getStatus();
            else if (command === 'read-registers') result.value = await client.readAds1299Registers();
            else if (command === 'stop-all') {
                const errors = [];
                for (const action of [() => client.stopLight(1), () => client.stopLight(2), () => client.stopEeg()]) { try { await action(); } catch (error) { errors.push(errorContext(error)); } }
                result.value = { stopped: true, errors };
            } else if (command === 'config-eeg' || command === 'start-eeg') {
                const expected = SDK.ads1299.createRecommendedConfig({ impedance: Boolean(request.impedance), channels: [request.channel || 2] });
                const before = await client.readAds1299Registers();
                let readback = before.values;
                let mismatches = SDK.ads1299.compareAdsConfig(expected, before.values);
                let skippedWrite = mismatches.length === 0;
                if (mismatches.length) {
                    const status = await client.getStatus();
                    if (status.eegRunning) { await client.stopEeg(); await wait(2); }
                    await client.configureEeg(expected); await wait(2);
                    const after = await client.readAds1299Registers();
                    readback = after.values;
                    mismatches = SDK.ads1299.compareAdsConfig(expected, after.values);
                    if (mismatches.length) throw Object.assign(new Error('ADS1299 configuration readback mismatch'), { code: 'CONFIG_READBACK_MISMATCH', mismatches });
                }
                result.value = { expectedHex: hex(expected), readbackHex: hex(readback), mismatches, skippedWrite };
                if (command === 'start-eeg') {
                    const seconds = request.seconds || 3;
                    await client.startEeg();
                    await wait(seconds * 1000);
                    await client.stopEeg();
                    result.eeg = { seconds, samples: sampleCount, samplesPerSecond: sampleCount / seconds, firstSeq, lastSeq, seqGaps };
                }
            } else if (command === 'raw') {
                const value = SDK.protocol.command(request.addr, request.func, request.stat, request.data || []);
                result.value = await client.sendCommand(value);
            } else throw Object.assign(new Error(`Unknown command: ${command}`), { code: 'INVALID_COMMAND' });
            result.ok = true;
        } catch (error) {
            result.error = { ...errorContext(error), availableDevices: transport.availableDevices, nextAction: error.code === 'NO_AUTHORIZED_DEVICE' ? 'Connect BrainLume2.0C once from the normal UI, then rerun this command.' : undefined };
        } finally {
            result.request = tx;
            result.response = rx;
            result.timing.elapsedMs = Date.now() - startedAt;
            try { await transport.disconnect(); } catch (error) { result.disconnectError = errorContext(error); }
            await window.desktopAPI.sendDebugResult(result);
        }
    }
    run().catch(error => window.desktopAPI.sendDebugResult({ ok: false, command: request, error: errorContext(error) }));
}());
