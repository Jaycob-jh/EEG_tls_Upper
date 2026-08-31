'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MODEL_ID = 'cca1a066-c386-4eb4-9eb7-6251e8748e2a';
const SOURCE_CHECKPOINT_SHA256 = 'DB9AF6C81FF9426B828248817187CA684C31781394489BB54B7C9E371C077D0E';
const DODH_CHECKPOINT_SHA256 = '6A7FFAE28F242B56C3109C4461B1057A7A592F0ED450848487A38DE27C78CBA1';
const INTEGRITY_ERROR_CODE = 'SLEEP_MODEL_INTEGRITY_FAILED';

const STAGE_NAMES = Object.freeze({ 0: 'W', 1: 'N1', 2: 'N2', 3: 'N3', 4: 'REM' });
const INPUT_NAMES = Object.freeze(['eeg', 'epoch_index', 'epoch_cycle_index']);
const OUTPUT_NAMES = Object.freeze(['logits', 'prob']);
const INPUT_SHAPES = Object.freeze({
    eeg: Object.freeze([1, 21, 1, 3000]),
    epoch_index: Object.freeze([1, 21, 1]),
    epoch_cycle_index: Object.freeze([1, 21, 5]),
});
const OUTPUT_SHAPE = Object.freeze([21, 5]);
const ASSET_PATHS = Object.freeze({
    onnx: 'models/stage1_sleep.onnx',
    onnx_data: 'models/stage1_sleep.onnx.data',
    metadata: 'models/stage1_sleep.metadata.json',
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(left, right) {
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => sameValue(value, right[index]));
    }
    if (isObject(left) || isObject(right)) {
        if (!isObject(left) || !isObject(right)) return false;
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        return sameValue(leftKeys, rightKeys)
            && leftKeys.every(key => sameValue(left[key], right[key]));
    }
    return Object.is(left, right);
}

function isSha256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function hashFile(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function looksLikeAbsolutePath(value) {
    return typeof value === 'string'
        && (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));
}

function findAbsolutePathStrings(value, location = '$') {
    const hits = [];
    if (looksLikeAbsolutePath(value)) hits.push(location);
    else if (Array.isArray(value)) {
        value.forEach((item, index) => hits.push(...findAbsolutePathStrings(item, `${location}[${index}]`)));
    } else if (isObject(value)) {
        Object.entries(value).forEach(([key, item]) => {
            hits.push(...findAbsolutePathStrings(item, `${location}.${key}`));
        });
    }
    return hits;
}

function resolvePortableAssetPath(rootDir, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || looksLikeAbsolutePath(relativePath)) {
        throw new Error('asset path must be a portable repository-relative path');
    }
    const root = path.resolve(rootDir);
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('asset path escapes the repository root');
    }
    return resolved;
}

function basenamePortable(value) {
    return typeof value === 'string' ? value.split(/[\\/]/).pop() : '';
}

function pathEquals(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function check(checks, errors, name, actual, expected, options = {}) {
    const ok = options.ok ?? sameValue(actual, expected);
    checks.push({ name, ok, actual, expected });
    if (!ok) errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    return ok;
}

function readJson(filePath) {
    try {
        return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    } catch (error) {
        return { error: `${filePath}: ${error.message || String(error)}` };
    }
}

function metadataEntries(metadata, names) {
    if (Array.isArray(metadata)) return metadata;
    if (!isObject(metadata)) return [];
    return names.map(name => ({ name, ...(isObject(metadata[name]) ? metadata[name] : {}) }));
}

function entryShape(entry) {
    return entry?.shape || entry?.dimensions || entry?.dims || null;
}

function entryType(entry) {
    return entry?.type || entry?.dataType || null;
}

function dimensionMatches(actual, expected, index) {
    if (typeof actual === 'string') {
        return index === 0 && (actual === 'batch' || actual === '' || actual === '-1');
    }
    return Number(actual) === Number(expected);
}

function shapeMatches(actual, expected) {
    return Array.isArray(actual)
        && actual.length === expected.length
        && actual.every((dimension, index) => dimensionMatches(dimension, expected[index], index));
}

function inspectOnnxSession(session) {
    const checks = [];
    const errors = [];
    const inputNames = Array.from(session?.inputNames || [], String);
    const outputNames = Array.from(session?.outputNames || [], String);
    const sortedInputs = inputNames.slice().sort();
    const sortedOutputs = outputNames.slice().sort();
    check(checks, errors, 'onnx.input_count', inputNames.length, INPUT_NAMES.length);
    check(checks, errors, 'onnx.input_names', sortedInputs, INPUT_NAMES.slice().sort());
    check(checks, errors, 'onnx.output_count', outputNames.length, OUTPUT_NAMES.length);
    check(checks, errors, 'onnx.output_names', sortedOutputs, OUTPUT_NAMES.slice().sort());

    const inputs = metadataEntries(session?.inputMetadata, INPUT_NAMES);
    const outputs = metadataEntries(session?.outputMetadata, OUTPUT_NAMES);
    const inputSummary = {};
    for (const name of INPUT_NAMES) {
        const entry = inputs.find(item => item.name === name);
        const shape = entryShape(entry);
        const type = entryType(entry);
        inputSummary[name] = { type, shape };
        check(checks, errors, `onnx.input.${name}.present`, Boolean(entry), true);
        check(checks, errors, `onnx.input.${name}.type`, type, 'float32');
        check(checks, errors, `onnx.input.${name}.shape`, shape, INPUT_SHAPES[name], {
            ok: shapeMatches(shape, INPUT_SHAPES[name]),
        });
    }
    const outputSummary = {};
    for (const name of OUTPUT_NAMES) {
        const entry = outputs.find(item => item.name === name);
        const shape = entryShape(entry);
        const type = entryType(entry);
        outputSummary[name] = { type, shape };
        check(checks, errors, `onnx.output.${name}.present`, Boolean(entry), true);
        check(checks, errors, `onnx.output.${name}.type`, type, 'float32');
        check(checks, errors, `onnx.output.${name}.shape`, shape, OUTPUT_SHAPE, {
            ok: shapeMatches(shape, OUTPUT_SHAPE),
        });
    }
    return {
        ok: errors.length === 0,
        errorCode: errors.length ? INTEGRITY_ERROR_CODE : null,
        errors,
        checks,
        inputNames,
        outputNames,
        inputMetadata: inputSummary,
        outputMetadata: outputSummary,
    };
}

function inspectRuntimeOutputs(outputs) {
    const checks = [];
    const errors = [];
    const names = Object.keys(outputs || {}).sort();
    check(checks, errors, 'runtime.output_names', names, OUTPUT_NAMES.slice().sort());
    const summary = {};
    for (const name of OUTPUT_NAMES) {
        const tensor = outputs?.[name];
        const dims = tensor?.dims || null;
        summary[name] = { dims, length: tensor?.data?.length ?? null };
        check(checks, errors, `runtime.output.${name}.shape`, dims, OUTPUT_SHAPE, {
            ok: shapeMatches(dims, OUTPUT_SHAPE),
        });
        check(checks, errors, `runtime.output.${name}.length`, tensor?.data?.length ?? null, 21 * 5);
    }
    return { ok: errors.length === 0, errorCode: errors.length ? INTEGRITY_ERROR_CODE : null, errors, checks, outputs: summary };
}

function inspectSleepModelAssets(options = {}) {
    const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
    const provenancePath = options.provenancePath || path.join(rootDir, 'models', 'stage1_sleep.provenance.json');
    const metadataPath = options.metadataPath || path.join(rootDir, 'models', 'stage1_sleep.metadata.json');
    const checks = [];
    const errors = [];
    const files = {};
    const actualHashes = {};
    const expectedHashes = {};
    const provenanceResult = options.provenance
        ? { value: options.provenance }
        : readJson(provenancePath);
    const metadataResult = options.metadata
        ? { value: options.metadata }
        : readJson(metadataPath);
    const provenance = provenanceResult.value;
    const metadata = metadataResult.value;

    if (provenanceResult.error) errors.push(`provenance.read: ${provenanceResult.error}`);
    if (metadataResult.error) errors.push(`metadata.read: ${metadataResult.error}`);
    check(checks, errors, 'provenance.object', isObject(provenance), true);
    check(checks, errors, 'metadata.object', isObject(metadata), true);
    if (!isObject(provenance) || !isObject(metadata)) {
        return {
            ok: false, errorCode: INTEGRITY_ERROR_CODE, errors, checks, rootDir,
            paths: { provenancePath, metadataPath }, files, actualHashes, expectedHashes,
            metadataSummary: null,
        };
    }

    const absoluteManifestPaths = findAbsolutePathStrings(provenance);
    check(checks, errors, 'provenance.portable_paths', absoluteManifestPaths, [], {
        ok: absoluteManifestPaths.length === 0,
    });
    check(checks, errors, 'provenance.schema_version', provenance.schema_version, 1);
    check(checks, errors, 'provenance.model_id', provenance.model_id, MODEL_ID);
    check(checks, errors, 'provenance.source_experiment_id', provenance.source_experiment_id, MODEL_ID);
    check(checks, errors, 'provenance.offline_training_pipeline', provenance.offline_training_pipeline,
        'DOD-H pretrained -> wearable fp1fp2 Stage-1 fine-tune');
    check(checks, errors, 'provenance.runtime_online_finetuning', provenance.runtime_online_finetuning, false);
    check(checks, errors, 'provenance.source_checkpoint_sha256', provenance.source_checkpoint_sha256, SOURCE_CHECKPOINT_SHA256);
    check(checks, errors, 'provenance.source_checkpoint.sha256', provenance.source_checkpoint?.sha256, SOURCE_CHECKPOINT_SHA256);
    if (provenance.pretraining_checkpoint) {
        check(checks, errors, 'provenance.pretraining_checkpoint.sha256', provenance.pretraining_checkpoint.sha256, DODH_CHECKPOINT_SHA256);
    }
    check(checks, errors, 'provenance.temporal_context', provenance.temporal_context, 21);
    check(checks, errors, 'provenance.center_output_index', provenance.center_output_index, 10);
    check(checks, errors, 'provenance.causal_output_index', provenance.causal_output_index, 20);
    check(checks, errors, 'provenance.causal_status', provenance.causal_status, 'experimental/unvalidated');
    check(checks, errors, 'provenance.active_stimulation_default', provenance.active_stimulation_default, false);
    check(checks, errors, 'provenance.requires_manual_validation', provenance.requires_manual_validation, true);

    const inputContract = provenance.input_contract || {};
    const outputContract = provenance.output_contract || {};
    const preprocessing = provenance.preprocessing || {};
    check(checks, errors, 'provenance.input_contract.input_names', inputContract.input_names, INPUT_NAMES);
    check(checks, errors, 'provenance.input_contract.eeg_shape', inputContract.eeg_shape, INPUT_SHAPES.eeg);
    check(checks, errors, 'provenance.input_contract.lead', inputContract.lead,
        'CH2 bipolar differential EEG lead with two mutually referenced electrodes');
    check(checks, errors, 'provenance.output_contract.output_names', outputContract.output_names, OUTPUT_NAMES);
    check(checks, errors, 'provenance.output_contract.probability_shape', outputContract.probability_shape, OUTPUT_SHAPE);
    check(checks, errors, 'provenance.output_contract.stage_names', outputContract.stage_names, STAGE_NAMES);
    check(checks, errors, 'provenance.center.index', outputContract.center?.index, 10);
    check(checks, errors, 'provenance.center.delay_seconds', outputContract.center?.delay_seconds, 300);
    check(checks, errors, 'provenance.center.control_eligible', outputContract.center?.control_eligible, false);
    check(checks, errors, 'provenance.causal_candidate.index', outputContract.causal_candidate?.index, 20);
    check(checks, errors, 'provenance.causal_candidate.status', outputContract.causal_candidate?.status, 'experimental/unvalidated');
    check(checks, errors, 'provenance.causal_candidate.control_eligible', outputContract.causal_candidate?.control_eligible, false);
    check(checks, errors, 'provenance.preprocessing.input_eeg_unit', preprocessing.input_eeg_unit, 'mV');
    check(checks, errors, 'provenance.preprocessing.device_eeg_unit', preprocessing.device_eeg_unit, 'uV');
    check(checks, errors, 'provenance.preprocessing.device_to_model_scale', preprocessing.device_to_model_scale, 0.001);
    check(checks, errors, 'provenance.preprocessing.resample_to_hz', preprocessing.resample_to_hz, 100);
    check(checks, errors, 'provenance.preprocessing.epoch_seconds', preprocessing.epoch_seconds, 30);
    check(checks, errors, 'provenance.preprocessing.samples_per_epoch', preprocessing.samples_per_epoch, 3000);

    const manifestAssets = provenance.upper_assets || {};
    for (const [key, relativePath] of Object.entries(ASSET_PATHS)) {
        const definition = manifestAssets[key];
        const filePath = path.join(rootDir, relativePath.replaceAll('/', path.sep));
        const file = { relativePath, path: filePath, exists: false, bytes: null, actualSha256: null, expectedSha256: definition?.sha256 || null };
        files[key] = file;
        expectedHashes[key] = definition?.sha256 || null;
        check(checks, errors, `provenance.asset.${key}.object`, isObject(definition), true);
        check(checks, errors, `provenance.asset.${key}.path`, definition?.path, relativePath);
        check(checks, errors, `provenance.asset.${key}.sha256_format`, definition?.sha256, null, {
            ok: isSha256(definition?.sha256),
        });
        try {
            const resolved = resolvePortableAssetPath(rootDir, definition?.path);
            check(checks, errors, `provenance.asset.${key}.root_path`, pathEquals(resolved, filePath), true);
        } catch (error) {
            errors.push(`provenance.asset.${key}.path: ${error.message}`);
        }
        try {
            const stat = fs.statSync(filePath);
            file.exists = stat.isFile();
            file.bytes = stat.size;
            check(checks, errors, `asset.${key}.exists`, file.exists, true);
            if (file.exists) {
                file.actualSha256 = hashFile(filePath);
                actualHashes[key] = file.actualSha256;
                check(checks, errors, `asset.${key}.sha256`, file.actualSha256, definition?.sha256);
            }
        } catch (error) {
            errors.push(`asset.${key}.read: ${error.message || String(error)}`);
        }
    }

    const metadataExperimentId = basenamePortable(metadata.experiment);
    const metadataOnnxName = basenamePortable(metadata.onnx);
    const metadataChecks = [
        ['metadata.experiment_source_id', metadataExperimentId, MODEL_ID],
        ['metadata.onnx_basename', metadataOnnxName, 'stage1_sleep.onnx'],
        ['metadata.stage_names', metadata.stage_names, STAGE_NAMES],
        ['metadata.input_names', metadata.input_names, INPUT_NAMES],
        ['metadata.output_names', metadata.output_names, OUTPUT_NAMES],
        ['metadata.output_layout', metadata.output_layout, 'temporal_context_by_5'],
        ['metadata.center_output_index', metadata.center_output_index, 10],
        ['metadata.eeg_shape', metadata.eeg_shape, INPUT_SHAPES.eeg],
        ['metadata.epoch_index_shape', metadata.epoch_index_shape, INPUT_SHAPES.epoch_index],
        ['metadata.epoch_cycle_index_shape', metadata.epoch_cycle_index_shape, INPUT_SHAPES.epoch_cycle_index],
        ['metadata.temporal_context', metadata.temporal_context, 21],
        ['metadata.epoch_seconds', metadata.epoch_seconds, 30],
        ['metadata.model_rate_hz', metadata.model_rate_hz, 100],
        ['metadata.window_length', metadata.window_length, 3000],
        ['metadata.center_delay_epochs', metadata.center_delay_epochs, 10],
        ['metadata.center_delay_seconds', metadata.center_delay_seconds, 300],
        ['metadata.preprocessing.input_eeg_unit', metadata.preprocessing?.input_eeg_unit, 'mV'],
        ['metadata.preprocessing.device_eeg_unit', metadata.preprocessing?.device_eeg_unit, 'uV'],
        ['metadata.preprocessing.device_to_model_scale', metadata.preprocessing?.device_to_model_scale, 0.001],
        ['metadata.preprocessing.resample_to_hz', metadata.preprocessing?.resample_to_hz, 100],
        ['metadata.preprocessing.epoch_seconds', metadata.preprocessing?.epoch_seconds, 30],
        ['metadata.preprocessing.samples_per_epoch', metadata.preprocessing?.samples_per_epoch, 3000],
    ];
    for (const [name, actual, expected] of metadataChecks) check(checks, errors, name, actual, expected);
    check(checks, errors, 'provenance.metadata_source_experiment_id', provenance.source_experiment_id, metadataExperimentId);
    check(checks, errors, 'provenance.metadata_center_index', provenance.center_output_index, metadata.center_output_index);
    check(checks, errors, 'provenance.metadata_temporal_context', provenance.temporal_context, metadata.temporal_context);
    check(checks, errors, 'provenance.metadata_input_names', inputContract.input_names, metadata.input_names);
    check(checks, errors, 'provenance.metadata_output_names', outputContract.output_names, metadata.output_names);

    return {
        ok: errors.length === 0,
        errorCode: errors.length ? INTEGRITY_ERROR_CODE : null,
        errors,
        checks,
        rootDir,
        paths: { provenancePath, metadataPath },
        files,
        actualHashes,
        expectedHashes,
        metadataSummary: {
            sourceExperimentId: metadataExperimentId,
            inputNames: metadata.input_names,
            outputNames: metadata.output_names,
            outputLayout: metadata.output_layout,
            temporalContext: metadata.temporal_context,
            centerOutputIndex: metadata.center_output_index,
            causalOutputIndex: provenance.causal_output_index,
            inputEegUnit: metadata.preprocessing?.input_eeg_unit,
            deviceEegUnit: metadata.preprocessing?.device_eeg_unit,
            modelRateHz: metadata.model_rate_hz,
            windowLength: metadata.window_length,
        },
    };
}

function integrityError(report, prefix = 'Sleep model integrity check failed') {
    const error = new Error(`${prefix}: ${report.errors.join('; ') || 'unknown integrity error'}`);
    error.code = INTEGRITY_ERROR_CODE;
    error.details = report;
    return error;
}

function validateSleepModelAssets(options = {}) {
    const report = inspectSleepModelAssets(options);
    if (!report.ok) throw integrityError(report);
    return report;
}

async function createValidatedSession(options = {}, createSession) {
    if (typeof createSession !== 'function') throw new TypeError('createSession must be a function');
    const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
    const modelPath = options.modelPath || path.join(rootDir, 'models', 'stage1_sleep.onnx');
    const assetReport = validateSleepModelAssets({ ...options, rootDir });
    let session;
    try {
        session = await createSession(modelPath);
    } catch (error) {
        throw integrityError({ ...assetReport, errors: [`onnx.session_create: ${error.message || String(error)}`] });
    }
    const interfaceReport = inspectOnnxSession(session);
    if (!interfaceReport.ok) throw integrityError(interfaceReport, 'Sleep model ONNX interface check failed');
    return { session, assetReport, interfaceReport };
}

module.exports = Object.freeze({
    MODEL_ID,
    SOURCE_CHECKPOINT_SHA256,
    DODH_CHECKPOINT_SHA256,
    INTEGRITY_ERROR_CODE,
    STAGE_NAMES,
    INPUT_NAMES,
    OUTPUT_NAMES,
    INPUT_SHAPES,
    OUTPUT_SHAPE,
    ASSET_PATHS,
    hashFile,
    inspectOnnxSession,
    inspectRuntimeOutputs,
    inspectSleepModelAssets,
    validateSleepModelAssets,
    createValidatedSession,
});
