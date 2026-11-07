'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createManualAnnotations } = require('../src/n3-manual-annotations');

const identities = [
    { rank: 1, record: 'R01', date: '2026-01-01', edfSha256: 'a'.repeat(64), epochIndex: 12, startSec: 360, endSec: 390 },
    { rank: 2, record: 'R02', date: '2026-01-02', edfSha256: 'b'.repeat(64), epochIndex: 12, startSec: 360, endSec: 390 },
];
const note = '见慢波, “复核”："继续"\n第二行';
const entryPath = (directory, row) => path.join(directory, row.edfSha256 + '-' + row.epochIndex + '.json');

async function fixture(t) {
    const temp = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(temp, 'caocao-manual-'));
    const directory = path.join(root, 'annotations'), csv = path.join(root, 'manual.csv');
    t.after(async () => {
        const exact = await fs.realpath(root);
        assert.equal(path.dirname(exact), temp);
        await fs.rm(exact, { recursive: true });
    });
    return { directory, csv, store: createManualAnnotations(directory, identities) };
}

test('manual notes survive reopening and follow EDF + epoch, not the current queue rank', async t => {
    const { directory, store } = await fixture(t);
    assert.deepEqual(await store.list(), { items: [], lastRank: null });
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    const first = await store.save(1, 'suspected_n3', note);
    const reordered = identities.map(row => ({ ...row, rank: 3 - row.rank, record: row.rank === 1 ? 'R09' : 'R02' }));
    const reopened = createManualAnnotations(directory, reordered);
    assert.deepEqual(await reopened.list(), { items: [{ ...first, rank: 2 }], lastRank: 2 });
    const raw = JSON.parse(await fs.readFile(entryPath(directory, identities[0]), 'utf8'));
    assert.deepEqual(Object.keys(raw), ['schema', 'edfSha256', 'epochIndex', 'label', 'note', 'savedAt']);
    assert.equal(raw.note, note);
    assert.equal(raw.edfSha256, identities[0].edfSha256);
});

test('edits replace only one annotation; recordings sharing an epoch index stay separate', async t => {
    const { directory, store } = await fixture(t);
    await Promise.all([store.save(1, 'uncertain', '不确定'), store.save(2, 'not_n3', '')]);
    await store.save(1, 'artifact', '标为伪迹');
    const reopened = createManualAnnotations(directory, identities);
    assert.deepEqual((await reopened.list()).items.map(({ rank, label, note: text }) => [rank, label, text]),
        [[1, 'artifact', '标为伪迹'], [2, 'not_n3', '']]);
    assert.equal((await fs.readdir(directory)).length, 2);
});

test('invalid inputs cannot write; an unreadable annotation is not silently replaced', async t => {
    const { directory, store } = await fixture(t);
    for (const rank of [0, 3, '1', { file: 'not-a-rank' }]) {
        await assert.rejects(store.save(rank, 'uncertain', ''), /不在本地复核队列/);
    }
    await assert.rejects(store.save(1, 'N3', ''), /人工标注类别/);
    await assert.rejects(store.save(1, 'artifact', '测'.repeat(2001)), /2000/);
    await assert.rejects(fs.access(directory), { code: 'ENOENT' });
    await store.save(1, 'artifact', 'reviewed');
    const file = entryPath(directory, identities[0]);
    await fs.writeFile(file, '{"unreadable":true}');
    await assert.rejects(store.save(1, 'not_n3', ''), /已保留原文件/);
    await assert.rejects(store.list(), /已保留原文件/);
    assert.equal(await fs.readFile(file, 'utf8'), '{"unreadable":true}');
});

test('CSV contains only saved manual labels; handles Chinese, multiline notes and formula text', async t => {
    const { csv, store } = await fixture(t);
    await assert.rejects(store.exportCsv(() => assert.fail('Dialog should not open with no entries')), /还没有已保存/);
    await store.save(1, 'suspected_n3', note);
    await store.save(2, 'uncertain', ' =1+2');
    assert.deepEqual(await store.exportCsv(defaultPath => {
        assert.equal(path.dirname(defaultPath), path.dirname(csv));
        return { canceled: true };
    }), { canceled: true });
    await assert.rejects(fs.access(csv), { code: 'ENOENT' });
    const choose = () => ({ canceled: false, filePath: csv });
    assert.deepEqual(await store.exportCsv(choose), { canceled: false, count: 2, fileName: 'manual.csv' });
    const bytes = await fs.readFile(csv), text = bytes.toString('utf8');
    assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.ok(text.includes('"EDF SHA-256","片段序号（从 0 开始）","EDF 起点（秒）","EDF 终点（秒）","人工标注"'));
    assert.ok(text.includes('"360","390","疑似 N3","见慢波, “复核”：""继续""\n第二行"'));
    assert.ok(text.includes('"不确定","\' =1+2"'));
    assert.doesNotMatch(text, /预标注|自动候选|AnySleep/);
    await assert.rejects(store.exportCsv(choose), /文件已存在/);
    assert.equal(await fs.readFile(csv, 'utf8'), text);
    assert.equal((await store.list()).items[1].note, ' =1+2');
});
