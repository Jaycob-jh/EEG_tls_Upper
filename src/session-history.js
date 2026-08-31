'use strict';

const STAGING_STAGES = new Set(['W', 'N1', 'N2', 'N3', 'REM']);

function finiteNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, value));
}

function normalizeProbabilities(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 5).map(item => clamp(finiteNumber(item, 0)));
}

function normalizeStagingEvent(event) {
    if (!event || event.action !== 'sleep_stage_inferred') return null;
    const epochIndex = finiteNumber(event.epochIndex);
    if (!Number.isInteger(epochIndex) || epochIndex < 0) return null;
    const quality = event.quality === true
        ? { ok: true }
        : event.quality && typeof event.quality === 'object' ? event.quality : {};
    const stage = String(event.stage || event.rawStage || '--').slice(0, 40);
    const rawStage = String(event.rawStage || '').slice(0, 40);
    const modelStage = String(event.modelStage || rawStage || '').slice(0, 40);
    // New records persist the explicit display candidate. For old records,
    // fall back to modelStage/rawStage so historical N3 candidates remain
    // visible instead of being rewritten as a generic UNKNOWN stage.
    const candidateStage = String(event.candidateStage || modelStage || rawStage || stage).slice(0, 40);
    const n3Status = String(event.n3Status || '').slice(0, 32);
    const n3Reason = String(event.n3Reason || '').slice(0, 100);
    const mode = String(event.inferenceMode || 'unknown').slice(0, 24);
    const lightChannels = Array.isArray(event.lightChannels)
        ? [...new Set(event.lightChannels.map(Number).filter(channel => channel === 1 || channel === 2))]
        : [];
    const probabilities = normalizeProbabilities(event.probabilities || event.rawProbabilities);
    const confidence = finiteNumber(event.confidence);
    return {
        ts: typeof event.ts === 'string' ? event.ts : null,
        epochIndex,
        stage: STAGING_STAGES.has(stage) ? stage : stage || '--',
        rawStage: STAGING_STAGES.has(rawStage) ? rawStage : rawStage || null,
        modelStage: STAGING_STAGES.has(modelStage) ? modelStage : modelStage || null,
        candidateStage: STAGING_STAGES.has(candidateStage) ? candidateStage : candidateStage || null,
        candidateConfidence: (() => {
            const value = finiteNumber(event.candidateConfidence);
            return value === null ? null : clamp(value);
        })(),
        n3Status: n3Status || null,
        n3Reason: n3Reason || null,
        n3Postprocessed: event.n3Postprocessed === true,
        confidence: confidence === null ? null : clamp(confidence),
        probabilities,
        quality: {
            ok: quality.ok === true,
            reason: String(quality.reason || (quality.ok === true ? 'ok' : 'unknown')).slice(0, 80),
        },
        inferenceMode: mode,
        modelDelaySeconds: Math.max(0, finiteNumber(event.modelDelaySeconds, 0)),
        controlEligible: event.controlEligible === true,
        controlEligibilityReason: typeof event.controlEligibilityReason === 'string'
            ? event.controlEligibilityReason.slice(0, 100) : null,
        lightChannels,
        stimulusShadow: event.stimulusShadow === true,
        outputIndex: Number.isInteger(finiteNumber(event.outputIndex)) ? Number(event.outputIndex) : null,
    };
}

function parseSessionStagingHistory(text) {
    const records = [];
    let ignoredLines = 0;
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            ignoredLines += 1;
            continue;
        }
        if (event?.action !== 'sleep_stage_inferred') continue;
        const record = normalizeStagingEvent(event);
        if (record) records.push(record);
        else ignoredLines += 1;
    }
    records.sort((left, right) => {
        const epochOrder = left.epochIndex - right.epochIndex;
        if (epochOrder) return epochOrder;
        return String(left.ts || '').localeCompare(String(right.ts || ''));
    });
    const epochIndexes = [...new Set(records.map(record => record.epochIndex))];
    const modeCounts = records.reduce((counts, record) => {
        counts[record.inferenceMode] = (counts[record.inferenceMode] || 0) + 1;
        return counts;
    }, {});
    return {
        records,
        ignoredLines,
        summary: {
            recordCount: records.length,
            epochCount: epochIndexes.length,
            firstEpoch: epochIndexes.length ? epochIndexes[0] : null,
            lastEpoch: epochIndexes.length ? epochIndexes[epochIndexes.length - 1] : null,
            firstTs: records[0]?.ts || null,
            lastTs: records.at(-1)?.ts || null,
            modeCounts,
        },
    };
}

function asStagingRecord(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.action === 'sleep_stage_inferred') return normalizeStagingEvent(value);
    if (!Number.isInteger(Number(value.epochIndex))) return null;
    return normalizeStagingEvent({
        ...value,
        action: 'sleep_stage_inferred',
        inferenceMode: value.inferenceMode || value.mode,
    });
}

function recordPriority(record) {
    return record?.inferenceMode === 'causal' ? 3 : record?.inferenceMode === 'center' ? 2 : 1;
}

/**
 * A session normally stores a center (retrospective) and a causal (live)
 * output for the same epoch.  Sleep-architecture metrics must not count both
 * outputs as two epochs, so causal is authoritative when available.
 */
function recordIsNewer(candidate, current) {
    const candidateDate = Date.parse(String(candidate.record.ts || ''));
    const currentDate = Date.parse(String(current.record.ts || ''));
    if (Number.isFinite(candidateDate) && Number.isFinite(currentDate) && candidateDate !== currentDate) {
        return candidateDate > currentDate;
    }
    const candidateText = String(candidate.record.ts || '');
    const currentText = String(current.record.ts || '');
    if (candidateText !== currentText) return candidateText > currentText;
    // events.jsonl order is the only stable recency signal when timestamps are
    // absent or identical (common in old/hand-written fixtures).
    return candidate.inputIndex > current.inputIndex;
}

function selectCanonicalStagingRecords(records) {
    const sourceRecords = Array.isArray(records)
        ? records : Array.isArray(records?.records) ? records.records : [];
    const selected = new Map();
    for (const [inputIndex, value] of (sourceRecords || []).entries()) {
        const record = asStagingRecord(value);
        if (!record) continue;
        const epochIndex = Number(record.epochIndex);
        if (!Number.isInteger(epochIndex) || epochIndex < 0) continue;
        const candidate = { record, inputIndex };
        const previous = selected.get(epochIndex);
        const priority = recordPriority(record);
        const previousPriority = recordPriority(previous?.record);
        if (!previous || priority > previousPriority || (priority === previousPriority && recordIsNewer(candidate, previous))) {
            selected.set(epochIndex, candidate);
        }
    }
    return [...selected.values()]
        .sort((left, right) => left.record.epochIndex - right.record.epochIndex)
        .map(item => item.record);
}

function computeLongestBouts(records, epochSeconds) {
    const result = Object.fromEntries([...STAGING_STAGES].map(stage => [stage, 0]));
    let currentStage = null;
    let currentEpochs = 0;
    let previousEpoch = null;
    const flush = () => {
        if (currentStage && STAGING_STAGES.has(currentStage)) {
            result[currentStage] = Math.max(result[currentStage], currentEpochs * epochSeconds);
        }
    };
    for (const record of records) {
        const stage = record.stage;
        const contiguous = previousEpoch !== null && record.epochIndex === previousEpoch + 1;
        if (stage !== currentStage || !contiguous) {
            flush();
            currentStage = stage;
            currentEpochs = 1;
        } else currentEpochs += 1;
        previousEpoch = record.epochIndex;
    }
    flush();
    return result;
}

/**
 * Calculate sleep-architecture descriptors from the saved online EEG output.
 * This intentionally does not infer stages from raw amplitudes: UNKNOWN and
 * quality-rejected epochs remain excluded and are reported separately.
 */
function computeOnlineSleepMetrics(records, epochSeconds = 30) {
    const normalizedEpochSeconds = epochSeconds && typeof epochSeconds === 'object'
        ? Number(epochSeconds.epochSeconds) : Number(epochSeconds);
    epochSeconds = Number.isFinite(normalizedEpochSeconds) && normalizedEpochSeconds > 0
        ? normalizedEpochSeconds : 30;
    const sourceRecords = Array.isArray(records)
        ? records : Array.isArray(records?.records) ? records.records : [];
    const canonical = selectCanonicalStagingRecords(records);
    const scored = canonical.filter(record => STAGING_STAGES.has(record.stage) && record.quality?.ok === true);
    const stageCounts = Object.fromEntries([...STAGING_STAGES].map(stage => [stage, 0]));
    for (const record of scored) stageCounts[record.stage] += 1;
    const scoredEpochs = scored.length;
    const sleepEpochs = scored.filter(record => record.stage !== 'W').length;
    const wakeEpochs = stageCounts.W;
    const stageDurationsSeconds = Object.fromEntries([...STAGING_STAGES].map(stage => [stage, stageCounts[stage] * epochSeconds]));
    const stagePercentages = Object.fromEntries([...STAGING_STAGES].map(stage => [stage,
        scoredEpochs ? stageCounts[stage] / scoredEpochs * 100 : 0]));
    const firstSleepIndex = scored.findIndex(record => record.stage !== 'W');
    const lastScored = scored.at(-1) || null;
    const afterSleep = firstSleepIndex >= 0 ? scored.slice(firstSleepIndex) : [];
    const wasoEpochs = afterSleep.filter(record => record.stage === 'W').length;
    let transitionCount = 0;
    for (let index = 1; index < scored.length; index++) {
        if (scored[index].epochIndex === scored[index - 1].epochIndex + 1 && scored[index].stage !== scored[index - 1].stage) transitionCount += 1;
    }
    const qualityRejectedEpochs = canonical.filter(record => record.quality?.ok !== true).length;
    const unknownEpochs = canonical.filter(record => !STAGING_STAGES.has(record.stage)).length;
    // Only quality-passing model candidates enter the candidate/confirmation
    // comparison. A rejected candidate is reported separately so it cannot
    // be mistaken for a suppressed physiological N3.
    const candidateN3 = canonical.filter(record => record.quality?.ok === true && record.candidateStage === 'N3');
    const confirmedN3 = candidateN3.filter(record => record.stage === 'N3');
    const suppressedN3 = candidateN3.filter(record => record.stage !== 'N3');
    const longestBouts = computeLongestBouts(scored, epochSeconds);
    const totalScoredSeconds = scoredEpochs * epochSeconds;
    return {
        sourceRecordCount: Array.isArray(sourceRecords) ? sourceRecords.length : 0,
        inputRecordCount: Array.isArray(sourceRecords) ? sourceRecords.length : 0,
        recordCount: canonical.length,
        deduplicatedRecordCount: canonical.length,
        epochSeconds,
        scoredEpochs,
        unscoredEpochs: Math.max(0, canonical.length - scoredEpochs),
        stageCounts,
        stageDurationsSeconds,
        stagePercentages,
        sleepEpochs,
        wakeEpochs,
        totalScoredSeconds,
        totalSleepSeconds: sleepEpochs * epochSeconds,
        wakeSeconds: wakeEpochs * epochSeconds,
        sleepEfficiencyPercent: totalScoredSeconds ? sleepEpochs / scoredEpochs * 100 : null,
        sleepOnsetEpoch: firstSleepIndex >= 0 ? scored[firstSleepIndex].epochIndex : null,
        sleepOnsetSeconds: firstSleepIndex >= 0 ? scored[firstSleepIndex].epochIndex * epochSeconds : null,
        lastScoredEpoch: lastScored?.epochIndex ?? null,
        wasoEpochs,
        wasoSeconds: wasoEpochs * epochSeconds,
        transitionCount,
        longestBouts,
        longestBoutSeconds: longestBouts,
        qualityRejectedEpochs,
        unknownEpochs,
        n3CandidateEpochs: candidateN3.length,
        n3ConfirmedEpochs: confirmedN3.length,
        n3SuppressedEpochs: suppressedN3.length,
        n3QualityRejectedEpochs: canonical.filter(record => record.quality?.ok !== true && record.candidateStage === 'N3').length,
        qualityPassRatePercent: canonical.length ? (canonical.length - qualityRejectedEpochs) / canonical.length * 100 : null,
        definitions: {
            epochSeconds,
            epochIndex: 'epochIndex 从 0 开始；Seconds 为相对记录开始时间。',
            deduplication: '同一 epoch 优先 causal，其次 center；同模式按时间最新，时间相同按输入顺序最新。',
            scoring: '仅 stage 为 W/N1/N2/N3/REM 且 quality.ok === true 的 epoch 计入结构统计。',
            percentages: 'stagePercentages 和 sleepEfficiencyPercent 的分母均为 scoredEpochs（可评分 epoch），不是全部记录。',
            sleepOnset: '首个质量通过且明确为 N1/N2/N3/REM 的 epoch；记录开始不等于熄灯时间。',
            waso: '从睡眠起点到最后可评分 epoch 之间的 W epoch；缺失、UNKNOWN 和质量拒绝不填充为 W。',
            bouts: '同一分期且 epochIndex 连续的可评分 epoch 才组成 bout；缺失或质量拒绝会打断 bout。',
            n3Candidate: '去重后质量通过且 candidateStage/modelStage/rawStage 为 N3 的 epoch；质量拒绝候选单独计入 n3QualityRejectedEpochs。',
            n3Confirmed: '去重后 quality.ok 且最终可评分 stage 为 N3 的 epoch。',
            n3Suppressed: '质量通过的 candidate 为 N3 但最终 stage 不是 N3；包括 pending 和 suppressed。',
            counterOverlap: 'qualityRejectedEpochs 与 unknownEpochs 按原因独立统计，可能对同一 epoch 同时计数。',
        },
        calculationBasis: '仅统计去重后的 causal/center 在线 EEG 输出；stage 明确且 quality.ok=true 的 epoch。UNKNOWN 与质量拒绝单独报告。',
    };
}

module.exports = {
    normalizeStagingEvent, parseSessionStagingHistory, selectCanonicalStagingRecords, computeOnlineSleepMetrics,
};
