'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LABELS = Object.freeze({
    suspected_n3: '疑似 N3',
    not_n3: '非 N3',
    uncertain: '不确定',
    artifact: '伪迹',
});
const validLabel = label => typeof label === 'string' && Object.hasOwn(LABELS, label);
const validNote = note => typeof note === 'string' && note.length <= 2000;
const filename = row => row.edfSha256 + '-' + row.epochIndex + '.json';

function csvCell(value) {
    const text = String(value);
    // Keep remarks literal in spreadsheets. The saved JSON retains the exact text.
    const literal = /^\s*[=+\-@＝＋－＠]|^[\t\r\n]/u.test(text) ? "'" + text : text;
    return '"' + literal.replaceAll('"', '""') + '"';
}

function createManualAnnotations(directory, identities) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
        throw new Error('本机未配置人工标注保存位置。');
    }
    const byRank = new Map(identities.map(row => [row.rank, row]));

    async function read(row) {
        const text = await fs.readFile(path.join(directory, filename(row)), 'utf8').catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (text === null) return null;
        let entry;
        try { entry = JSON.parse(text); } catch { /* validated below */ }
        if (entry?.schema !== 1 || entry.edfSha256 !== row.edfSha256 || entry.epochIndex !== row.epochIndex
            || !validLabel(entry.label) || !validNote(entry.note)
            || typeof entry.savedAt !== 'string' || !Number.isFinite(Date.parse(entry.savedAt))) {
            throw new Error('第 ' + row.rank + ' 名的人工标注文件无法识别，已保留原文件。');
        }
        return { rank: row.rank, label: entry.label, note: entry.note, savedAt: entry.savedAt };
    }

    async function list() {
        const names = new Set(await fs.readdir(directory).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        }));
        const items = (await Promise.all(identities.filter(row => names.has(filename(row))).map(read))).filter(Boolean);
        const latest = items.reduce((last, item) =>
            last === null || Date.parse(item.savedAt) > Date.parse(last.savedAt) ? item : last, null);
        return { items, lastRank: latest?.rank ?? null };
    }

    async function save(rank, label, note) {
        const row = byRank.get(rank);
        if (!row) throw new Error('片段不在本地复核队列中。');
        if (!validLabel(label) || !validNote(note)) throw new Error('请选择人工标注类别；备注最多 2000 字符。');
        await read(row); // Never silently overwrite an unreadable annotation.
        const savedAt = new Date().toISOString();
        const entry = { schema: 1, edfSha256: row.edfSha256, epochIndex: row.epochIndex, label, note, savedAt };
        await fs.mkdir(directory, { recursive: true });
        const target = path.join(directory, filename(row));
        const pending = target + '.' + randomUUID() + '.tmp';
        // Replace one epoch atomically, without modifying other epochs or the review catalog.
        const file = await fs.open(pending, 'wx');
        try {
            try {
                await file.writeFile(JSON.stringify(entry, null, 2) + '\n', 'utf8');
            } finally {
                await file.close();
            }
            await fs.rename(pending, target);
        } catch (error) {
            await fs.rm(pending, { force: true }).catch(() => {});
            throw error;
        }
        return { rank, label, note, savedAt };
    }

    async function exportCsv(chooseFile) {
        const { items } = await list();
        if (!items.length) throw new Error('还没有已保存的人工标注。');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const { canceled, filePath } = await chooseFile(path.join(path.dirname(directory), 'caocao-n3-manual-' + stamp + '.csv'));
        if (canceled) return { canceled: true };
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.csv') {
            throw new Error('请选择一个 CSV 文件名。');
        }
        const rows = [['记录', '记录日期', 'EDF SHA-256', '片段序号（从 0 开始）',
            'EDF 起点（秒）', 'EDF 终点（秒）', '人工标注', '备注', '保存时间（UTC）']];
        for (const item of items) {
            const row = byRank.get(item.rank);
            rows.push([row.record, row.date, row.edfSha256, row.epochIndex, row.startSec, row.endSec,
                LABELS[item.label], item.note, item.savedAt]);
        }
        const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
        await fs.writeFile(filePath, csv, { encoding: 'utf8', flag: 'wx' }).catch(error => {
            if (error.code === 'EEXIST') throw new Error('该文件已存在，请换一个文件名。');
            throw error;
        });
        return { canceled: false, count: items.length, fileName: path.basename(filePath) };
    }

    return { list, save, exportCsv };
}

module.exports = { createManualAnnotations };
