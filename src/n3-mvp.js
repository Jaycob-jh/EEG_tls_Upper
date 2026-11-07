'use strict';

// Offline review only. No trigger, control probability, or stage override.
const VERSION = 2;
const FEATURE_VERSION = 1;
const SCREEN = Object.freeze({
    minSlowSeconds: 6,
    flatSeconds: 2,
    rawStepUv: 250,
    hpPeakUv: 500,
    driftWarningPercent: 90,
});

function assess(row, f) {
    const hard = [], warnings = [];
    if (f.railSamples > 0) hard.push('edf_rail');
    if (f.flatSeconds >= SCREEN.flatSeconds) hard.push('raw_flat');
    if (f.rawStepUv >= SCREEN.rawStepUv) hard.push('raw_step');
    if (f.hpPeakUv > SCREEN.hpPeakUv) hard.push('hp_large_peak');
    if (f.rawDriftPercent >= SCREEN.driftWarningPercent) warnings.push('drift_dominant');
    if (f.inputClippedPercent > 0) warnings.push('input_clipped');
    if (row.caocaoQuality !== 'ok') hard.push(
        row.caocaoQuality === 'center_context_edge' ? 'center_unavailable' : 'caocao_quality',
    );
    if (hard.length) return { status: 'insufficient', reasons: hard, warnings };

    const hpN3 = row.anysleepDetrended === 'N3';
    const corroborates = row.yasa === 'N3' || row.caocao === 'N3';
    const strongSlow = f.strictSlowSeconds >= SCREEN.minSlowSeconds;
    const modelSuggests = hpN3 || corroborates || row.anysleep === 'N3';
    if (!modelSuggests && !strongSlow) return { status: 'no_alert', reasons: [], warnings };
    const reasons = [];
    if (!strongSlow) reasons.push('insufficient_slow');
    if (!hpN3) reasons.push('detrended_not_n3');
    if (!corroborates) reasons.push('uncorroborated');
    if (reasons.length) return { status: 'review', reasons, warnings };
    if (warnings.length) return { status: 'review', reasons: ['slow_and_models', 'quality_warning'], warnings };
    return { status: 'candidate', reasons: ['slow_and_models'], warnings };
}

function buildN3Mvp(comparisonRows, evidence) {
    if (evidence.settings?.version !== FEATURE_VERSION || comparisonRows.length !== evidence.rows?.length) {
        throw new Error('N3 特征版本或片段数不匹配');
    }
    const counts = { candidate: 0, review: 0, insufficient: 0, no_alert: 0 };
    const required = ['strictSlowSeconds', 'railSamples', 'flatSeconds', 'rawStepUv', 'hpPeakUv', 'inputClippedPercent'];
    const rows = comparisonRows.map((row, index) => {
        const feature = evidence.rows[index];
        if (row.epochIndex !== index || feature?.epochIndex !== index || row.startSec !== index * 30
            || row.endSec !== (index + 1) * 30 || !required.every(key => Number.isFinite(feature[key]) && feature[key] >= 0)
            || feature.strictSlowSeconds > 30) throw new Error('N3 证据与 EDF 片段对齐失败');
        const decision = assess(row, feature);
        counts[decision.status] += 1;
        return { ...feature, startSec: row.startSec, endSec: row.endSec,
            anysleep: row.anysleep, anysleepDetrended: row.anysleepDetrended, yasa: row.yasa,
            caocao: row.caocao, caocaoQuality: row.caocaoQuality, ...decision };
    });
    return { version: VERSION, offlineOnly: true, screen: SCREEN, settings: evidence.settings, counts, rows };
}

module.exports = { VERSION, FEATURE_VERSION, SCREEN, assess, buildN3Mvp };
