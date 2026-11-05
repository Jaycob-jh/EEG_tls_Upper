'use strict';

/**
 * Audit the Cao Cao EEG amplitude gate across finalized EDF sessions.
 *
 * The live quality decision is made on the training-filtered model input,
 * not on the raw EDF value. This script replays that filter, summarizes
 * epoch-level distributions, and evaluates an offline 50%~95% N3 probability
 * grid. It never changes EDF/session files and does not claim classification
 * accuracy without independent PSG/AASM labels.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Storage = require('../src/storage-paths');
const APP_VERSION = require('../package.json').version;

function parseArgs(argv) {
    const output = {};
    for (let index = 0; index < argv.length; index++) {
        const item = argv[index];
        if (!item.startsWith('--')) continue;
        const key = item.slice(2);
        output[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    }
    return output;
}

function argValue(args, key, fallback) {
    return args[key] === undefined || args[key] === true ? fallback : String(args[key]);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function numericValues(values) {
    return Array.from(values || [], Number).filter(Number.isFinite);
}

function mean(values) {
    const numbers = numericValues(values);
    return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function standardDeviation(values) {
    const numbers = numericValues(values);
    if (numbers.length < 2) return numbers.length ? 0 : null;
    const average = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    return Math.sqrt(numbers.reduce((sum, value) => sum + (value - average) ** 2, 0) / (numbers.length - 1));
}

function quantile(sorted, probability) {
    if (!sorted.length) return null;
    const position = Math.min(1, Math.max(0, probability)) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(sorted.length - 1, lower + 1);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function stats(values) {
    const sorted = numericValues(values).sort((left, right) => left - right);
    if (!sorted.length) {
        return { n: 0, min: null, p01: null, p05: null, p25: null, median: null, p75: null, p90: null, p95: null, p99: null, max: null, mean: null, sd: null };
    }
    return {
        n: sorted.length,
        min: sorted[0],
        p01: quantile(sorted, 0.01),
        p05: quantile(sorted, 0.05),
        p25: quantile(sorted, 0.25),
        median: quantile(sorted, 0.5),
        p75: quantile(sorted, 0.75),
        p90: quantile(sorted, 0.9),
        p95: quantile(sorted, 0.95),
        p99: quantile(sorted, 0.99),
        max: sorted[sorted.length - 1],
        mean: mean(sorted),
        sd: standardDeviation(sorted),
    };
}

function signalStats(values) {
    const numbers = numericValues(values);
    const absolute = numbers.map(value => Math.abs(value));
    return {
        meanUv: mean(numbers),
        stdUv: standardDeviation(numbers),
        medianUv: quantile(numbers.slice().sort((a, b) => a - b), 0.5),
        p01Uv: quantile(numbers.slice().sort((a, b) => a - b), 0.01),
        p99Uv: quantile(numbers.slice().sort((a, b) => a - b), 0.99),
        maxAbsUv: absolute.length ? Math.max(...absolute) : null,
    };
}

function countBy(values) {
    return values.reduce((counts, value) => {
        const key = value === null || value === undefined || value === '' ? '(missing)' : String(value);
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
}

function buildLightIntervals(events, sessionStart, sessionEnd) {
    const startMs = Date.parse(sessionStart || '');
    const endMs = Date.parse(sessionEnd || '') || Date.now();
    const open = new Map();
    const intervals = [];
    for (const event of events) {
        const channel = Number(event.channel || event.lightChannel);
        const eventMs = Date.parse(event.ts || '');
        if (![1, 2].includes(channel) || !Number.isFinite(eventMs)) continue;
        if (event.action === 'light_started') open.set(channel, { channel, startMs: eventMs });
        if (event.action === 'light_stopped' && open.has(channel)) {
            const current = open.get(channel);
            intervals.push({ channel, startMs: current.startMs, endMs: Math.max(current.startMs, eventMs) });
            open.delete(channel);
        }
    }
    for (const current of open.values()) intervals.push({ channel: current.channel, startMs: current.startMs, endMs: Math.max(current.startMs, endMs) });
    return intervals
        .map(interval => ({
            channel: interval.channel,
            startSec: Number.isFinite(startMs) ? Math.max(0, (interval.startMs - startMs) / 1000) : null,
            endSec: Number.isFinite(startMs) ? Math.max(0, (interval.endMs - startMs) / 1000) : null,
        }))
        .filter(interval => interval.startSec !== null && interval.endSec > interval.startSec);
}

function overlapSeconds(startSec, endSec, intervals) {
    return intervals.reduce((total, interval) => total
        + Math.max(0, Math.min(endSec, interval.endSec) - Math.max(startSec, interval.startSec)), 0);
}

function sessionDate(metadata, name) {
    const source = String(metadata.startedAt || name || '');
    return source.slice(0, 10) || 'unknown';
}

function recordMap(records) {
    return new Map(records
        .filter(record => Number.isInteger(Number(record.epochIndex)))
        .map(record => [Number(record.epochIndex), record]));
}

function eventQuality(record) {
    return record && record.quality && typeof record.quality.ok === 'boolean' ? record.quality.ok : null;
}

function n3Probability(record) {
    const fromProbabilities = Array.isArray(record?.probabilities) ? Number(record.probabilities[3]) : NaN;
    if (Number.isFinite(fromProbabilities)) return fromProbabilities;
    return finite(record?.n3Probability);
}

async function auditSession(sessionDir, modules) {
    const metadataPath = path.join(sessionDir, 'session.json');
    const edfPath = path.join(sessionDir, 'eeg_raw.edf');
    if (!fs.existsSync(metadataPath) || !fs.existsSync(edfPath)) return { skipped: true, name: path.basename(sessionDir), reason: 'missing_session_or_edf' };
    const metadata = readJson(metadataPath);
    const events = readJsonl(path.join(sessionDir, 'events.jsonl'));
    const staging = modules.History.parseSessionStagingHistory(events.map(event => JSON.stringify(event)).join('\n'));
    const canonical = modules.History.selectCanonicalStagingRecords(staging.records);
    const records = recordMap(canonical);
    const edf = await modules.readEdf(edfPath, 0);
    const sampleRateHz = Number(metadata.sampleRateHz || edf.sampleRateHz || 250);
    const receivedSamples = Math.min(Number(metadata.rows || edf.values.length), edf.values.length);
    const values = edf.values.slice(0, receivedSamples);
    const modelFilter = new modules.SDK.filters.EegFilterBank(sampleRateHz, 1, modules.SDK.filters.MODEL_TRAINING_PRESET, {
        initialization: 'zero',
        implementation: 'direct2t',
    });
    if (!modelFilter.supported) throw new Error(`无法重放模型训练滤波器：${sampleRateHz} Hz`);
    const modelFiltered = new Float64Array(values.length);
    for (let index = 0; index < values.length; index++) modelFiltered[index] = modelFilter.process(0, values[index]);
    const epochSamples = Math.round(sampleRateHz * 30);
    const fullEpochCount = Math.floor(values.length / epochSamples);
    const lightIntervals = buildLightIntervals(events, metadata.startedAt, metadata.endedAt);
    const rows = [];
    for (let epochIndex = 0; epochIndex < fullEpochCount; epochIndex++) {
        const start = epochIndex * epochSamples;
        const rawEpoch = values.subarray(start, start + epochSamples);
        const modelEpoch = modelFiltered.subarray(start, start + epochSamples);
        const ignoredLeadingSeconds = epochIndex === 0 ? 5 : 0;
        const quality = modules.Sleep.qualityMetrics(modelEpoch, {
            sampleRateHz,
            maxAbsUv: 500,
            minStdUv: 0.01,
            maxSamples: 4096,
            ignoreLeadingSeconds: ignoredLeadingSeconds,
        });
        const observedStart = Math.min(modelEpoch.length - 1, Math.floor(ignoredLeadingSeconds * sampleRateHz));
        const observedModel = modelEpoch.slice(Math.max(0, observedStart));
        const rawSummary = signalStats(rawEpoch);
        const record = records.get(epochIndex) || null;
        const lightOverlap = overlapSeconds(epochIndex * 30, (epochIndex + 1) * 30, lightIntervals);
        rows.push({
            session: path.basename(sessionDir),
            date: sessionDate(metadata, path.basename(sessionDir)),
            epochIndex,
            lightOverlapSeconds: lightOverlap,
            lightOverlapAtLeast5Seconds: lightOverlap >= 5,
            rawMeanUv: rawSummary.meanUv,
            rawStdUv: rawSummary.stdUv,
            rawMedianUv: rawSummary.medianUv,
            rawP01Uv: rawSummary.p01Uv,
            rawP99Uv: rawSummary.p99Uv,
            rawMaxAbsUv: rawSummary.maxAbsUv,
            modelMeanUv: quality.meanUv,
            modelStdUv: quality.stdUv,
            modelRmsUv: quality.rmsUv,
            modelMaxAbsUv: quality.maxAbsUv,
            modelPeakToPeakUv: quality.peakToPeakUv,
            loggedQualityOk: eventQuality(record),
            loggedQualityReason: record?.quality?.reason || null,
            stage: record?.stage || null,
            candidateStage: record?.candidateStage || record?.modelStage || null,
            n3Probability: n3Probability(record),
            inferenceMode: record?.inferenceMode || null,
        });
    }
    return {
        skipped: false,
        name: path.basename(sessionDir),
        date: sessionDate(metadata, path.basename(sessionDir)),
        startedAt: metadata.startedAt || null,
        endedAt: metadata.endedAt || null,
        status: metadata.status || null,
        sampleRateHz,
        receivedSamples,
        durationSeconds: receivedSamples / sampleRateHz,
        fullEpochCount,
        partialSamples: values.length - fullEpochCount * epochSamples,
        canonicalStagingRecords: canonical.length,
        lightIntervals,
        rows,
    };
}

function filterRows(rows, predicate) {
    return rows.filter(predicate);
}

function groupSummary(rows) {
    return {
        epochCount: rows.length,
        modelMaxAbsUv: stats(rows.map(row => row.modelMaxAbsUv)),
        modelStdUv: stats(rows.map(row => row.modelStdUv)),
        rawMaxAbsUv: stats(rows.map(row => row.rawMaxAbsUv)),
        rawMedianUv: stats(rows.map(row => row.rawMedianUv)),
        rawMeanUv: stats(rows.map(row => row.rawMeanUv)),
    };
}

function thresholdQuality(row, thresholdUv, minStdUv = 0.01) {
    return Number(row.modelMaxAbsUv) <= thresholdUv && Number(row.modelStdUv) >= minStdUv;
}

function qualityThresholdSweep(rows, thresholds) {
    return thresholds.map(thresholdUv => {
        const passRows = rows.filter(row => thresholdQuality(row, thresholdUv));
        const logged = rows.filter(row => row.loggedQualityOk !== null);
        const loggedPassRejected = logged.filter(row => row.loggedQualityOk === true && !thresholdQuality(row, thresholdUv)).length;
        const loggedRejectAdmitted = logged.filter(row => row.loggedQualityOk === false && thresholdQuality(row, thresholdUv)).length;
        return {
            thresholdUv,
            passEpochs: passRows.length,
            passPercent: rows.length ? passRows.length / rows.length : null,
            loggedEpochs: logged.length,
            loggedAgreement: logged.length ? logged.filter(row => row.loggedQualityOk === thresholdQuality(row, thresholdUv)).length / logged.length : null,
            loggedPassRejected,
            loggedRejectAdmitted,
        };
    });
}

function n3CandidateRows(rows) {
    return rows.filter(row => row.inferenceMode === 'causal'
        && row.loggedQualityOk === true
        && row.candidateStage === 'N3'
        && Number.isFinite(Number(row.n3Probability)));
}

function countConsecutiveRuns(rows, threshold, minimumLength = 2) {
    const qualified = rows.filter(row => Number(row.n3Probability) >= threshold);
    const bySession = new Map();
    for (const row of qualified) {
        if (!bySession.has(row.session)) bySession.set(row.session, []);
        bySession.get(row.session).push(row);
    }
    let runs = 0;
    let triggerableEpochs = 0;
    for (const sessionRows of bySession.values()) {
        sessionRows.sort((left, right) => left.epochIndex - right.epochIndex);
        let length = 0;
        let previous = null;
        const flush = () => {
            if (length >= minimumLength) {
                runs++;
                triggerableEpochs += length - minimumLength + 1;
            }
            length = 0;
        };
        for (const row of sessionRows) {
            if (previous !== null && row.epochIndex !== previous + 1) flush();
            length++;
            previous = row.epochIndex;
        }
        flush();
    }
    return { runs, triggerableEpochs };
}

function n3ProbabilitySweep(rows) {
    const candidates = n3CandidateRows(rows);
    const denominator = rows.filter(row => row.inferenceMode === 'causal' && row.loggedQualityOk === true).length;
    return Array.from({ length: 10 }, (_, index) => 0.5 + index * 0.05).map(threshold => {
        const hits = candidates.filter(row => row.n3Probability >= threshold).length;
        const runs = countConsecutiveRuns(candidates, threshold, 2);
        return {
            threshold: Number(threshold.toFixed(2)),
            candidateHits: hits,
            candidateRateAmongCausalQualityPass: denominator ? hits / denominator : null,
            consecutiveRunsAtLeast2: runs.runs,
            triggerableEpochStartsBeforeCooldown: runs.triggerableEpochs,
        };
    });
}

function percent(value, digits = 1) {
    return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : '--';
}

function number(value, digits = 1) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--';
}

function markdownSummary(label, summary) {
    return `| ${label} | ${summary.epochCount} | ${number(summary.modelMaxAbsUv.median)} | ${number(summary.modelMaxAbsUv.p95)} | ${number(summary.modelMaxAbsUv.p99)} | ${number(summary.modelMaxAbsUv.mean)} | ${number(summary.modelMaxAbsUv.max)} |`;
}

function buildMarkdown(result) {
    const { sessions, allRows, groups, qualitySweep, n3Sweep, currentThresholdUv } = result;
    const current = qualitySweep.find(row => row.thresholdUv === currentThresholdUv);
    const loggedPass = groups.loggedQualityPass;
    const loggedReject = groups.loggedQualityReject;
    const cleanP99 = loggedPass.modelMaxAbsUv.p99;
    const rejectP05 = loggedReject.modelMaxAbsUv.p05;
    const separation = cleanP99 !== null && rejectP05 !== null && cleanP99 < currentThresholdUv && rejectP05 > currentThresholdUv;
    const lines = [
        '# 曹操多晚次 EEG 振幅质量门限核查',
        '',
        '> 研究性、只读核查。质量门控复算使用与在线模型一致的训练滤波器输入；不把操作日志标签当作独立金标准，也不由本报告自动修改实时门限。',
        '',
        '## 结论',
        '',
        `1. 本地当前可读取到 ${sessions.length} 个含 EDF 的采集会话，覆盖 ${new Set(sessions.map(session => session.date)).size} 个日期，共 ${allRows.length} 个完整 30 秒 epoch；因此目前是“多会话/少数日期”证据，不应表述为已覆盖大量独立夜晚。`,
        `2. 500 µV 应理解为“模型滤波后输入的研究性振幅门限”，不是对原始 EDF 数值直接使用的通用医学标准，也不能仅凭设备名称证明它是曹操硬件的最佳阈值。原始值包含差分基线/增益/接触等影响，必须与模型滤波后 maxAbs 一起区分。`,
        `3. 当前 500 µV 下，${current.passEpochs}/${allRows.length} 个完整 epoch 通过（${percent(current.passPercent)}）；与已有在线质量字段的相符率为 ${percent(current.loggedAgreement)}。该相符率是实现一致性检查，不是阈值正确率。`,
        separation
            ? `4. 在当前操作标签分组中，质量通过组的 modelMaxAbs 中位数为 ${number(loggedPass.modelMaxAbsUv.median)} µV、P99 为 ${number(cleanP99)} µV，质量拒绝组 P05 为 ${number(rejectP05)} µV；500 µV 对本地记录呈现出一定分离，但由于标签本身由同一门控产生，只能支持“暂时保留并继续验证”，不能证明科学最优。`
            : '4. 当前数据没有形成足够独立的“干净/伪迹”标签分离证据；不建议依据这批未标注数据自动下调或上调实时门限。',
        `5. N3 离线概率网格已覆盖 50%–95%；真实发光仍保持 shadow mode/默认关闭，85% 已标为临时研究性阈值，未把它宣称为 PSG 校准阈值。`,
        '',
        '## 质量指标口径',
        '',
        '- `rawMaxAbsUv`、raw 均值和 raw 标准差只描述 EDF 原始记录，不能直接与 500 µV 门限比较。',
        '- `modelMaxAbsUv` 是 0.4–18 Hz 训练滤波链、直接型实现、首个 epoch 忽略 5 秒启动段后的绝对峰值；它才是当前实时质量门控的可比指标。',
        '- 均值对动作/接触伪迹很敏感；本报告同时给出中位数、P95、P99 和最大值。阈值校准应优先看 epoch 分布、MAD/IQR、光刺激重叠及人工伪迹标签，而不是只看总平均数。',
        '',
        '## model-filtered 振幅分布',
        '',
        '| 分组 | epoch 数 | 中位数 | P95 | P99 | 平均数 | 最大值 |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        markdownSummary('全部完整 epoch', groups.all),
        markdownSummary('在线质量通过', loggedPass),
        markdownSummary('在线质量拒绝', loggedReject),
        markdownSummary('光刺激重叠 ≥5 秒', groups.lightOverlapAtLeast5Seconds),
        markdownSummary('无光刺激重叠 ≥5 秒', groups.noLightOverlapAtLeast5Seconds),
        '',
        '## 500 µV 与离线质量网格',
        '',
        '| 门限 (µV) | 通过 epoch | 通过比例 | 日志相符率 | 日志通过却被拒绝 | 日志拒绝却被放行 |',
        '| ---: | ---: | ---: | ---: | ---: | ---: |',
        ...qualitySweep.map(row => `| ${row.thresholdUv} | ${row.passEpochs} | ${percent(row.passPercent)} | ${percent(row.loggedAgreement)} | ${row.loggedPassRejected} | ${row.loggedRejectAdmitted} |`),
        '',
        '## N3 概率阈值网格（仅 shadow/离线计数）',
        '',
        '| N3 概率门限 | 质量通过候选命中 | 占因果质量通过比例 | 连续≥2 epoch 段数 | 冷却前可触发起点数 |',
        '| ---: | ---: | ---: | ---: | ---: |',
        ...n3Sweep.map(row => `| ${(row.threshold * 100).toFixed(0)}% | ${row.candidateHits} | ${percent(row.candidateRateAmongCausalQualityPass)} | ${row.consecutiveRunsAtLeast2} | ${row.triggerableEpochStartsBeforeCooldown} |`),
        '',
        '## 按会话概览',
        '',
        '| 会话日期 | 会话状态 | 完整 epoch | 日志通过 | 日志拒绝 | modelMax 中位数 | P95 | P99 |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...sessions.map(session => {
            const rows = session.rows;
            const summary = groupSummary(rows);
            const pass = rows.filter(row => row.loggedQualityOk === true).length;
            const reject = rows.filter(row => row.loggedQualityOk === false).length;
            return `| ${session.date} | ${session.status || '--'} | ${rows.length} | ${pass} | ${reject} | ${number(summary.modelMaxAbsUv.median)} | ${number(summary.modelMaxAbsUv.p95)} | ${number(summary.modelMaxAbsUv.p99)} |`;
        }),
        '',
        '## 执行建议',
        '',
        '1. 实时仍保留 500 µV，但在界面和文档中标为“临时研究性振幅门限”；不要把它应用到 raw EDF，也不要根据未标注数据自动自适应。',
        '2. 继续以 shadow mode 运行，累计更多独立夜晚；每晚同步保留光刺激开/关时间、断连、动作/电极接触备注，并给部分 epoch 做人工伪迹标签。',
        '3. 用独立人工伪迹标签或同步 PSG 作为外部参照，再比较候选门限的干净 epoch 保留率、伪迹漏放率和 N3 可用率；只有在受试者/夜晚分层交叉验证后才考虑更新 500。',
        '4. N3 的 50%–95% 网格结果仅用于离线/验证比较；没有 PSG 标签时，不能从命中数量最多或最多发光推导准确率或安全性。真实光刺激仍需用户显式退出 shadow mode，并经过独立验证。',
        '',
        '## 证据边界',
        '',
        '- 当前数据是单条 CH2 双极差分 EEG（两枚互为参考电极）；本分析不能从 EDF 单独定位哪一枚电极接触异常。',
        '- 质量日志与 500 µV 门限存在同源关系，因此“日志通过/拒绝”不能当作独立真值。',
        '- 没有同步 PSG/AASM 标签时，本报告不输出 sensitivity、specificity、F1、κ 或 N3 漏检率。',
        '',
        `生成时间：${result.generatedAt}`,
        `当前实时振幅门限：${currentThresholdUv} µV；当前 N3 概率默认值：85%（临时研究性，不是科学确定阈值）。`,
        '',
    ];
    return lines.join('\n');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const projectRoot = path.resolve(argValue(args, 'project', path.join(__dirname, '..')));
    const sessionsRoot = path.resolve(argValue(args, 'sessions-root', Storage.dataPaths(path.join(os.homedir(), 'Documents'), APP_VERSION).sessions));
    const outputJson = path.resolve(argValue(args, 'json', path.join(process.cwd(), 'quality_threshold_audit.json')));
    const outputMarkdown = path.resolve(argValue(args, 'md', path.join(process.cwd(), 'quality_threshold_audit.md')));
    if (!fs.existsSync(sessionsRoot)) throw new Error(`会话目录不存在：${sessionsRoot}`);
    const modules = {
        readEdf: require(path.join(projectRoot, 'src', 'edf.js')).readEdf,
        Sleep: require(path.join(projectRoot, 'src', 'realtime-sleep.js')),
        History: require(path.join(projectRoot, 'src', 'session-history.js')),
        SDK: require(path.join(projectRoot, 'src', 'vendor', 'BrainLume_Lib.js')),
    };
    const sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(sessionsRoot, entry.name))
        .sort();
    const audited = [];
    const skipped = [];
    for (const sessionDir of sessionDirs) {
        const result = await auditSession(sessionDir, modules);
        if (result.skipped) skipped.push(result);
        else audited.push(result);
    }
    const allRows = audited.flatMap(session => session.rows);
    const currentThresholdUv = 500;
    const groups = {
        all: groupSummary(allRows),
        loggedQualityPass: groupSummary(filterRows(allRows, row => row.loggedQualityOk === true)),
        loggedQualityReject: groupSummary(filterRows(allRows, row => row.loggedQualityOk === false)),
        lightOverlapAtLeast5Seconds: groupSummary(filterRows(allRows, row => row.lightOverlapAtLeast5Seconds)),
        noLightOverlapAtLeast5Seconds: groupSummary(filterRows(allRows, row => !row.lightOverlapAtLeast5Seconds)),
    };
    const qualityThresholds = [100, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1500, 2000, 5000, 10000, 15000, 20000];
    const result = {
        generatedAt: new Date().toISOString(),
        project: 'EEG_tls_Upper',
        source: {
            sessionsRootLabel: `${path.basename(path.dirname(sessionsRoot))}/${path.basename(sessionsRoot)}`,
            sessionsWithEdf: audited.length,
            skippedSessionDirectories: skipped.length,
            dates: [...new Set(audited.map(session => session.date))].sort(),
        },
        method: {
            qualityGateInput: 'training-filtered model input',
            modelFilter: 'MODEL_TRAINING_PRESET, initialization=zero, implementation=direct2t',
            sampleRateHz: 250,
            epochSeconds: 30,
            firstEpochIgnoredLeadingSeconds: 5,
            minStdUv: 0.01,
            currentThresholdUv,
            n3ProbabilityGrid: '0.50 to 0.95 by 0.05; causal quality-pass candidates only; shadow/diagnostic count',
            externalLabels: false,
        },
        summary: {
            sessions: audited.length,
            dates: [...new Set(audited.map(session => session.date))].length,
            completeEpochs: allRows.length,
            totalReceivedSamples: audited.reduce((sum, session) => sum + session.receivedSamples, 0),
            totalDurationSeconds: audited.reduce((sum, session) => sum + session.durationSeconds, 0),
            qualityAt500: qualityThresholdSweep(allRows, [currentThresholdUv])[0],
        },
        groups,
        qualitySweep: qualityThresholdSweep(allRows, qualityThresholds),
        n3Sweep: n3ProbabilitySweep(allRows),
        sessions: audited.map(session => ({
            name: session.name,
            date: session.date,
            status: session.status,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            sampleRateHz: session.sampleRateHz,
            receivedSamples: session.receivedSamples,
            durationSeconds: session.durationSeconds,
            fullEpochCount: session.fullEpochCount,
            partialSamples: session.partialSamples,
            canonicalStagingRecords: session.canonicalStagingRecords,
            summary: groupSummary(session.rows),
            qualityAt500: qualityThresholdSweep(session.rows, [currentThresholdUv])[0],
            rows: session.rows,
        })),
        skipped,
        note: 'No raw sample rows are exported. Epoch features are descriptive and the logged quality field is not an independent ground truth because it was produced by the same live gate.',
    };
    result.reportMarkdown = buildMarkdown({ ...result, sessions: audited, allRows, currentThresholdUv });
    fs.mkdirSync(path.dirname(outputJson), { recursive: true });
    fs.mkdirSync(path.dirname(outputMarkdown), { recursive: true });
    fs.writeFileSync(outputJson, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    fs.writeFileSync(outputMarkdown, result.reportMarkdown, 'utf8');
    console.log(JSON.stringify({
        ok: true,
        sessions: audited.length,
        dates: result.source.dates,
        completeEpochs: allRows.length,
        outputJson,
        outputMarkdown,
        qualityAt500: result.summary.qualityAt500,
    }, null, 2));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    stats,
    signalStats,
    qualityThresholdSweep,
    n3ProbabilitySweep,
    thresholdQuality,
};
