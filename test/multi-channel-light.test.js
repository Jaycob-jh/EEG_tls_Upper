'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Sleep = require('../src/realtime-sleep');

test('70% N3 trigger waits for fifteen consecutive qualifying epochs and resets below threshold', () => {
    const gate = new Sleep.SleepStageStimulusGate({ enabled: true, targetStages: ['N3'],
        minN3Probability: 0.7, consecutiveEpochs: 15, lightChannel: 3,
        frequencyHz: 40, powerPercent: 5, durationSeconds: 720, cooldownMinutes: 30 });
    const result = epochIndex => ({ epochIndex, stage: 'N3', candidateStage: 'N3',
        probabilities: [0.05, 0.05, 0.1, 0.7, 0.1], confidence: 0.7, quality: { ok: true } });
    for (let epoch = 1; epoch < 15; epoch++) assert.equal(gate.evaluate(result(epoch), epoch * 30000).triggered, false);
    const trigger = gate.evaluate(result(15), 450000);
    assert.equal(trigger.triggered, true);
    assert.equal(trigger.durationMs, 720000);
    gate.reset();
    for (let epoch = 1; epoch < 15; epoch++) gate.evaluate(result(epoch), epoch * 30000);
    gate.evaluate({ ...result(15), probabilities: [0.05, 0.05, 0.2, 0.6, 0.1], confidence: 0.6 }, 450000);
    assert.equal(gate.evaluate(result(16), 480000).matchedCount, 1);
});

function harness(fail = () => false) {
    const source = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    const calls = [];
    const command = async (operation, channel, config) => {
        calls.push({ operation, channel, config });
        if (fail(operation, channel)) throw new Error('simulated BLE failure');
    };
    const context = vm.createContext({
        state: { connected: true, eegRunning: true, sleepStimulusProtocol: { enabled: true },
            sleepStimulusGate: { cancelTrigger() {} }, lightRunning: {} },
        planEngine: { getRelativeStatus: () => false },
        requireClient: () => ({
            setLightConfig: (ch, config) => command('configure', ch, config),
            startLight: ch => command('start', ch), stopLight: ch => command('stop', ch),
        }),
        runLightOperation: async (_op, _ch, fn) => fn(),
        audit: async () => {}, addActivity() {}, lightContext: x => x,
        setSleepStimulusStatus() {},
    });
    const wrappers = source.slice(source.indexOf('    async function configureLight('), source.indexOf('    async function performSafeStop('));
    const execute = source.slice(source.indexOf('    async function executeSleepStimulusHardware('), source.indexOf('    async function handleSleepStimulusResult('));
    vm.runInContext(wrappers + execute, context);
    return { context, calls };
}

test('both light outputs receive the requested 12-minute configuration; no synthetic channel reaches BLE', async () => {
    const protocol = Sleep.normalizeStimulusProtocol({ lightChannel: 3, frequencyHz: 40,
        powerPercent: 5, durationSeconds: 720, cooldownMinutes: 30 });
    assert.deepEqual(Sleep.validateStimulusProtocol(protocol), []);
    const { context, calls } = harness();
    await context.configureLight(3, { frequencyHz: 40, durationMs: 720000, powerPercent: 5 });
    await context.startLight(3);
    await context.stopLight(3);
    assert.deepEqual(calls.map(c => [c.operation, c.channel]), [
        ['configure', 1], ['configure', 2], ['start', 1], ['start', 2], ['stop', 1], ['stop', 2],
    ]);
    assert.equal(calls[1].config.durationMs, 720000);
});

test('a failed first stop still attempts to stop the second output', async () => {
    const { context, calls } = harness((op, ch) => op === 'stop' && ch === 1);
    await assert.rejects(context.stopLight(3));
    assert.deepEqual(calls.map(c => c.channel), [1, 2]);
});

test('partial dual-output startup failure stops both selected outputs', async () => {
    const { context, calls } = harness((op, ch) => op === 'start' && ch === 2);
    await assert.rejects(context.executeSleepStimulusHardware({
        lightChannel: 3, frequencyHz: 40, powerPercent: 5, durationMs: 720000, epochIndex: 21,
    }, 'N3'));
    assert.deepEqual(calls.slice(-2).map(c => [c.operation, c.channel]), [['stop', 1], ['stop', 2]]);
});
