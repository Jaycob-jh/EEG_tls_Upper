'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Core = require('../src/core');
const Analysis = require('../src/analysis-core');
const Report = require('../src/analysis-report');

function tone(count, sampleRateHz, frequencyHz, peak, dc = 0) {
    return Float64Array.from({ length: count }, (_, index) => dc + peak * Math.sin(2 * Math.PI * frequencyHz * index / sampleRateHz));
}

function workerRequest(worker, action, payload) {
    const id = Math.random().toString(36);
    return new Promise((resolve, reject) => {
        const listener = message => {
            if (message.type !== 'response' || message.id !== id) return;
            worker.off('message', listener);
            if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
        };
        worker.on('message', listener);
        worker.postMessage({ id, action, payload });
    });
}

test('CSV parser preserves quoted commas and escaped quotes', () => {
    assert.deepEqual(Analysis.parseCsvLine('a,"b,c","d""e"'), ['a', 'b,c', 'd"e']);
});

test('offline zero-phase filter preserves 10Hz and suppresses DC and 50Hz', () => {
    const sampleRateHz = 250;
    const count = sampleRateHz * 40;
    const input = Float64Array.from({ length: count }, (_, index) => 5000
        + 100 * Math.sin(2 * Math.PI * 10 * index / sampleRateHz)
        + 80 * Math.sin(2 * Math.PI * 50 * index / sampleRateHz));
    const output = Analysis.zeroPhaseFilter(input, sampleRateHz);
    const stable = output.subarray(sampleRateHz * 3, output.length - sampleRateHz * 3);
    const ten = Analysis.toneRms(stable, sampleRateHz, 10) * Math.sqrt(2);
    const fifty = Analysis.toneRms(stable, sampleRateHz, 50) * Math.sqrt(2);
    assert.ok(ten > 95 && ten < 105, `10Hz peak was ${ten}`);
    assert.ok(fifty < 2, `50Hz peak was ${fifty}`);
    assert.ok(Math.abs(Analysis.percentile(stable, .5)) < 1);
});

test('event pairing builds equal before and after windows', () => {
    const events = [
        { ts: '2026-08-07T10:00:00+08:00', action: 'session_started' },
        { ts: '2026-08-07T10:01:00+08:00', action: 'light_started', channel: 2 },
        { ts: '2026-08-07T10:01:30+08:00', action: 'light_stopped', channel: 2 },
    ];
    const result = Analysis.pairLightEvents(events, 180);
    assert.equal(result.segments.length, 1);
    assert.deepEqual(result.segments[0], { id: 'light-2-1', channel: 2, startSec: 60, endSec: 90,
        preStartSec: 30, postEndSec: 120, source: 'event-log' });
});

test('dense viewport envelope preserves a narrow spike', () => {
    const values = new Float64Array(10000);
    values[5432] = 900;
    const view = Analysis.createViewport(values, 0, values.length, 200);
    assert.equal(view.mode, 'envelope');
    assert.equal(Math.max(...view.highs), 900);
});

test('STFT spectrogram localizes a stationary 10 Hz rhythm', () => {
    const sampleRateHz = 250;
    const values = tone(sampleRateHz * 12, sampleRateHz, 10, 40);
    const result = Analysis.spectrogram(values, sampleRateHz, { windowSeconds: 2, maxHz: 45, maxTimeBins: 100 });
    assert.ok(result.timeBins > 1);
    assert.ok(result.frequencyBins > 10);
    const middle = Math.floor(result.timeBins / 2);
    let peakIndex = 1;
    for (let index = 2; index < result.frequencyBins; index++) {
        if (result.powerDb[middle * result.frequencyBins + index] > result.powerDb[middle * result.frequencyBins + peakIndex]) peakIndex = index;
    }
    assert.ok(Math.abs(result.frequencies[peakIndex] - 10) < 0.75, `peak frequency was ${result.frequencies[peakIndex]} Hz`);
});

test('analysis worker reads a session and computes phase metrics', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainlume-analysis-'));
    const sampleRateHz = 250;
    const values = tone(sampleRateHz * 35, sampleRateHz, 10, 20, 1000);
    const metadata = { id: 'session-test', rows: values.length, sampleRateHz, selectedChannel: 2, startedAt: '2026-08-07T10:00:00+08:00' };
    await fsp.writeFile(path.join(directory, 'session.json'), JSON.stringify(metadata));
    await fsp.writeFile(path.join(directory, 'events.jsonl'), [
        { ts: '2026-08-07T10:00:00+08:00', action: 'session_started' },
        { ts: '2026-08-07T10:00:10+08:00', action: 'light_started', channel: 2 },
        { ts: '2026-08-07T10:00:20+08:00', action: 'light_stopped', channel: 2 },
    ].map(JSON.stringify).join('\n'));
    const header = 'session_id,plan_id,device_id,selected_channel,sample_index,received_at_iso,elapsed_us,seq,status_hex,raw_code,voltage_uv,payload_hex,seq_gap\n';
    const rows = Array.from(values, (value, index) => `session-test,,,2,${index},2026-08-07T10:00:00+08:00,${index * 4000},${index % 65536},C00000,${Math.round(value)},${value},00,0`).join('\n');
    await fsp.writeFile(path.join(directory, 'eeg_raw.csv'), header + rows + '\n');
    const worker = new Worker(path.join(__dirname, '..', 'analysis-worker.js'));
    try {
        const summary = await workerRequest(worker, 'open', { directory, sessionId: metadata.id });
        assert.equal(summary.integrity.validSamples, values.length);
        assert.equal(summary.segments.length, 1);
        assert.equal(summary.phaseMetrics.length, 1);
        assert.equal(summary.epochs.length, 1);
        const viewport = await workerRequest(worker, 'viewport', { source: 'filtered', startSample: 0, endSample: values.length, pixelWidth: 300 });
        assert.equal(viewport.mode, 'envelope');
        const spectrogram = await workerRequest(worker, 'spectrogram', { source: 'filtered', windowSeconds: 2, maxHz: 45, maxTimeBins: 80 });
        assert.ok(spectrogram.timeBins > 1);
        assert.ok(spectrogram.powerDb.length === spectrogram.timeBins * spectrogram.frequencyBins);
    } finally {
        await worker.terminate();
        await fsp.rm(directory, { recursive: true, force: true });
    }
});

test('analysis worker accepts the appended row_index CSV schema', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'brainlume-analysis-row-index-'));
    const sampleRateHz = 250;
    const values = tone(sampleRateHz * 2, sampleRateHz, 10, 20, 1000);
    await fsp.writeFile(path.join(directory, 'session.json'), JSON.stringify({
        id: 'session-row-index', rows: values.length, sampleRateHz, selectedChannel: 2,
        startedAt: '2026-08-07T10:00:00+08:00',
    }));
    await fsp.writeFile(path.join(directory, 'events.jsonl'), '');
    const rows = Array.from(values, (value, index) => Core.eegCsvLine({
        session_id: 'session-row-index', selected_channel: 2,
        sample_index: (65530 + index) % 65536, row_index: index,
        received_at_iso: '2026-08-07T10:00:00+08:00', elapsed_us: index * 4000,
        seq: (65530 + index) % 65536, status_hex: 'C00000', raw_code: Math.round(value),
        voltage_uv: value, payload_hex: '00', seq_gap: 0,
    })).join('\n');
    await fsp.writeFile(path.join(directory, 'eeg_raw.csv'), `${Core.EEG_CSV_COLUMNS.join(',')}\n${rows}\n`);
    const worker = new Worker(path.join(__dirname, '..', 'analysis-worker.js'));
    try {
        const summary = await workerRequest(worker, 'open', { directory, sessionId: 'session-row-index' });
        assert.equal(summary.integrity.validSamples, values.length);
        assert.equal(summary.integrity.seqGaps, 0);
    } finally {
        await worker.terminate();
    }
});

test('report output contains charts, disclaimer and reproducible CSV attachments', () => {
    const phase = { startSec: 0, endSec: 1, durationSeconds: 1, rmsUv: 1, peakToPeakUv: 2, robustRangeUv: 2,
        bandPowers: Object.fromEntries(Analysis.BAND_DEFINITIONS.map(band => [band.id, { label: band.label, absolute: 1, relativePercent: 10 }])),
        psd: { frequencies: [0, 10], power: [1, 2] }, changeFromBeforePercent: { stimulus40: 0 } };
    const data = { generatedAt: 'now', metadata: { selectedChannel: 2 }, durationSeconds: 1, integrity: { validSamples: 2, epochs: 1, rejectedEpochs: 0 },
        metrics: { bandPowers: phase.bandPowers }, epochs: [{ index: 0, startSec: 0, endSec: 1, rmsUv: 1, robustRangeUv: 2, rejected: false }],
        phaseMetrics: [{ channel: 2, source: 'manual', startSec: 0, endSec: 1, phases: { before: phase, during: phase, after: phase } }],
        charts: { overview: { samples: [0,1] }, comparison: { startSec: 0, raw: { samples: [0,1] }, filtered: { samples: [0,1] } } } };
    const html = Report.buildReportHtml(data);
    assert.match(html, /不构成医疗诊断/);
    assert.match(html, /data-chart="overview"/);
    assert.match(Report.epochsCsv(data.epochs), /robust_range_uv/);
    assert.match(Report.phaseMetricsCsv(data.phaseMetrics), /stimulus40_pct/);
});
