'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sleep = require('../src/realtime-sleep');

test('linear resampling preserves endpoints and output length', () => {
    const output = Sleep.resampleLinear([0, 10, 20], 5);
    assert.deepEqual(Array.from(output), [0, 5, 10, 15, 20]);
});

test('model resampling follows the source-time grid used by training', () => {
    const output = Sleep.resampleForRate([0, 10, 20, 30, 40], 2, 1);
    assert.deepEqual(Array.from(output), [0, 20, 40]);
});

test('realtime pipeline converts device microvolts to model millivolts', () => {
    const pipeline = new Sleep.RealtimeSleepPipeline({
        inputRateHz: 1, modelRateHz: 1, epochSeconds: 2, temporalContext: 1,
    });
    pipeline.push(10);
    pipeline.push(-10);

    const input = pipeline.onlineInferenceInput();
    assert.ok(Math.abs(input.eeg[0] - 0.01) < 1e-7);
    assert.ok(Math.abs(input.eeg[1] + 0.01) < 1e-7);
});

test('quality metrics detect flatline and excessive amplitude', () => {
    assert.equal(Sleep.qualityMetrics([1, 1, 1]).reason, 'flatline');
    assert.equal(Sleep.qualityMetrics([0, 600, 0]).reason, 'amplitude');
    assert.equal(Sleep.qualityMetrics([0, 1, -1, 1]).ok, true);
});

test('quality metrics can ignore only the filter warm-up prefix', () => {
    const samples = [1000, -1000, 20, -20, 15, -15, 10, -10];
    assert.equal(Sleep.qualityMetrics(samples, { maxAbsUv: 500, sampleRateHz: 2 }).reason, 'amplitude');
    const warmed = Sleep.qualityMetrics(samples, {
        maxAbsUv: 500, sampleRateHz: 2, ignoreLeadingSeconds: 1,
    });
    assert.equal(warmed.ok, true);
    assert.equal(warmed.ignoredLeadingSamples, 2);
    assert.equal(warmed.validSamples, 6);

    const sustained = Sleep.qualityMetrics([1000, -1000, 900, -900, 800, -800], {
        maxAbsUv: 500, sampleRateHz: 2, ignoreLeadingSeconds: 1,
    });
    assert.equal(sustained.reason, 'amplitude');
});

test('realtime pipeline consumes filter warm-up allowance only once', () => {
    const pipeline = new Sleep.RealtimeSleepPipeline({
        inputRateHz: 2, modelRateHz: 1, epochSeconds: 2, temporalContext: 1,
        qualityWarmupSeconds: 1, maxAbsUv: 500,
    });
    [1000, -1000, 20, -20].forEach(value => pipeline.push(value));
    assert.equal(pipeline.qualities[0].ok, true);
    assert.equal(pipeline.qualities[0].ignoredLeadingSamples, 2);
    [1000, -1000, 20, -20].forEach(value => pipeline.push(value));
    assert.equal(pipeline.qualities[0].ok, false);
    assert.equal(pipeline.qualities[0].ignoredLeadingSamples, 0);
});

test('sleep-stage smoother normalizes probabilities and reduces one-epoch label flips', () => {
    const smoother = new Sleep.SleepStageSmoother({ alpha: 0.5 });
    const first = smoother.update([1, 0, 0, 0, 0]);
    assert.equal(first.stageIndex, 0);
    const second = smoother.update([0, 0, 0, 0, 1]);
    assert.equal(second.stageIndex, 0);
    assert.ok(Math.abs(second.probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    const third = smoother.update([0, 0, 0, 0, 1]);
    assert.equal(third.stageIndex, 4);
    assert.equal(third.changed, true);
});

test('spectral features expose a bounded delta-power ratio for the live quality gate', () => {
    const delta = Array.from({ length: 1000 }, (_, index) => Math.sin(2 * Math.PI * 2 * index / 250));
    const alpha = Array.from({ length: 1000 }, (_, index) => Math.sin(2 * Math.PI * 10 * index / 250));
    assert.ok(Sleep.spectralFeatures(delta, 250).deltaRatio > 0.8);
    assert.ok(Sleep.spectralFeatures(alpha, 250).deltaRatio < 0.2);
});

test('light stimulus presentation distinguishes protocol intent from verified hardware state', () => {
    assert.deepEqual(Sleep.lightStimulusPresentation({ connected: false }), {
        tone: 'unknown', label: '未连接', detail: '无法确认设备是否开灯',
    });
    assert.deepEqual(Sleep.lightStimulusPresentation({
        connected: true, pending: { operation: 'start', channel: 2 },
    }), {
        tone: 'pending', label: '正在开启 CH2', detail: '等待设备确认',
    });
    assert.deepEqual(Sleep.lightStimulusPresentation({ connected: true, verified: false }), {
        tone: 'unknown', label: '状态未知', detail: '等待设备状态查询',
    });
    assert.deepEqual(Sleep.lightStimulusPresentation({
        connected: true, verified: true, runningChannels: [2], checkedAt: '23:49:23',
    }), {
        tone: 'active', label: 'CH2 光照中', detail: '设备已确认 · 23:49:23',
    });
    assert.deepEqual(Sleep.lightStimulusPresentation({
        connected: true, verified: true, runningChannels: [], checkedAt: '23:50:00',
    }), {
        tone: 'off', label: '已关闭', detail: '设备已确认 · 23:50:00',
    });
});

test('pipeline emits the centered temporal-context input', () => {
    const pipeline = new Sleep.RealtimeSleepPipeline({
        inputRateHz: 2, modelRateHz: 1, epochSeconds: 2, temporalContext: 3,
    });
    let event;
    for (let sample = 0; sample < 12; sample++) event = pipeline.push(sample);
    assert.equal(event.ready, true);
    const input = pipeline.inferenceInput();
    assert.equal(input.eeg.length, 6);
    assert.equal(input.epochIndex.length, 3);
    assert.equal(input.epochCycleIndex.length, 15);
    assert.equal(input.classifiedEpochIndex, 1);
    assert.equal(input.outputIndex, 1);
    assert.equal(input.inferenceMode, 'center');
    assert.equal(input.modelDelaySeconds, 2);
    assert.equal(input.controlEligible, false);
    assert.equal(input.centerQuality.ok, true);
    assert.equal(input.targetQuality.ok, true);
});

test('diagnostic causal pipeline classifies the latest epoch after the first window', () => {
    const pipeline = new Sleep.RealtimeSleepPipeline({
        inputRateHz: 2, modelRateHz: 1, epochSeconds: 2, temporalContext: 3,
    });
    for (let sample = 0; sample < 4; sample++) pipeline.push(sample);
    const first = pipeline.onlineInferenceInput();
    assert.equal(first.classifiedEpochIndex, 0);
    assert.equal(first.outputIndex, 2);
    assert.equal(first.targetQuality.ok, true);
    assert.equal(first.controlEligible, false);
    assert.equal(first.controlEligibilityReason, 'insufficient_context');
    assert.deepEqual(Array.from(first.eeg, value => Number(value.toFixed(3))), [0, 0.002, 0, 0.002, 0, 0.002]);
    assert.deepEqual(Array.from(first.epochIndex), [0, 0, 0]);

    for (let sample = 4; sample < 8; sample++) pipeline.push(sample);
    const second = pipeline.onlineInferenceInput();
    assert.equal(second.classifiedEpochIndex, 1);
    assert.deepEqual(Array.from(second.eeg, value => Number(value.toFixed(3))), [0, 0.002, 0, 0.002, 0.004, 0.006]);
    assert.deepEqual(Array.from(second.epochIndex.slice(0, 2)), [0, 0]);
    assert.ok(Math.abs(second.epochIndex[2] - 1 / 1200) < 1e-8);
    assert.equal(second.controlEligible, false);

    for (let sample = 8; sample < 12; sample++) pipeline.push(sample);
    const full = pipeline.onlineInferenceInput();
    assert.equal(full.controlEligible, true);
    assert.equal(full.contextQualityOk, true);
    assert.equal(full.controlEligibilityReason, 'causal_latest_epoch');
});

test('sleep-stage stimulus protocol validates safety limits', () => {
    assert.deepEqual(Sleep.validateStimulusProtocol({
        enabled: true,
        targetStages: ['N3'],
        minN3Probability: 1.1,
        minConfidence: 1.1,
        consecutiveEpochs: 0,
        lightChannel: 4,
        frequencyHz: 0,
        powerPercent: 101,
        durationSeconds: 0,
        cooldownMinutes: 0,
    }), [
        'N3 候选概率阈值必须为 50%~100%',
        '连续命中次数必须为 1~15',
        '光刺激通道必须为 1、2 或全部通道',
        '光刺激频率必须为 1~100Hz',
        '光刺激功率必须为 0~100%',
        '刺激时长必须为 1~3600 秒',
        '两次自动触发最短间隔必须为 1~1440 分钟',
    ]);
});

test('sleep-stage stimulus protocol validates only thresholds used by the selected targets', () => {
    const nonN3 = Sleep.validateStimulusProtocol({
        targetStages: ['N2'],
        minN3Probability: Number.NaN,
        minConfidence: 0.8,
        durationSeconds: 10,
        cooldownMinutes: 1,
    });
    assert.deepEqual(nonN3, []);
    assert.deepEqual(Sleep.validateStimulusProtocol({
        targetStages: ['N2'],
        minConfidence: Number.NaN,
        durationSeconds: 10,
        cooldownMinutes: 1,
    }), ['其他分期置信度必须为 50%~100%']);

    const confirmedN3 = Sleep.validateStimulusProtocol({
        targetStages: ['N3'],
        n3TriggerMode: 'confirmed',
        minN3Probability: Number.NaN,
        minConfidence: 0.8,
        durationSeconds: 10,
        cooldownMinutes: 1,
    });
    assert.deepEqual(confirmedN3, []);

    const probabilityN3 = Sleep.validateStimulusProtocol({
        targetStages: ['N3'],
        n3TriggerMode: 'probability',
        minN3Probability: 0.85,
        minConfidence: Number.NaN,
        durationSeconds: 10,
        cooldownMinutes: 1,
    });
    assert.deepEqual(probabilityN3, []);
});

test('sleep-stage stimulus gate triggers only after consecutive valid target epochs', () => {
    const gate = new Sleep.SleepStageStimulusGate({
        enabled: true,
        targetStages: ['N2', 'N3'],
        minConfidence: 0.8,
        consecutiveEpochs: 2,
        lightChannel: 2,
        frequencyHz: 40,
        powerPercent: 20,
        durationSeconds: 10,
        cooldownMinutes: 15,
    });
    const quality = { ok: true };

    assert.equal(gate.evaluate({ epochIndex: 10, stage: 'W', confidence: 0.95, quality }, 1_000).reason, 'stage_not_selected');
    assert.equal(gate.evaluate({ epochIndex: 11, stage: 'N2', confidence: 0.79, quality }, 2_000).reason, 'low_confidence');
    assert.equal(gate.evaluate({ epochIndex: 12, stage: 'N2', confidence: 0.9, quality: { ok: false } }, 3_000).reason, 'poor_quality');
    assert.deepEqual(gate.evaluate({ epochIndex: 13, stage: 'N2', confidence: 0.9, quality }, 4_000), {
        triggered: false, reason: 'awaiting_consecutive', stage: 'N2', matchedCount: 1, requiredCount: 2,
    });
    const trigger = gate.evaluate({ epochIndex: 14, stage: 'N2', confidence: 0.91, quality }, 5_000);
    assert.equal(trigger.triggered, true);
    assert.equal(trigger.stage, 'N2');
    assert.equal(trigger.lightChannel, 2);
    assert.equal(trigger.durationMs, 10_000);
    assert.equal(trigger.confidence, 0.91);
    assert.equal(trigger.shadowMode, true);
});

test('sleep-stage stimulus gate trusts an explicit conservative N3 postprocess result', () => {
    const gate = new Sleep.SleepStageStimulusGate({
        enabled: true, targetStages: ['N3'], n3TriggerMode: 'confirmed', minConfidence: 0.9,
        consecutiveEpochs: 1,
    });
    const decision = gate.evaluate({
        epochIndex: 1, stage: 'N3', confidence: 0.96,
        quality: { ok: true }, n3Postprocessed: true,
    }, 1_000);
    assert.equal(decision.triggered, true);
    assert.equal(decision.stage, 'N3');
});

test('N3 conservative confidence and non-N3 confidence use separate thresholds', () => {
    const n3Gate = new Sleep.SleepStageStimulusGate({
        enabled: true, targetStages: ['N3'], n3TriggerMode: 'confirmed',
        minN3Confidence: 0.9, minConfidence: 0.5, consecutiveEpochs: 1,
    });
    assert.equal(n3Gate.evaluate({
        epochIndex: 1, stage: 'N3', confidence: 0.85, n3Postprocessed: true, quality: { ok: true },
    }).reason, 'low_confidence');
    assert.equal(n3Gate.evaluate({
        epochIndex: 2, stage: 'N3', confidence: 0.91, n3Postprocessed: true, quality: { ok: true },
    }).triggered, true);

    const otherGate = new Sleep.SleepStageStimulusGate({
        enabled: true, targetStages: ['N2'], n3TriggerMode: 'probability',
        minN3Confidence: 0.99, minConfidence: 0.9, consecutiveEpochs: 1,
    });
    assert.equal(otherGate.evaluate({
        epochIndex: 1, stage: 'N2', confidence: 0.85, quality: { ok: true },
    }).reason, 'low_confidence');
    assert.equal(otherGate.evaluate({
        epochIndex: 2, stage: 'N2', confidence: 0.91, quality: { ok: true },
    }).triggered, true);
});

test('sleep-stage stimulus gate rejects duplicate results, active stimulation and cooldown', () => {
    const gate = new Sleep.SleepStageStimulusGate({
        enabled: true,
        targetStages: ['REM'],
        minConfidence: 0.7,
        consecutiveEpochs: 1,
        lightChannel: 1,
        frequencyHz: 10,
        powerPercent: 5,
        durationSeconds: 10,
        cooldownMinutes: 1,
    });
    const result = { epochIndex: 20, stage: 'REM', confidence: 0.9, quality: { ok: true } };
    assert.equal(gate.evaluate(result, 1_000).triggered, true);
    assert.equal(gate.evaluate(result, 2_000).reason, 'duplicate_epoch');
    assert.equal(gate.evaluate({ ...result, epochIndex: 21 }, 5_000).reason, 'stimulus_active');
    assert.equal(gate.evaluate({ ...result, epochIndex: 22 }, 12_000).reason, 'cooldown');
    assert.equal(gate.evaluate({ ...result, epochIndex: 23 }, 61_000).triggered, true);
});

test('sleep-stage stimulus protocol normalizes defaults and rejects invalid updates', () => {
    assert.deepEqual(Sleep.normalizeStimulusProtocol(null), {
        enabled: false,
        shadowMode: true,
        targetStages: ['N3'],
        n3TriggerMode: 'probability',
        minN3Probability: 0.85,
        minN3Confidence: 0.8,
        minConfidence: 0.8,
        consecutiveEpochs: 2,
        lightChannel: 3,
        frequencyHz: 10,
        powerPercent: 5,
        durationSeconds: 10,
        cooldownMinutes: 15,
    });
    assert.deepEqual(Sleep.normalizeStimulusProtocol({ targetStages: ['N2', 'bad', 'N2'] }).targetStages, ['N2']);
    const gate = new Sleep.SleepStageStimulusGate();
    assert.equal(gate.evaluate({ epochIndex: 1 }).reason, 'disabled');
    assert.throws(() => gate.updateProtocol({ targetStages: [] }), /至少选择一个目标睡眠分期/);
    assert.equal(Sleep.normalizeStimulusProtocol({ shadowMode: false }).shadowMode, false);
});

test('sleep-stage stimulus gate can trigger from an N3 candidate probability', () => {
    const gate = new Sleep.SleepStageStimulusGate({
        enabled: true,
        targetStages: ['N3'],
        n3TriggerMode: 'probability',
        minN3Probability: 0.85,
        consecutiveEpochs: 2,
    });
    const quality = { ok: true };
    const first = gate.evaluate({
        epochIndex: 30, stage: 'UNKNOWN', candidateStage: 'N3', candidateConfidence: 0.86, confidence: 0,
        quality,
    }, 1_000);
    assert.deepEqual(first, {
        triggered: false, reason: 'awaiting_consecutive', stage: 'N3', matchedCount: 1, requiredCount: 2,
    });
    const second = gate.evaluate({
        epochIndex: 31, stage: 'UNKNOWN', candidateStage: 'N3', candidateConfidence: 0.88, confidence: 0,
        quality,
    }, 2_000);
    assert.equal(second.triggered, true);
    assert.equal(second.triggerBasis, 'n3_probability');
    assert.equal(second.n3Probability, 0.88);
    assert.equal(second.confidence, 0.88);
});

test('probability trigger rejects a candidate below the configured N3 threshold', () => {
    const gate = new Sleep.SleepStageStimulusGate({
        enabled: true, targetStages: ['N3'], n3TriggerMode: 'probability', minN3Probability: 0.85,
    });
    assert.equal(gate.evaluate({
        epochIndex: 40, stage: 'UNKNOWN', candidateStage: 'N3', candidateConfidence: 0.84,
        quality: { ok: true },
    }).reason, 'low_confidence');
});

test('sleep-stage stimulus gate resets changed-stage runs and can cancel a failed trigger', () => {
    const gate = new Sleep.SleepStageStimulusGate({
        enabled: true,
        targetStages: ['N2', 'N3'],
        consecutiveEpochs: 2,
    });
    const base = { confidence: 0.9, quality: { ok: true, deltaRatio: 0.4 } };
    assert.equal(gate.evaluate({ ...base, epochIndex: 1, stage: 'N2' }, 1).matchedCount, 1);
    assert.equal(gate.evaluate({ ...base, epochIndex: 2, stage: 'N3' }, 2).matchedCount, 1);
    assert.equal(gate.evaluate({ ...base, epochIndex: 3, stage: 'N3' }, 3).triggered, true);
    gate.cancelTrigger();
    assert.equal(gate.evaluate({ ...base, epochIndex: 4, stage: 'N3' }, 4).matchedCount, 1);
    gate.reset();
    assert.equal(gate.evaluate({ ...base, epochIndex: 1, stage: 'N3' }, 5).matchedCount, 1);
});

test('realtime helpers cover empty, unchanged and rolling inputs', () => {
    assert.deepEqual(Sleep.resampleLinear([], 5), []);
    assert.deepEqual(Sleep.resampleLinear([1, 2], 0), []);
    assert.deepEqual(Sleep.resampleLinear([1, 2], 2), [1, 2]);
    assert.equal(Sleep.qualityMetrics([]).reason, 'empty');
    assert.equal(Sleep.qualityMetrics([0, 0.1, -0.1], { minStdUv: 1 }).reason, 'flatline');

    const pipeline = new Sleep.RealtimeSleepPipeline({ inputRateHz: 1, modelRateHz: 1, epochSeconds: 2, temporalContext: 2 });
    assert.equal(pipeline.push(Number.NaN), null);
    assert.equal(pipeline.inferenceInput(), null);
    for (let value = 0; value < 6; value++) pipeline.push(value);
    assert.equal(pipeline.epochs.length, 2);
    assert.equal(pipeline.qualities.length, 2);
    assert.equal(pipeline.progress, 0);
});

test('realtime pipeline marks a sequence gap and does not carry synthetic samples into context', () => {
    const pipeline = new Sleep.RealtimeSleepPipeline({ inputRateHz: 2, modelRateHz: 1, epochSeconds: 2, temporalContext: 2 });
    pipeline.push(1);
    const event = pipeline.push(2, { seqGap: 1 });
    assert.equal(event, null);
    const completed = pipeline.push(3);
    assert.equal(completed.gapSamples, 1);
    assert.equal(completed.quality.ok, false);
    assert.equal(completed.quality.reason, 'sample_gap');
    assert.equal(pipeline.epochs.length, 0);
});
