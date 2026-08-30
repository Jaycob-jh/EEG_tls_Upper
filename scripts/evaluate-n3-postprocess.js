'use strict';

/**
 * Evaluate the conservative N3 postprocessor on a completed replay artifact.
 * The replay artifact contains weak legacy labels only; this script is not a
 * clinical validation tool and never changes source EDFs or legacy outputs.
 */

const fs = require('node:fs');
const path = require('node:path');
const Postprocess = require('../src/sleep-stage-postprocess');

const STAGES = ['W', 'N1', 'N2', 'N3', 'REM'];

function argValue(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberArg(name, fallback) {
    const value = Number(argValue(name, fallback));
    return Number.isFinite(value) ? value : fallback;
}

function metricSummary(rows, predictionKey) {
    const usable = rows.filter(row => row.reference);
    let agreement = 0;
    let known = 0;
    let trueN3 = 0;
    let predictedN3 = 0;
    let referenceN3 = 0;
    for (const row of usable) {
        const prediction = String(row[predictionKey] || '');
        if (prediction !== Postprocess.UNKNOWN_STAGE) {
            known += 1;
            if (prediction === row.reference) agreement += 1;
        }
        if (prediction === 'N3') predictedN3 += 1;
        if (row.reference === 'N3') referenceN3 += 1;
        if (prediction === 'N3' && row.reference === 'N3') trueN3 += 1;
    }
    const precision = predictedN3 ? trueN3 / predictedN3 : null;
    const recall = referenceN3 ? trueN3 / referenceN3 : null;
    return {
        n: usable.length,
        knownEpochs: known,
        coverage: usable.length ? known / usable.length : null,
        knownAgreement: known ? agreement / known : null,
        unknownEpochs: usable.length - known,
        n3: {
            predictedEpochs: predictedN3,
            referenceEpochs: referenceN3,
            truePositiveEpochs: trueN3,
            precision,
            recall,
            f1: precision != null && recall != null && precision + recall > 0
                ? 2 * precision * recall / (precision + recall) : null,
        },
    };
}

function groupMetrics(rows, key, predictionKey) {
    const groups = new Map();
    for (const row of rows) {
        const value = String(row[key] || 'unknown');
        if (!groups.has(value)) groups.set(value, []);
        groups.get(value).push(row);
    }
    return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([value, groupRows]) => [value, metricSummary(groupRows, predictionKey)]));
}

function processRows(files, mode, options) {
    const output = [];
    for (const file of files) {
        // The state must be reset at each recording boundary. Carrying an N3
        // run from one night into another would be a validation bug.
        const processor = new Postprocess.N3Postprocessor({ mode, ...options });
        for (const row of file.rows || []) {
            const result = processor.update({
                epochIndex: row.epochIndex,
                rawStage: row.smoothedStage,
                rawProbabilities: row.smoothedProbabilities,
                quality: {
                    ok: row.qualityOk === true,
                    reason: row.qualityReason || 'quality_reject',
                },
                // Deliberately passed for observability; the default policy is
                // ignore, so the historical 20% gate cannot affect the result.
                deltaRatio: row.deltaRatioFullEpoch,
                contextReady: true,
                controlEligible: mode === 'causal' && row.qualityOk === true,
            });
            output.push({
                group: file.group,
                subject: file.subject,
                file: path.basename(file.edfPath || ''),
                epochIndex: row.epochIndex,
                reference: row.reference,
                originalReference: row.originalReference,
                baseStage: row.smoothedStage,
                postprocessedStage: result.stage,
                n3Status: result.n3Status,
                reason: result.reason,
                controlEligible: result.controlEligible,
                qualityOk: row.qualityOk === true,
            });
        }
    }
    return output;
}

function summarizeMode(files, mode, options) {
    const rows = processRows(files, mode, options);
    return {
        mode,
        options,
        rows: rows.length,
        baseline: metricSummary(rows, 'baseStage'),
        postprocessed: metricSummary(rows, 'postprocessedStage'),
        byGroup: groupMetrics(rows, 'group', 'postprocessedStage'),
        bySubject: groupMetrics(rows, 'subject', 'postprocessedStage'),
        postprocessStatusCounts: rows.reduce((counts, row) => {
            counts[row.n3Status] = (counts[row.n3Status] || 0) + 1;
            return counts;
        }, {}),
        reasonCounts: rows.reduce((counts, row) => {
            const reason = row.reason || 'none';
            counts[reason] = (counts[reason] || 0) + 1;
            return counts;
        }, {}),
    };
}

function main() {
    const inputPath = path.resolve(argValue('--input', path.join(process.cwd(), 'analysis', 'n3-postprocess', 'tls-replay-16x300.json')));
    const outputPath = path.resolve(argValue('--output', path.join(process.cwd(), 'analysis', 'n3-postprocess', 'tls-postprocess-evaluation.json')));
    const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const options = {
        exitN3Probability: numberArg('--exit-probability', 0.75),
        enterConsecutiveEpochs: numberArg('--enter-epochs', 2),
        exitConsecutiveEpochs: numberArg('--exit-epochs', 2),
    };
    const files = (payload.files || []).filter(file => Array.isArray(file.rows));
    const result = {
        generatedAt: new Date().toISOString(),
        inputPath,
        reference: 'legacy improved hypnogram (YASA plus heuristic correction); weak reference only, not AASM PSG ground truth',
        selectedFiles: files.length,
        stages: STAGES,
        note: 'Each file has an independent stateful processor. Center and causal results are evaluated separately.',
        center: summarizeMode(files, 'center', options),
        causal: summarizeMode(files, 'causal', { ...options, enterConsecutiveEpochs: Math.max(3, options.enterConsecutiveEpochs) }),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath,
        selectedFiles: files.length,
        center: result.center.postprocessed,
        causal: result.causal.postprocessed,
    }, null, 2));
}

main();
