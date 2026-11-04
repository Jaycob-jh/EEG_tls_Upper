'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function readSavedYasaResult(directory, metadata = {}) {
    if (!metadata.id || metadata.status === 'recording') return null;
    try {
        const output = path.join(directory, 'analysis', 'yasa');
        const summaryJson = path.join(output, 'yasa_summary.json');
        const epochsCsv = path.join(output, 'yasa_epochs.csv');
        const result = JSON.parse(await fs.readFile(summaryJson, 'utf8'));
        if (result.ok !== true || result.sessionId !== metadata.id
            || !Number.isInteger(result.epochCount) || result.epochCount <= 0
            || !Number.isFinite(result.durationSeconds)) return null;
        const expectedDuration = Number(metadata.rows) / Number(metadata.sampleRateHz || 250);
        // Old EDF results may include the writer's padded final record.
        if (Number.isFinite(expectedDuration) && (Math.abs(expectedDuration - result.durationSeconds) > 1e-6
            || result.epochCount !== Math.floor(expectedDuration / 30))) return null;
        if (metadata.rawDataFile) {
            const file = await fs.stat(path.join(directory, path.basename(metadata.rawDataFile)));
            if (file.size !== Number(metadata.rows) * Number(metadata.rawRecordBytes || 16)) return null;
        }
        await fs.access(epochsCsv);
        return { ...result, outputFiles: { summaryJson, epochsCsv } };
    } catch { return null; }
}
module.exports = { readSavedYasaResult };
