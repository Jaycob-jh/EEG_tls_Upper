(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BrainLumeSleepStagePostprocess = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STAGES = Object.freeze(['W', 'N1', 'N2', 'N3', 'REM']);
    const UNKNOWN_STAGE = 'UNKNOWN';
    const MODE_DEFAULTS = Object.freeze({
        center: Object.freeze({ minN3Probability: 0.92, enterConsecutiveEpochs: 2, exitConsecutiveEpochs: 2 }),
        causal: Object.freeze({ minN3Probability: 0.95, enterConsecutiveEpochs: 3, exitConsecutiveEpochs: 2 }),
    });
    const DEFAULT_OPTIONS = Object.freeze({
        mode: 'center',
        minN3Probability: 0.92,
        exitN3Probability: 0.75,
        enterConsecutiveEpochs: 2,
        exitConsecutiveEpochs: 2,
        slowWaveEvidencePolicy: 'ignore',
        minSlowWaveSeconds: 6,
        minSlowWaveScore: 0.5,
        deltaEvidencePolicy: 'ignore',
        minDeltaRatio: null,
        contextRequiredForControl: true,
    });

    function finiteOr(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function clamp01(value) {
        return Math.max(0, Math.min(1, finiteOr(value, 0)));
    }

    function normalizeProbabilities(values) {
        const result = Array.from(values || [], Number)
            .slice(0, STAGES.length)
            .map(value => Number.isFinite(value) ? Math.max(0, value) : 0);
        while (result.length < STAGES.length) result.push(0);
        const sum = result.reduce((total, value) => total + value, 0);
        return sum > 0 ? result.map(value => value / sum) : STAGES.map(() => 1 / STAGES.length);
    }

    function normalizePolicy(value, name) {
        const policy = String(value ?? DEFAULT_OPTIONS[name]);
        if (!['ignore', 'support', 'require'].includes(policy)) {
            throw new RangeError(`${name} 必须为 ignore、support 或 require`);
        }
        return policy;
    }

    function normalizeOptions(options = {}) {
        const source = options && typeof options === 'object' ? options : {};
        const mode = String(source.mode ?? DEFAULT_OPTIONS.mode);
        if (!Object.prototype.hasOwnProperty.call(MODE_DEFAULTS, mode)) {
            throw new RangeError('N3 后处理 mode 必须为 center 或 causal');
        }
        const modeDefaults = MODE_DEFAULTS[mode];
        const normalized = {
            mode,
            minN3Probability: clamp01(source.minN3Probability ?? modeDefaults.minN3Probability),
            exitN3Probability: clamp01(source.exitN3Probability ?? DEFAULT_OPTIONS.exitN3Probability),
            enterConsecutiveEpochs: Math.max(1, Math.floor(finiteOr(
                source.enterConsecutiveEpochs, modeDefaults.enterConsecutiveEpochs))),
            exitConsecutiveEpochs: Math.max(1, Math.floor(finiteOr(
                source.exitConsecutiveEpochs, modeDefaults.exitConsecutiveEpochs))),
            slowWaveEvidencePolicy: normalizePolicy(source.slowWaveEvidencePolicy, 'slowWaveEvidencePolicy'),
            minSlowWaveSeconds: Math.max(0, finiteOr(source.minSlowWaveSeconds, DEFAULT_OPTIONS.minSlowWaveSeconds)),
            minSlowWaveScore: clamp01(source.minSlowWaveScore ?? DEFAULT_OPTIONS.minSlowWaveScore),
            deltaEvidencePolicy: normalizePolicy(source.deltaEvidencePolicy, 'deltaEvidencePolicy'),
            minDeltaRatio: source.minDeltaRatio == null ? null : clamp01(source.minDeltaRatio),
            contextRequiredForControl: source.contextRequiredForControl !== false,
        };
        if (normalized.exitN3Probability > normalized.minN3Probability) {
            throw new RangeError('exitN3Probability 不能高于 minN3Probability');
        }
        if (normalized.enterConsecutiveEpochs > 60 || normalized.exitConsecutiveEpochs > 60) {
            throw new RangeError('连续 epoch 阈值必须为 1~60');
        }
        if (normalized.deltaEvidencePolicy !== 'ignore' && normalized.minDeltaRatio == null) {
            throw new RangeError('启用 deltaRatio 证据时必须显式配置 minDeltaRatio；不会默认使用 0.2');
        }
        return Object.freeze(normalized);
    }

    function validateOptions(options = {}) {
        try {
            normalizeOptions(options);
            return [];
        } catch (error) {
            return [error.message];
        }
    }

    function stageFromResult(result) {
        const candidate = result && (result.rawStage ?? result.currentStage ?? result.stage);
        return STAGES.includes(String(candidate)) ? String(candidate) : UNKNOWN_STAGE;
    }

    function rawProbabilitiesFromResult(result) {
        const values = result && (result.rawProbabilities ?? result.probabilities);
        return Array.from(values || [], value => Number(value));
    }

        function qualityState(result) {
        const quality = result && result.quality;
        if (quality === true) return { ok: true, source: quality };
        if (quality && typeof quality === 'object') {
            return { ok: quality.ok === true, source: quality, reason: quality.reason };
        }
        return { ok: false, source: quality, reason: 'quality_missing' };
    }

    function numericEvidence(result, name) {
        const direct = result && result[name];
        const quality = result && result.quality;
        const fromQuality = quality && typeof quality === 'object' ? quality[name] : undefined;
        const value = direct ?? fromQuality;
        return Number.isFinite(Number(value)) ? Number(value) : null;
    }

    function slowWaveEvidenceFromResult(result) {
        const evidence = result && (result.slowWaveEvidence ?? result.slowWaves);
        if (evidence == null) return null;
        if (typeof evidence === 'boolean') return { present: evidence, seconds: evidence ? Infinity : 0, score: evidence ? 1 : 0 };
        if (typeof evidence === 'number') return { present: evidence > 0, seconds: evidence, score: null };
        if (typeof evidence !== 'object') return null;
        const seconds = finiteOr(evidence.seconds ?? evidence.durationSeconds, 0);
        const score = evidence.score == null ? null : clamp01(evidence.score);
        const present = evidence.present == null ? seconds > 0 || (score != null && score > 0) : evidence.present === true;
        return { present, seconds, score };
    }

    function evidenceCheck(policy, evidence, pass) {
        if (policy === 'ignore') return { ok: true, available: evidence != null, reason: null };
        if (evidence == null) {
            return { ok: policy !== 'require', available: false, reason: policy === 'require' ? 'evidence_missing' : null };
        }
        return { ok: pass, available: true, reason: pass ? null : 'evidence_weak' };
    }

    function selectArgmax(values) {
        let index = 0;
        for (let candidate = 1; candidate < values.length; candidate++) {
            if (values[candidate] > values[index]) index = candidate;
        }
        return index;
    }

    function confidenceForStage(stage, probabilities) {
        const index = STAGES.indexOf(stage);
        return index >= 0 ? probabilities[index] : 0;
    }

    class N3Postprocessor {
        constructor(options = {}) {
            this.options = normalizeOptions(options);
            this.reset();
        }

        reset() {
            this.lastEpochIndex = null;
            this.n3Run = 0;
            this.exitRun = 0;
            this.n3Active = false;
        }

        updateOptions(options = {}) {
            this.options = normalizeOptions({ ...this.options, ...options });
            this.reset();
            return this.options;
        }

        evidence(result, probabilities) {
            const options = this.options;
            const deltaRatio = numericEvidence(result, 'deltaRatio');
            const delta = evidenceCheck(
                options.deltaEvidencePolicy,
                deltaRatio,
                deltaRatio != null && options.minDeltaRatio != null && deltaRatio >= options.minDeltaRatio,
            );
            const slowWave = slowWaveEvidenceFromResult(result);
            const slow = evidenceCheck(
                options.slowWaveEvidencePolicy,
                slowWave,
                slowWave != null
                    && slowWave.present
                    && slowWave.seconds >= options.minSlowWaveSeconds
                    && (slowWave.score == null || slowWave.score >= options.minSlowWaveScore),
            );
            return {
                deltaRatio,
                delta,
                slowWave,
                slow,
                ok: delta.ok && slow.ok,
                // This makes it explicit that deltaRatio is optional evidence,
                // not a hidden fixed 0.2 gate.
                configured: options.deltaEvidencePolicy !== 'ignore' || options.slowWaveEvidencePolicy !== 'ignore',
                n3Probability: probabilities[3],
            };
        }

        resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, confidence, fields = {}) {
            const epochIndex = Number(result && result.epochIndex);
            const candidateStage = fields.candidateStage ?? rawStage;
            return {
                rawStage,
                rawProbabilities: rawProbabilities.slice(),
                normalizedProbabilities: normalizedProbabilities.slice(),
                stage: fields.stage ?? rawStage,
                // `stage` is the conservative, scorable output. `candidateStage`
                // is the model's descriptive candidate and remains visible even
                // when quality or N3 safety confirmation prevents scoring/control.
                candidateStage,
                candidateConfidence: clamp01(fields.candidateConfidence ?? confidenceForStage(candidateStage, normalizedProbabilities)),
                confidence,
                rawConfidence: normalizedProbabilities[selectArgmax(normalizedProbabilities)],
                n3Status: fields.n3Status ?? 'inactive',
                reason: fields.reason ?? null,
                controlEligible: fields.controlEligible === true,
                controlEligibilityReason: fields.controlEligibilityReason ?? null,
                epochIndex: Number.isFinite(epochIndex) ? epochIndex : null,
                mode: this.options.mode,
                n3Active: this.n3Active,
                n3Run: this.n3Run,
                exitRun: this.exitRun,
                ...fields,
            };
        }

        update(result = {}) {
            const rawProbabilities = rawProbabilitiesFromResult(result);
            const normalizedProbabilities = normalizeProbabilities(rawProbabilities);
            const rawStage = stageFromResult(result);
            const quality = qualityState(result);
            const epochIndex = Number(result.epochIndex);
            if (Number.isFinite(epochIndex) && this.lastEpochIndex != null && epochIndex <= this.lastEpochIndex) {
                return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, 0, {
                    stage: UNKNOWN_STAGE,
                    n3Status: 'suppressed',
                    candidateStage: rawStage,
                    reason: 'duplicate_or_out_of_order_epoch',
                    controlEligibilityReason: 'duplicate_or_out_of_order_epoch',
                });
            }
            if (Number.isFinite(epochIndex)) this.lastEpochIndex = epochIndex;

            const modelConfidence = normalizedProbabilities[selectArgmax(normalizedProbabilities)];
            if (!quality.ok) {
                this.n3Run = 0;
                this.exitRun = 0;
                this.n3Active = false;
                return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, 0, {
                    stage: UNKNOWN_STAGE,
                    // A quality rejection is not an N3 rejection. Keep the
                    // model candidate visible and use a distinct status so the
                    // UI cannot imply that W/N2/REM was suppressed as N3.
                    n3Status: 'quality_rejected',
                    candidateStage: rawStage,
                    reason: quality.reason || 'quality_reject',
                    controlEligibilityReason: 'quality_reject',
                });
            }

            const evidence = this.evidence(result, normalizedProbabilities);
            const isRawN3 = rawStage === 'N3';
            const probabilityPass = isRawN3 && normalizedProbabilities[3] >= this.options.minN3Probability;
            const candidatePass = probabilityPass && evidence.ok;
            const contextReady = result.contextReady !== false
                && result.contextQualityOk !== false
                && (!this.options.contextRequiredForControl || result.controlEligible !== false);
            const controlReason = this.options.mode === 'center'
                ? 'retrospective_center_output'
                : (contextReady ? null : 'context_not_ready');

            if (this.n3Active) {
                const exitPass = isRawN3
                    && normalizedProbabilities[3] >= this.options.exitN3Probability
                    && evidence.ok;
                if (exitPass) {
                    this.exitRun = 0;
                    return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, normalizedProbabilities[3], {
                        n3Status: 'trusted',
                        reason: 'n3_hysteresis_hold',
                        controlEligible: this.options.mode === 'causal' && contextReady,
                        controlEligibilityReason: controlReason,
                        n3Evidence: evidence,
                    });
                }
                this.exitRun += 1;
                if (this.exitRun < this.options.exitConsecutiveEpochs) {
                    return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, normalizedProbabilities[3], {
                        stage: 'N3',
                        n3Status: 'pending_exit',
                        reason: 'n3_exit_hysteresis_pending',
                        controlEligibilityReason: 'n3_exit_hysteresis_pending',
                        n3Evidence: evidence,
                    });
                }
                this.n3Active = false;
                this.n3Run = 0;
                this.exitRun = 0;
                return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, 0, {
                    stage: isRawN3 ? UNKNOWN_STAGE : rawStage,
                    n3Status: isRawN3 ? 'suppressed' : 'inactive',
                    reason: isRawN3 ? 'n3_exit_hysteresis' : 'stage_not_n3',
                    controlEligibilityReason: 'n3_not_trusted',
                    n3Evidence: evidence,
                });
            }

            if (candidatePass) {
                this.n3Run += 1;
                if (this.n3Run >= this.options.enterConsecutiveEpochs) {
                    this.n3Active = true;
                    this.exitRun = 0;
                    return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, normalizedProbabilities[3], {
                        n3Status: 'trusted',
                        reason: 'n3_consecutive_confirmed',
                        controlEligible: this.options.mode === 'causal' && contextReady,
                        controlEligibilityReason: controlReason,
                        n3Evidence: evidence,
                    });
                }
                return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities, 0, {
                    stage: UNKNOWN_STAGE,
                    n3Status: 'pending',
                    reason: 'n3_waiting_consecutive',
                    controlEligibilityReason: 'n3_waiting_consecutive',
                    n3Evidence: evidence,
                });
            }

            this.n3Run = 0;
            this.exitRun = 0;
            const n3Suppressed = isRawN3;
            const reason = !isRawN3 ? 'stage_not_n3'
                : !probabilityPass ? 'n3_probability_below_enter'
                    : evidence.delta.reason === 'evidence_missing' || evidence.slow.reason === 'evidence_missing'
                        ? 'n3_evidence_missing' : 'n3_evidence_weak';
            return this.resultFor(result, rawStage, rawProbabilities, normalizedProbabilities,
                n3Suppressed ? 0 : modelConfidence, {
                    stage: n3Suppressed ? UNKNOWN_STAGE : rawStage,
                    n3Status: n3Suppressed ? 'suppressed' : 'inactive',
                    reason,
                    controlEligibilityReason: n3Suppressed ? 'n3_not_trusted' : null,
                    n3Evidence: evidence,
                });
        }
    }

    return Object.freeze({
        STAGES,
        UNKNOWN_STAGE,
        MODE_DEFAULTS,
        DEFAULT_OPTIONS,
        normalizeProbabilities,
        normalizeOptions,
        validateOptions,
        N3Postprocessor,
    });
}));
