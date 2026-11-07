'use strict';

// Analysis-only comparison on the EDF sample grid. No device or protocol state.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { readEdf } = require('./edf');
const { STAGES } = require('./realtime-sleep');
const { inferAll } = require('./history-replay');
const { validateSleepModelAssets, createValidatedSession } = require('./sleep-model-integrity');
const { VERSION: MVP_VERSION, buildN3Mvp } = require('./n3-mvp');

const exec = promisify(execFile);
const KEYS = ['anysleep', 'anysleepDetrended', 'yasa', 'caocao'];
const VARIANTS = { original: 'anysleep', detrended: 'anysleepDetrended' };
const EPOCH_SECONDS = 30;
const EPOCH_SAMPLES = 7500;
const SCHEMA = 2;
const stage = value => STAGES.includes(value) ? value : null;

function n3Comparison(rows, anysleepKey) {
    const keys = [anysleepKey, 'yasa', 'caocao'];
    const commonN3Counts = Object.fromEntries(keys.map(key => [key, 0]));
    const n3Patterns = {};
    const intervals = [];
    let commonEpochs = 0, allAgree = 0, allN3 = 0, n3Disagreements = 0;
    for (const row of rows) {
        if (!keys.every(key => row[key])) continue;
        commonEpochs += 1;
        if (keys.every(key => row[key] === row[anysleepKey])) allAgree += 1;
        const n3Models = keys.filter(key => row[key] === 'N3');
        for (const key of n3Models) commonN3Counts[key] += 1;
        if (n3Models.length === keys.length) allN3 += 1;
        if (n3Models.length === 0 || n3Models.length === keys.length) continue;
        n3Disagreements += 1;
        const pattern = n3Models.join('+');
        n3Patterns[pattern] = (n3Patterns[pattern] || 0) + 1;
        const previous = intervals.at(-1);
        if (previous?.endSec === row.startSec && previous.pattern === pattern) {
            previous.endSec = row.endSec;
            previous.epochs += 1;
        } else {
            intervals.push({ startSec: row.startSec, endSec: row.endSec, epochs: 1, pattern, n3Models });
        }
    }
    return { commonEpochs, commonN3Counts, allAgree, allN3, n3Disagreements, n3Patterns, intervals };
}

function alignStages(offline, predictions) {
    const count = offline.epochCount;
    if (!Number.isSafeInteger(count) || count < 1
        || KEYS.slice(0, -1).some(key => !Array.isArray(offline[key]) || offline[key].length !== count)) {
        throw new Error('离线输出的 30 秒片段数不一致');
    }
    const centerByEpoch = new Map();
    for (const row of predictions) {
        if (!Number.isInteger(row.epochIndex) || row.epochIndex < 0 || row.epochIndex >= count || centerByEpoch.has(row.epochIndex)) {
            throw new Error('曹操中心回放的片段号无效或重复');
        }
        centerByEpoch.set(row.epochIndex, row);
    }

    const available = Object.fromEntries(KEYS.map(key => [key, 0]));
    const stageCounts = Object.fromEntries(KEYS.map(key => [key, Object.fromEntries(STAGES.map(label => [label, 0]))]));
    const rows = [];
    for (let index = 0; index < count; index += 1) {
        const center = centerByEpoch.get(index);
        const row = {
            epochIndex: index,
            startSec: index * EPOCH_SECONDS,
            endSec: (index + 1) * EPOCH_SECONDS,
            anysleep: stage(offline.anysleep[index]),
            anysleepDetrended: stage(offline.anysleepDetrended[index]),
            yasa: stage(offline.yasa[index]),
            caocao: center?.quality?.ok === true ? stage(center.stage) : null,
            caocaoCandidate: stage(center?.modelStage),
            caocaoQuality: center?.quality?.reason || 'center_context_edge',
            anysleepN3Probability: offline.anysleepN3Probability?.[index] ?? null,
            anysleepDetrendedN3Probability: offline.anysleepDetrendedN3Probability?.[index] ?? null,
            caocaoN3Probability: center?.probabilities?.[3] ?? null,
        };
        for (const key of KEYS) {
            if (row[key]) {
                available[key] += 1;
                stageCounts[key][row[key]] += 1;
            }
        }
        rows.push(row);
    }
    return {
        rows,
        comparisons: Object.fromEntries(Object.entries(VARIANTS).map(([name, key]) => [name, n3Comparison(rows, key)])),
        stats: { epochCount: count, available, stageCounts, centerOutputs: centerByEpoch.size },
    };
}

async function readSidecar(file) {
    const result = { rows: null, gapEvents: null, missingSamples: null, startedAt: null, endedAt: null };
    let content;
    try { content = await fsp.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return result; throw error; }
    result.gapEvents = 0;
    result.missingSamples = 0;
    for (const line of content.split(/\r?\n/)) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.action === 'eeg_seq_gap') {
            result.gapEvents += 1;
            result.missingSamples += Math.max(0, Number(event.gapSamples) || 0);
        } else if (event.action === 'session_started') {
            result.startedAt = event.ts || null;
        } else if (event.action === 'session_stopped') {
            if (Number.isSafeInteger(event.rows) && event.rows > 0) result.rows = event.rows;
            result.endedAt = event.ts || null;
        }
    }
    return result;
}

function lastJson(text) {
    for (const line of String(text || '').trim().split(/\r?\n/).reverse()) {
        try { return JSON.parse(line); } catch { /* Python can print dependency messages first. */ }
    }
    return null;
}

async function runOfflinePython(options, script, args, cache, label) {
    try {
        const { stdout } = await exec(options.python, ['-B', path.join(options.rootDir, 'python', script), ...args], {
            windowsHide: true, encoding: 'utf8', timeout: 900000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, TEMP: cache, TMP: cache, TMPDIR: cache, NUMBA_CACHE_DIR: path.join(cache, 'numba') },
        });
        const result = lastJson(stdout);
        if (!result?.ok) throw new Error('未返回有效结果');
        return result;
    } catch (error) {
        const reason = lastJson(error.stdout)?.error || error.stderr?.trim().slice(-1600) || error.message;
        throw new Error(label + '失败：' + reason);
    }
}

function scorePython(options, source, channel, samples, cache) {
    return runOfflinePython(options, 'anysleep_offline_staging.py', ['--edf', source, '--channel', channel,
        '--samples', String(samples), '--assets-dir', options.assetsDir], cache, 'AnySleep / YASA 离线分期');
}

const csvValue = value => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};
const csv = (rows, keys) => '\ufeff' + [
    keys.join(','), ...rows.map(row => keys.map(key => csvValue(row[key])).join(',')),
].join('\r\n') + '\r\n';

async function writeAtomic(file, content) {
    const pending = file + '.' + randomUUID() + '.tmp';
    await fsp.writeFile(pending, content, 'utf8');
    try { await fsp.rename(pending, file); }
    finally { await fsp.rm(pending, { force: true }); }
}

async function attachN3Mvp(result, options, edfPath, outputRoot, cache, before, force, progress) {
    try {
        const { source, rows, preprocessing } = result;
        const fingerprint = createHash('sha256')
            .update(JSON.stringify({ source: source.sha256, rows, clipUv: preprocessing.detrended.clipUv })).digest('hex');
        const output = path.join(path.resolve(outputRoot), 'n3-mvp-v' + MVP_VERSION,
            source.sha256.slice(0, 16) + '-' + source.samples);
        const files = { json: path.join(output, 'n3_mvp.json'), csv: path.join(output, 'n3_mvp_epochs.csv') };
        if (!force) {
            let saved;
            try { saved = JSON.parse(await fsp.readFile(files.json, 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
            if (saved?.version === MVP_VERSION && saved.offlineOnly === true && saved.fingerprint === fingerprint
                && saved.rows?.length === rows.length && saved.counts && saved.settings && saved.screen) {
                return { ...result, n3Mvp: { ...saved, files } };
            }
        }
        progress('提取 N3 慢波证据和信号质量（离线）');
        await fsp.mkdir(cache, { recursive: true });
        const evidence = await runOfflinePython(options, 'n3_evidence.py', ['--edf', edfPath, '--channel', source.channel,
            '--samples', String(source.samples), '--sha256', source.sha256,
            '--clip-uv', String(preprocessing.detrended.clipUv)], cache, 'N3 慢波证据计算');
        const after = await fsp.stat(edfPath);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('分析期间 EDF 已变化');
        const mvp = { ...buildN3Mvp(rows, evidence), fingerprint, sourceSha256: source.sha256, files };
        await fsp.mkdir(output, { recursive: true });
        const table = mvp.rows.map(row => ({ ...row, reasons: row.reasons.join('|'), warnings: row.warnings.join('|') }));
        await writeAtomic(files.csv, csv(table, Object.keys(table[0])));
        await writeAtomic(files.json, JSON.stringify(mvp, null, 2));
        return { ...result, n3Mvp: mvp };
    } catch (error) {
        return { ...result, n3MvpError: error.message };
    }
}

async function compareEdf(input, progress = () => {}) {
    const rootDir = path.resolve(input.rootDir || path.join(__dirname, '..'));
    const edfPath = await fsp.realpath(input.edfPath);
    if (path.extname(edfPath).toLowerCase() !== '.edf') throw new Error('请选择已保存的 EDF 文件');
    const before = await fsp.stat(edfPath);
    if (!before.isFile()) throw new Error('找不到已保存的 EDF 文件');
    const edf = await readEdf(edfPath);
    const channel = edf.labels[0];
    if (edf.labels.length !== 1 || !/^(?:EEG)?CH2$/i.test(channel?.replace(/\s/g, '') || '') || edf.sampleRateHz !== 250) {
        throw new Error('离线对照当前支持曹操的单导 CH2 · 250 Hz EDF');
    }
    const sidecar = await readSidecar(input.eventsPath || edfPath.replace(/\.edf$/i, '.events.jsonl'));
    const recordedRows = input.rows ?? sidecar.rows ?? edf.values.length;
    if (!Number.isSafeInteger(recordedRows) || recordedRows > edf.values.length || recordedRows <= 0) {
        throw new Error('记录样本数与 EDF 文件不一致');
    }
    const samples = Math.floor(recordedRows / EPOCH_SAMPLES) * EPOCH_SAMPLES;
    if (samples < EPOCH_SAMPLES) throw new Error('EDF 有效数据不足 30 秒');

    const sha256 = createHash('sha256').update(await fsp.readFile(edfPath)).digest('hex');
    // Keep earlier three-track results intact and never reuse them for four tracks.
    const outputDir = path.join(path.resolve(input.outputRoot), 'v' + SCHEMA, sha256.slice(0, 16) + '-' + samples);
    const files = {
        json: path.join(outputDir, 'comparison.json'),
        epochsCsv: path.join(outputDir, 'epochs.csv'),
        n3Csv: path.join(outputDir, 'n3_disagreements.csv'),
    };
    const audit = validateSleepModelAssets({ rootDir });
    const caocaoId = audit.metadataSummary.sourceExperimentId;
    const cache = path.join(path.resolve(input.outputRoot), '.runtime-cache');
    const options = {
        rootDir, python: input.python || (process.platform === 'win32' ? 'python.exe' : 'python3'),
        assetsDir: input.assetsDir || path.join(rootDir, 'python', 'anysleep-assets'),
    };
    const withMvp = result => attachN3Mvp(result, options, edfPath, input.outputRoot, cache, before, input.force, progress);
    if (!input.force) {
        let saved;
        try { saved = JSON.parse(await fsp.readFile(files.json, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (saved?.schema === SCHEMA && saved.source?.sha256 === sha256
            && saved.source?.samples === samples && saved.models?.caocaoId === caocaoId
            && saved.rows?.length === samples / EPOCH_SAMPLES && saved.comparisons?.detrended
            && saved.preprocessing?.detrended?.highpassHz === 0.3) {
            return withMvp({ ...saved, cached: true });
        }
    }

    await fsp.mkdir(cache, { recursive: true });
    progress('运行 AnySleep 原流程、0.3 Hz 去漂移版及 YASA（本机 CPU）');
    const offline = await scorePython(options, edfPath, channel, samples, cache);
    if (offline.epochCount !== samples / EPOCH_SAMPLES) throw new Error('Python 与 EDF 的片段数不一致');

    progress('回放曹操中心分期');
    const ort = require('onnxruntime-node');
    const { session } = await createValidatedSession({ rootDir }, file => ort.InferenceSession.create(file, {
        executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 1,
    }));
    let replay;
    try {
        replay = await inferAll({ values: edf.values.subarray(0, samples), rate: 250 }, session, ort,
            info => progress('曹操已回放 ' + info.epochs + ' 段'), () => false, 'center');
    } finally {
        await session.release();
    }
    const after = await fsp.stat(edfPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('分析期间 EDF 已变化，请重新运行');
    const aligned = alignStages(offline, replay.predictions);
    const result = {
        schema: SCHEMA, epochSeconds: EPOCH_SECONDS, files,
        source: { name: path.basename(edfPath), sha256, channel, sampleRateHz: 250, recordedRows,
            samples, discardedTailSamples: recordedRows - samples, timing: 'edf_sample_grid', ...sidecar },
        preprocessing: offline.preprocessing,
        models: { ...offline.models, caocaoId, caocaoHashes: audit.actualHashes, caocaoMode: 'v0.6.0_center_replay' },
        ...aligned,
    };
    await fsp.mkdir(outputDir, { recursive: true });
    await writeAtomic(files.epochsCsv, csv(result.rows, Object.keys(result.rows[0])));
    const intervals = Object.entries(result.comparisons).flatMap(([variant, report]) =>
        report.intervals.map(interval => ({ ...interval, variant })));
    await writeAtomic(files.n3Csv, csv(intervals, ['variant', 'startSec', 'endSec', 'epochs', 'pattern']));
    await writeAtomic(files.json, JSON.stringify(result, null, 2));
    return withMvp(result);
}

if (!isMainThread) {
    compareEdf(workerData, text => parentPort.postMessage({ progress: text })).then(
        result => parentPort.postMessage({ result }),
        error => parentPort.postMessage({ error: error.message }),
    );
}

module.exports = { alignStages, compareEdf, csv };
