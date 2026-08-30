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
    const quality = event.quality && typeof event.quality === 'object' ? event.quality : {};
    const stage = String(event.stage || event.rawStage || '--').slice(0, 40);
    const modelStage = String(event.modelStage || event.rawStage || '').slice(0, 40);
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
        modelStage: STAGING_STAGES.has(modelStage) ? modelStage : modelStage || null,
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

module.exports = { normalizeStagingEvent, parseSessionStagingHistory };
