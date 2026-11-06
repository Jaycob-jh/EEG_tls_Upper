'use strict';

// Read-only view of the review batch, with a separate manual annotation store.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createManualAnnotations } = require('./n3-manual-annotations');

const CHANNELS = ['raw', 'highpass', 'slow'];
const RATE = 250;
const SECONDS = 30;
const POINTS = RATE * SECONDS;
const BLOCK_BYTES = CHANNELS.length * POINTS * 4;
const STAGES = new Set([null, 'W', 'N1', 'N2', 'N3', 'REM']);
const FLAGS = new Set(['drift_dominant', 'input_clipped']);
const FAILS = new Set(['slow_lt_6s', 'anysleep_hp_not_n3', 'no_yasa_or_caocao_n3', 'quality_warning']);
const LABELS = new Set(['N3_like_low_confidence', 'N3_like_conditional_drift']);
const STATUSES = new Set(['review', 'no_alert', 'insufficient', 'candidate']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validNumber = (value, max) => Number.isFinite(value) && value >= 0 && value <= max;

function check(condition) {
    if (!condition) throw new Error('N3 本地复核目录不完整，或片段对齐校验失败。');
}

function checkedEpoch(epoch, count) {
    const { epochIndex, startSec, endSec, anysleepDetrended, yasa, caocao, strictSlowSeconds,
        rawDriftPercent, inputClippedPercent, warnings, status, slowMarks } = epoch;
    check(Number.isSafeInteger(epochIndex) && epochIndex >= 0 && epochIndex < count
        && startSec === epochIndex * SECONDS && endSec === startSec + SECONDS
        && [anysleepDetrended, yasa, caocao].every(stage => STAGES.has(stage))
        && validNumber(strictSlowSeconds, SECONDS)
        && (rawDriftPercent === null || validNumber(rawDriftPercent, 100.00001))
        && validNumber(inputClippedPercent, 100)
        && Array.isArray(warnings) && warnings.every(flag => FLAGS.has(flag))
        && STATUSES.has(status) && Array.isArray(slowMarks));
    let previous = 0, samples = 0;
    for (const mark of slowMarks) {
        check(Array.isArray(mark) && mark.length === 2 && mark.every(Number.isSafeInteger));
        const [lo, hi] = mark;
        check(lo >= previous && lo < hi && hi <= POINTS);
        previous = hi;
        samples += hi - lo;
    }
    check(Math.abs(samples / RATE - strictSlowSeconds) < 1e-8);
    return { epochIndex, startSec, endSec, anysleepDetrended, yasa, caocao, strictSlowSeconds,
        rawDriftPercent, inputClippedPercent, warnings, status, slowMarks };
}

function contextIndices(index, count) {
    return [index - 1, index, index + 1].filter(value => value >= 0 && value < count);
}

async function openResearchReview(root) {
    check(typeof root === 'string' && path.isAbsolute(root));
    const source = JSON.parse(await fs.readFile(path.join(root, 'catalog.json'), 'utf8'));
    check(source.schema === 1 && source.reviewOnly === true && source.rateHz === RATE && source.epochSeconds === SECONDS
        && JSON.stringify(source.tracks) === JSON.stringify(CHANNELS)
        && Array.isArray(source.records) && Array.isArray(source.ranked) && Array.isArray(source.prelabels));
    const records = new Map();
    for (const entry of source.records) {
        const { id, date, edfSha256, waveformSha256, epochCount, epochs } = entry;
        check(typeof id === 'string' && /^R\d{2}$/.test(id) && !records.has(id)
            && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && hash(edfSha256) && hash(waveformSha256)
            && Number.isSafeInteger(epochCount) && epochCount > 0 && Array.isArray(epochs) && epochs.length <= epochCount);
        const byEpoch = new Map();
        epochs.forEach((row, slot) => {
            const meta = checkedEpoch(row, epochCount);
            check(!byEpoch.has(meta.epochIndex));
            byEpoch.set(meta.epochIndex, { meta, slot });
        });
        records.set(id, { id, date, edfSha256, epochCount, byEpoch, waveformSha256, queueCount: 0 });
    }
    const selectedKeys = new Set();
    const ranked = source.ranked.map((row, order) => {
        const record = records.get(row.record);
        const selected = record?.byEpoch.get(row.epochIndex)?.meta;
        const key = row.record + ':' + row.epochIndex;
        check(row.rank === order + 1 && selected?.status === 'review' && !selectedKeys.has(key)
            && Array.isArray(row.fails) && row.fails.length > 0 && row.fails.every(item => FAILS.has(item))
            && row.modelVotes === [selected.anysleepDetrended, selected.yasa, selected.caocao].filter(item => item === 'N3').length
            && contextIndices(row.epochIndex, record.epochCount).every(index => record.byEpoch.has(index)));
        selectedKeys.add(key);
        record.queueCount += 1;
        const { slowMarks: _marks, ...summary } = selected;
        return { ...summary, rank: row.rank, record: record.id, date: record.date, fails: row.fails, modelVotes: row.modelVotes };
    });
    const labelRanks = new Set();
    const prelabels = source.prelabels.map((row, order) => {
        const selected = ranked[row.rank - 1];
        check(Number.isSafeInteger(row.rank) && selected && !labelRanks.has(row.rank) && row.priority === order + 1
            && row.trainingEligible === false && LABELS.has(row.label) && typeof row.note === 'string' && row.note.length <= 1500);
        labelRanks.add(row.rank);
        return { ...selected, priority: row.priority, label: row.label, note: row.note, trainingEligible: false };
    });

    async function waveformBuffer(record) {
        if (!record.buffer) {
            record.buffer = fs.readFile(path.join(root, record.id + '.f32')).then(data => {
                check(data.length === record.byEpoch.size * BLOCK_BYTES
                    && createHash('sha256').update(data).digest('hex') === record.waveformSha256);
                return data;
            }).catch(error => {
                record.buffer = null;
                throw error;
            });
        }
        return record.buffer;
    }

    return {
        list() {
            return { reviewOnly: true, ranked, prelabels,
                records: [...records.values()].map(({ id, date, queueCount }) => ({ id, date, queueCount })) };
        },
        manualIdentities() {
            return ranked.map(({ rank, record, date, epochIndex, startSec, endSec }) => ({
                rank, record, date, epochIndex, startSec, endSec, edfSha256: records.get(record).edfSha256,
            }));
        },
        async context(rank) {
            if (!Number.isSafeInteger(rank) || rank < 1 || rank > ranked.length) throw new Error('片段不在本地复核队列中。');
            const selected = ranked[rank - 1];
            const record = records.get(selected.record);
            const data = await waveformBuffer(record);
            const epochs = contextIndices(selected.epochIndex, record.epochCount).map(index => {
                const { meta, slot } = record.byEpoch.get(index);
                const tracks = Object.fromEntries(CHANNELS.map((name, track) => {
                    const values = new Float32Array(POINTS);
                    const start = slot * BLOCK_BYTES + track * POINTS * 4;
                    for (let i = 0; i < POINTS; i++) values[i] = data.readFloatLE(start + i * 4);
                    return [name, values];
                }));
                return { ...meta, tracks, relative: index - selected.epochIndex };
            });
            return { reviewOnly: true, rank, record: selected.record, date: selected.date,
                selectedEpoch: selected.epochIndex, rateHz: RATE, epochSeconds: SECONDS, epochs };
        },
    };
}

function chooseAnnotationCsv(sender, defaultPath) {
    const { BrowserWindow, dialog } = require('electron');
    return dialog.showSaveDialog(BrowserWindow.fromWebContents(sender), {
        title: '导出人工标注 CSV',
        defaultPath,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
}

function registerResearchReview(ipc, configPath, analysisContents, chooseCsv = chooseAnnotationCsv) {
    let service, manual;
    const load = async () => {
        if (!service) {
            service = fs.readFile(configPath, 'utf8')
                .then(async text => {
                    const { catalogDir, annotationDir } = JSON.parse(text);
                    return { review: await openResearchReview(catalogDir), annotationDir };
                }, error => {
                    if (error.code === 'ENOENT') return null;
                    throw error;
                }).catch(error => {
                    service = null;
                    throw error;
                });
        }
        return service;
    };
    const manualStore = async () => {
        const ready = await load();
        if (!ready) throw new Error('未配置本机研究复核批次。');
        manual ??= createManualAnnotations(ready.annotationDir, ready.review.manualIdentities());
        return manual;
    };
    const authorize = event => {
        const allowed = analysisContents();
        if (!allowed || event.sender !== allowed || event.senderFrame !== allowed.mainFrame) {
            throw new Error('N3 研究复核仅可在离线分析窗口使用。');
        }
    };
    ipc.handle('analysis:n3-research-list', async event => {
        authorize(event);
        return (await load())?.review.list() ?? null;
    });
    ipc.handle('analysis:n3-research-context', async (event, rank) => {
        authorize(event);
        const ready = await load();
        if (!ready) throw new Error('未配置本机研究复核批次。');
        return ready.review.context(rank);
    });
    ipc.handle('analysis:n3-manual-list', async event => {
        authorize(event);
        return (await manualStore()).list();
    });
    ipc.handle('analysis:n3-manual-save', async (event, rank, label, note) => {
        authorize(event);
        return (await manualStore()).save(rank, label, note);
    });
    ipc.handle('analysis:n3-manual-export', async event => {
        authorize(event);
        return (await manualStore()).exportCsv(defaultPath => chooseCsv(event.sender, defaultPath));
    });
}

module.exports = { openResearchReview, registerResearchReview };
