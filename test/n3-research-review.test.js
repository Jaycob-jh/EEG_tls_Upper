'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { openResearchReview, registerResearchReview } = require('../src/n3-research-review');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'caocao-review-test-'));
    const dataPath = path.join(root, 'R01.f32'), catalogPath = path.join(root, 'catalog.json');
    const configPath = path.join(root, 'config.json');
    t.after(async () => {
        for (const file of [dataPath, catalogPath, configPath]) await fs.rm(file, { force: true });
        await fs.rmdir(root);
    });
    const points = 7500;
    const buf = Buffer.alloc(3 * 3 * points * 4);
    for (let block = 0; block < 3; block++) {
        for (let track = 0; track < 3; track++) {
            buf.writeFloatLE(100 * block + 10 * track + 1, (block * 3 + track) * points * 4);
        }
    }
    const epochs = [0, 1, 2].map(epochIndex => ({
        epochIndex, startSec: epochIndex * 30, endSec: (epochIndex + 1) * 30,
        anysleepDetrended: 'N3', yasa: 'N3', caocao: 'W', strictSlowSeconds: 1,
        rawDriftPercent: 32, inputClippedPercent: 0, warnings: [],
        status: epochIndex === 2 ? 'no_alert' : 'review', slowMarks: [[250, 500]],
    }));
    const catalog = {
        schema: 1, reviewOnly: true, rateHz: 250, epochSeconds: 30, tracks: ['raw', 'highpass', 'slow'],
        records: [{ id: 'R01', date: '2026-08-31', epochCount: 3, epochs, edfSha256: 'a'.repeat(64),
            waveformSha256: createHash('sha256').update(buf).digest('hex') }],
        ranked: [1, 0].map((epochIndex, i) => ({
            rank: i + 1, record: 'R01', epochIndex, modelVotes: 2, fails: ['slow_lt_6s'],
        })),
        prelabels: [{ priority: 1, rank: 1, label: 'N3_like_low_confidence', note: '仅作研究', trainingEligible: false }],
    };
    const writeCatalog = () => fs.writeFile(catalogPath, JSON.stringify(catalog));
    await writeCatalog();
    await fs.writeFile(dataPath, buf);
    await fs.writeFile(configPath, JSON.stringify({ catalogDir: root }));
    return { root, dataPath, configPath, catalog, writeCatalog, buf };
}

test('research queue preserves order and prelabel identity; click reads exactly the selected epoch and its neighbors', async t => {
    const fx = await fixture(t);
    const store = await openResearchReview(fx.root);
    const listing = store.list();
    assert.equal(listing.reviewOnly, true);
    assert.deepEqual(listing.ranked.map(row => row.epochIndex), [1, 0]);
    assert.equal(listing.prelabels[0].trainingEligible, false);
    assert.equal(listing.prelabels[0].caocao, 'W');
    assert.equal(listing.records[0].queueCount, 2);
    assert.equal(Object.hasOwn(listing.records[0], 'edfSha256'), false);
    const result = await store.context(1);
    assert.deepEqual(result.epochs.map(row => [row.relative, row.startSec, row.endSec]), [[-1, 0, 30], [0, 30, 60], [1, 60, 90]]);
    assert.deepEqual(result.epochs.map(row => [row.tracks.raw[0], row.tracks.highpass[0], row.tracks.slow[0]]),
        [[1, 11, 21], [101, 111, 121], [201, 211, 221]]);
    assert.ok(result.epochs.every(row => row.tracks.raw.length === 7500));
    assert.deepEqual((await store.context(2)).epochs.map(row => row.relative), [0, 1]);
    for (const invalid of [0, 3, '1', { file: '../secret' }]) await assert.rejects(store.context(invalid), /不在本地复核队列/);
});

test('research queue rejects changed wave bytes and prelabels that are not review-only', async t => {
    const fx = await fixture(t);
    const store = await openResearchReview(fx.root);
    fx.buf[0] ^= 1;
    await fs.writeFile(fx.dataPath, fx.buf);
    await assert.rejects(store.context(1), /对齐校验失败/);
    fx.catalog.prelabels[0].trainingEligible = true;
    await fx.writeCatalog();
    await assert.rejects(openResearchReview(fx.root), /对齐校验失败/);
});

test('only the actual offline analysis window main frame can request research data', async t => {
    const fx = await fixture(t);
    const handlers = new Map(), mainFrame = {};
    const allowed = { mainFrame };
    const ipc = { handle: (name, handler) => handlers.set(name, handler) };
    registerResearchReview(ipc, fx.configPath, () => allowed);
    const list = handlers.get('analysis:n3-research-list');
    const wave = handlers.get('analysis:n3-research-context');
    await assert.rejects(list({ sender: {}, senderFrame: mainFrame }), /仅可在离线分析窗口/);
    await assert.rejects(wave({ sender: allowed, senderFrame: {} }, 1), /仅可在离线分析窗口/);
    assert.equal((await list({ sender: allowed, senderFrame: mainFrame })).prelabels.length, 1);
    assert.equal((await wave({ sender: allowed, senderFrame: mainFrame }, 1)).selectedEpoch, 1);
    for (const name of ['analysis:n3-manual-list', 'analysis:n3-manual-save', 'analysis:n3-manual-export']) {
        await assert.rejects(handlers.get(name)({ sender: allowed, senderFrame: {} }), /仅可在离线分析窗口/);
    }
    await assert.rejects(handlers.get('analysis:n3-manual-list')({ sender: allowed, senderFrame: mainFrame }), /未配置人工标注/);
});
