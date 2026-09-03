'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ort = require('onnxruntime-node');
const {
    ASSET_PATHS,
    inspectOnnxSession,
    inspectRuntimeOutputs,
    inspectSleepModelAssets,
} = require('../src/sleep-model-integrity');

function parseArgs(argv) {
    const options = {
        rootDir: path.resolve(__dirname, '..'),
        json: true,
        outputPath: null,
        referenceModel: null,
        referenceMetadata: null,
    };
    const valueFor = (index, name) => {
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
        return value;
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--json') options.json = true;
        else if (argument === '--text') options.json = false;
        else if (argument === '--root') options.rootDir = path.resolve(valueFor(index++, '--root'));
        else if (argument === '--output' || argument === '--report') options.outputPath = path.resolve(valueFor(index++, argument));
        else if (argument === '--reference-model') options.referenceModel = path.resolve(valueFor(index++, '--reference-model'));
        else if (argument === '--reference-metadata') options.referenceMetadata = path.resolve(valueFor(index++, '--reference-metadata'));
        else if (argument === '--help' || argument === '-h') options.help = true;
        else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

function metadataEntries(metadata, names) {
    if (Array.isArray(metadata)) return metadata;
    if (!metadata || typeof metadata !== 'object') return [];
    return names.map(name => ({ name, ...(metadata[name] || {}) }));
}

function concreteShape(shape) {
    if (!Array.isArray(shape)) return null;
    const result = shape.map((dimension, index) => {
        if (typeof dimension === 'string') {
            if (index === 0 || dimension === 'batch' || dimension === '-1') return 1;
            const number = Number(dimension);
            return Number.isInteger(number) && number > 0 ? number : null;
        }
        const number = Number(dimension);
        return Number.isInteger(number) && number > 0 ? number : null;
    });
    return result.every(Number.isInteger) ? result : null;
}

function zeroFeeds(session) {
    const feeds = {};
    const inputMetadata = metadataEntries(session.inputMetadata, session.inputNames || []);
    for (const entry of inputMetadata) {
        const shape = concreteShape(entry.shape || entry.dimensions || entry.dims);
        if (!shape) throw new Error(`Cannot create a deterministic synthetic feed for ${entry.name}`);
        const length = shape.reduce((total, dimension) => total * dimension, 1);
        feeds[entry.name] = new ort.Tensor('float32', new Float32Array(length), shape);
    }
    return feeds;
}

async function inspectOnnxFile(modelPath, options = {}) {
    const file = { path: modelPath, exists: false, bytes: null };
    try {
        const stat = fs.statSync(modelPath);
        file.exists = stat.isFile();
        file.bytes = stat.size;
    } catch (error) {
        return { ok: false, errorCode: 'SLEEP_MODEL_AUDIT_FAILED', errors: [`model.read: ${error.message || String(error)}`], file };
    }
    if (!file.exists) return { ok: false, errorCode: 'SLEEP_MODEL_AUDIT_FAILED', errors: ['model.read: path is not a file'], file };

    let session;
    try {
        session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
        });
    } catch (error) {
        return {
            ok: false,
            errorCode: 'SLEEP_MODEL_AUDIT_FAILED',
            errors: [`onnx.session_create: ${error.message || String(error)}`],
            file,
        };
    }
    const interfaceReport = options.strict === false
        ? inspectGenericOnnxSession(session)
        : inspectOnnxSession(session);
    let runtimeReport = null;
    if (interfaceReport.ok) {
        try {
            runtimeReport = options.strict === false
                ? inspectGenericRuntimeOutputs(await session.run(zeroFeeds(session)))
                : inspectRuntimeOutputs(await session.run(zeroFeeds(session)));
        } catch (error) {
            runtimeReport = {
                ok: false,
                errorCode: 'SLEEP_MODEL_AUDIT_FAILED',
                errors: [`onnx.synthetic_inference: ${error.message || String(error)}`],
                checks: [],
                outputs: null,
            };
        }
    }
    return {
        ok: interfaceReport.ok && Boolean(runtimeReport?.ok),
        errorCode: interfaceReport.ok && runtimeReport?.ok ? null : 'SLEEP_MODEL_AUDIT_FAILED',
        errors: [...interfaceReport.errors, ...(runtimeReport?.errors || [])],
        file,
        interface: interfaceReport,
        runtime: runtimeReport,
    };
}

function inspectGenericOnnxSession(session) {
    const checks = [];
    const errors = [];
    const inputNames = Array.from(session?.inputNames || [], String);
    const outputNames = Array.from(session?.outputNames || [], String);
    const inputEntries = metadataEntries(session?.inputMetadata, inputNames);
    const outputEntries = metadataEntries(session?.outputMetadata, outputNames);
    const inputMetadata = {};
    const outputMetadata = {};
    checks.push({ name: 'reference.input_count', ok: inputNames.length > 0, actual: inputNames.length, expected: '>0' });
    checks.push({ name: 'reference.output_count', ok: outputNames.length > 0, actual: outputNames.length, expected: '>0' });
    if (!inputNames.length) errors.push('reference.input_count: no inputs');
    if (!outputNames.length) errors.push('reference.output_count: no outputs');
    for (const entry of inputEntries) {
        const shape = entry.shape || entry.dimensions || entry.dims || null;
        inputMetadata[entry.name] = { type: entry.type || entry.dataType || null, shape };
        if (!Array.isArray(shape)) errors.push(`reference.input.${entry.name}.shape: missing`);
    }
    for (const entry of outputEntries) {
        const shape = entry.shape || entry.dimensions || entry.dims || null;
        outputMetadata[entry.name] = { type: entry.type || entry.dataType || null, shape };
        if (!Array.isArray(shape)) errors.push(`reference.output.${entry.name}.shape: missing`);
    }
    return {
        ok: errors.length === 0,
        errorCode: errors.length ? 'SLEEP_MODEL_AUDIT_FAILED' : null,
        errors,
        checks,
        inputNames,
        outputNames,
        inputMetadata,
        outputMetadata,
    };
}

function inspectGenericRuntimeOutputs(outputs) {
    const names = Object.keys(outputs || {}).sort();
    const errors = [];
    const summary = {};
    for (const name of names) {
        const tensor = outputs[name];
        summary[name] = { dims: tensor?.dims || null, length: tensor?.data?.length ?? null };
        if (!Array.isArray(tensor?.dims)) errors.push(`reference.runtime.output.${name}.shape: missing`);
    }
    if (!names.length) errors.push('reference.runtime.output_count: no outputs');
    return {
        ok: errors.length === 0,
        errorCode: errors.length ? 'SLEEP_MODEL_AUDIT_FAILED' : null,
        errors,
        checks: [{ name: 'reference.runtime.output_count', ok: names.length > 0, actual: names.length, expected: '>0' }],
        outputs: summary,
    };
}

function readOptionalJson(filePath) {
    if (!filePath) return null;
    try {
        return { path: filePath, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch (error) {
        return { path: filePath, error: error.message || String(error) };
    }
}

function compareReference(own, reference, referenceMetadata) {
    const comparison = {
        inputNamesEqual: false,
        outputNamesEqual: false,
        probabilityShapeEqual: false,
        own: {
            inputNames: own.interface?.inputNames || [],
            outputNames: own.interface?.outputNames || [],
            probabilityShape: own.interface?.outputMetadata?.prob?.shape || null,
        },
        reference: {
            inputNames: reference.interface?.inputNames || [],
            outputNames: reference.interface?.outputNames || [],
            probabilityShape: reference.interface?.outputMetadata?.prob?.shape || null,
        },
    };
    comparison.inputNamesEqual = JSON.stringify(comparison.own.inputNames.slice().sort())
        === JSON.stringify(comparison.reference.inputNames.slice().sort());
    comparison.outputNamesEqual = JSON.stringify(comparison.own.outputNames.slice().sort())
        === JSON.stringify(comparison.reference.outputNames.slice().sort());
    comparison.probabilityShapeEqual = JSON.stringify(comparison.own.probabilityShape)
        === JSON.stringify(comparison.reference.probabilityShape);
    return {
        ok: reference.ok,
        model: reference,
        metadata: referenceMetadata,
        comparison,
    };
}

function textReport(report) {
    const own = report.own;
    const lines = [
        `overall: ${report.ok ? 'PASS' : 'FAIL'}`,
        `assets: ${own.assets.ok ? 'PASS' : 'FAIL'}`,
        `onnx interface: ${own.onnx.ok ? 'PASS' : 'FAIL'}`,
        `inputs: ${(own.onnx.interface?.inputNames || []).join(', ')}`,
        `outputs: ${(own.onnx.interface?.outputNames || []).join(', ')}`,
        `prob dims: ${JSON.stringify(own.onnx.interface?.outputMetadata?.prob?.shape || null)}`,
        `center index: 10; causal candidate index: 20 (experimental/unvalidated)`,
    ];
    if (report.reference) lines.push(`reference: ${report.reference.ok ? 'PASS' : 'FAIL'}`);
    if (report.errors.length) lines.push(`errors: ${report.errors.join('; ')}`);
    return lines.join('\n');
}

function help() {
    return [
        'Usage: node scripts/audit-sleep-model.js [options]',
        '',
        'Options:',
        '  --json                         Print a JSON audit report (default).',
        '  --text                         Print a short human-readable report.',
        '  --output <file>                Save the JSON audit report to a file.',
        '  --root <directory>             Audit another Upper project root.',
        '  --reference-model <file>      Optionally inspect a reference ONNX model.',
        '  --reference-metadata <file>   Optionally read reference metadata for comparison.',
    ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        console.log(help());
        return 0;
    }
    const ownModelPath = path.join(options.rootDir, ASSET_PATHS.onnx.replaceAll('/', path.sep));
    const assets = inspectSleepModelAssets({ rootDir: options.rootDir });
    const onnx = await inspectOnnxFile(ownModelPath);
    const errors = [...assets.errors, ...onnx.errors];
    let reference = null;
    if (options.referenceModel) {
        const referenceMetadata = readOptionalJson(options.referenceMetadata);
        reference = compareReference(onnx, await inspectOnnxFile(options.referenceModel, { strict: false }), referenceMetadata);
        if (!reference.ok) errors.push(...reference.model.errors.map(error => `reference.${error}`));
    } else if (options.referenceMetadata) {
        const referenceMetadata = readOptionalJson(options.referenceMetadata);
        reference = { ok: !referenceMetadata.error, metadata: referenceMetadata, model: null, comparison: null };
        if (!reference.ok) errors.push(`reference.metadata: ${referenceMetadata.error}`);
    }
    const report = {
        audit: 'EEG_tls_Upper sleep model readiness audit',
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        rootDir: options.rootDir,
        ok: errors.length === 0,
        errors,
        own: { assets, onnx },
        semantics: {
            centerOutputIndex: 10,
            centerDelaySeconds: 300,
            causalOutputIndex: 20,
            causalStatus: 'experimental/unvalidated',
            activeStimulationDefault: false,
            requiresManualValidation: true,
        },
        reference,
    };
    if (options.outputPath) {
        report.outputPath = options.outputPath;
        fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
        fs.writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    console.log(options.json ? JSON.stringify(report, null, 2) : textReport(report));
    return report.ok ? 0 : 1;
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(error.stack || error.message || String(error));
        process.exitCode = 1;
    });
}

module.exports = Object.freeze({ main, inspectOnnxFile, parseArgs });
