(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BrainLumeRealtimeSleep = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STAGES = Object.freeze(['W', 'N1', 'N2', 'N3', 'REM']);
    const MILLIVOLTS_PER_MICROVOLT = 0.001;
    const DEFAULT_STIMULUS_PROTOCOL = Object.freeze({
        enabled: false,
        // New installations observe trigger decisions first. Actual light output
        // requires the user to explicitly leave shadow mode.
        shadowMode: true,
        targetStages: Object.freeze(['N3']),
        minConfidence: 0.8,
        // A conservative physiology check for a one-channel bipolar lead.
        // It is a trigger gate, not a replacement for a validated scorer.
        minN3DeltaRatio: 0.2,
        consecutiveEpochs: 2,
        lightChannel: 1,
        frequencyHz: 10,
        powerPercent: 5,
        durationSeconds: 10,
        cooldownMinutes: 15,
    });

    function normalizeStimulusProtocol(value = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const targetStages = Array.from(new Set(Array.isArray(source.targetStages)
            ? source.targetStages.map(String).filter(stage => STAGES.includes(stage))
            : DEFAULT_STIMULUS_PROTOCOL.targetStages));
        return {
            enabled: source.enabled === true,
            shadowMode: source.shadowMode !== false,
            targetStages,
            minConfidence: Number(source.minConfidence ?? DEFAULT_STIMULUS_PROTOCOL.minConfidence),
            minN3DeltaRatio: Number(source.minN3DeltaRatio ?? DEFAULT_STIMULUS_PROTOCOL.minN3DeltaRatio),
            consecutiveEpochs: Number(source.consecutiveEpochs ?? DEFAULT_STIMULUS_PROTOCOL.consecutiveEpochs),
            lightChannel: Number(source.lightChannel ?? DEFAULT_STIMULUS_PROTOCOL.lightChannel),
            frequencyHz: Number(source.frequencyHz ?? DEFAULT_STIMULUS_PROTOCOL.frequencyHz),
            powerPercent: Number(source.powerPercent ?? DEFAULT_STIMULUS_PROTOCOL.powerPercent),
            durationSeconds: Number(source.durationSeconds ?? DEFAULT_STIMULUS_PROTOCOL.durationSeconds),
            cooldownMinutes: Number(source.cooldownMinutes ?? DEFAULT_STIMULUS_PROTOCOL.cooldownMinutes),
        };
    }

    function integerInRange(value, minimum, maximum) {
        return Number.isInteger(value) && value >= minimum && value <= maximum;
    }

    function validateStimulusProtocol(value = {}) {
        const protocol = normalizeStimulusProtocol(value);
        const errors = [];
        if (!protocol.targetStages.length) errors.push('至少选择一个目标睡眠分期');
        if (!(protocol.minConfidence >= 0.5 && protocol.minConfidence <= 1)) errors.push('置信度阈值必须为 50%~100%');
        if (!(protocol.minN3DeltaRatio >= 0 && protocol.minN3DeltaRatio <= 1)) errors.push('N3 慢波证据阈值必须为 0%~100%');
        if (!integerInRange(protocol.consecutiveEpochs, 1, 10)) errors.push('连续命中次数必须为 1~10');
        if (![1, 2].includes(protocol.lightChannel)) errors.push('光刺激通道必须为 1 或 2');
        if (!integerInRange(protocol.frequencyHz, 1, 100)) errors.push('光刺激频率必须为 1~100Hz');
        if (!integerInRange(protocol.powerPercent, 0, 100)) errors.push('光刺激功率必须为 0~100%');
        if (!integerInRange(protocol.durationSeconds, 1, 3600)) errors.push('单次刺激时长必须为 1~3600 秒');
        if (!integerInRange(protocol.cooldownMinutes, 1, 1440)) errors.push('冷却时间必须为 1~1440 分钟');
        return errors;
    }

    function lightStimulusPresentation(value = {}) {
        const state = value && typeof value === 'object' ? value : {};
        if (!state.connected) {
            return { tone: 'unknown', label: '未连接', detail: '无法确认设备光刺激状态' };
        }
        if (state.pending) {
            const operation = state.pending.operation === 'start' ? '开启' : '关闭';
            return {
                tone: 'pending',
                label: `正在${operation} CH${Number(state.pending.channel)}`,
                detail: '等待设备状态回读确认',
            };
        }
        if (!state.verified) {
            return { tone: 'unknown', label: '状态未知', detail: state.error || '等待设备状态查询' };
        }
        const channels = Array.from(state.runningChannels || [], Number)
            .filter(channel => channel === 1 || channel === 2)
            .sort();
        const confirmation = `设备回读确认${state.checkedAt ? ` · ${state.checkedAt}` : ''}`;
        if (channels.length) {
            return { tone: 'active', label: `CH${channels.join('、CH')} 刺激中`, detail: confirmation };
        }
        return { tone: 'off', label: '已关闭', detail: confirmation };
    }

    class SleepStageStimulusGate {
        constructor(protocol = {}) {
            this.updateProtocol(protocol);
            this.reset();
        }

        updateProtocol(protocol = {}) {
            const normalized = normalizeStimulusProtocol(protocol);
            const errors = validateStimulusProtocol(normalized);
            if (errors.length) throw new RangeError(errors.join('；'));
            this.protocol = normalized;
            this.matchedStage = null;
            this.matchedCount = 0;
            return this.protocol;
        }

        reset() {
            this.lastEpochIndex = null;
            this.lastTriggeredAt = null;
            this.activeUntil = 0;
            this.matchedStage = null;
            this.matchedCount = 0;
        }

        cancelTrigger() {
            this.lastTriggeredAt = null;
            this.activeUntil = 0;
        }

        evaluate(result = {}, nowMs = Date.now()) {
            const epochIndex = Number(result.epochIndex);
            if (Number.isFinite(epochIndex) && this.lastEpochIndex != null && epochIndex <= this.lastEpochIndex) {
                return { triggered: false, reason: 'duplicate_epoch' };
            }
            if (Number.isFinite(epochIndex)) this.lastEpochIndex = epochIndex;
            if (!this.protocol.enabled) return this.reject('disabled');
            if (nowMs < this.activeUntil) return this.reject('stimulus_active', false);
            const cooldownMs = this.protocol.cooldownMinutes * 60_000;
            if (this.lastTriggeredAt != null && nowMs - this.lastTriggeredAt < cooldownMs) {
                return this.reject('cooldown', false);
            }
            if (!result.quality?.ok) return this.reject('poor_quality');
            const stage = String(result.stage || '');
            if (!this.protocol.targetStages.includes(stage)) return this.reject('stage_not_selected');
            const confidence = Number(result.confidence);
            if (!Number.isFinite(confidence) || confidence < this.protocol.minConfidence) return this.reject('low_confidence');
            if (stage === 'N3') {
                const deltaRatio = Number(result.quality?.deltaRatio);
                if (!Number.isFinite(deltaRatio)) return this.reject('n3_delta_missing');
                if (deltaRatio < this.protocol.minN3DeltaRatio) return this.reject('n3_delta_weak');
            }

            if (this.matchedStage === stage) this.matchedCount += 1;
            else {
                this.matchedStage = stage;
                this.matchedCount = 1;
            }
            if (this.matchedCount < this.protocol.consecutiveEpochs) {
                return {
                    triggered: false,
                    reason: 'awaiting_consecutive',
                    stage,
                    matchedCount: this.matchedCount,
                    requiredCount: this.protocol.consecutiveEpochs,
                };
            }

            this.lastTriggeredAt = nowMs;
            this.activeUntil = nowMs + this.protocol.durationSeconds * 1_000;
            this.matchedStage = null;
            this.matchedCount = 0;
            return {
                triggered: true,
                stage,
                confidence,
                epochIndex,
                lightChannel: this.protocol.lightChannel,
                frequencyHz: this.protocol.frequencyHz,
                powerPercent: this.protocol.powerPercent,
                durationMs: this.protocol.durationSeconds * 1_000,
                cooldownMinutes: this.protocol.cooldownMinutes,
                shadowMode: this.protocol.shadowMode,
            };
        }

        reject(reason, resetMatch = true) {
            if (resetMatch) {
                this.matchedStage = null;
                this.matchedCount = 0;
            }
            return { triggered: false, reason };
        }
    }

    function resampleLinear(samples, outputLength) {
        const input = Array.from(samples || [], Number);
        if (outputLength <= 0 || input.length < 2) return [];
        if (input.length === outputLength) return input.slice();
        const output = new Float32Array(outputLength);
        const scale = (input.length - 1) / Math.max(1, outputLength - 1);
        for (let i = 0; i < outputLength; i++) {
            const position = i * scale;
            const left = Math.floor(position);
            const right = Math.min(input.length - 1, left + 1);
            const fraction = position - left;
            output[i] = input[left] + (input[right] - input[left]) * fraction;
        }
        return output;
    }

    /**
     * 按训练脚本的采样时间轴重采样模型输入。
     *
     * 训练端使用 scipy.interpolate.interp1d 后在原采样率时间轴上以
     * inputRate/targetRate 步进取样；它不是把首尾两个端点强行对齐。保留
     * resampleLinear 的通用端点语义，避免影响已有显示/工具函数，模型输入
     * 则必须走这里，确保 250 Hz、30 s 的 7500 点与训练端得到相同的 3000 点。
     */
    function resampleForRate(samples, inputRateHz, targetRateHz, outputLength) {
        const input = Array.from(samples || [], Number);
        const inputRate = Number(inputRateHz);
        const targetRate = Number(targetRateHz);
        if (input.length < 2 || !(inputRate > 0) || !(targetRate > 0)) return [];
        const length = Number.isInteger(outputLength)
            ? outputLength
            : Math.round(input.length * targetRate / inputRate);
        if (length <= 0) return [];
        const ratio = inputRate / targetRate;
        const output = new Float32Array(length);
        for (let index = 0; index < length; index++) {
            const position = index * ratio;
            let left = Math.floor(position);
            let fraction = position - left;
            // scipy interp1d(fill_value='extrapolate') is only relevant for an
            // upsampling edge; keep the same linear extrapolation semantics.
            if (left >= input.length - 1) {
                left = input.length - 2;
                fraction = position - left;
            }
            if (left < 0) {
                left = 0;
                fraction = position;
            }
            const right = left + 1;
            output[index] = input[left] + (input[right] - input[left]) * fraction;
        }
        return output;
    }

    function spectralFeatures(samples, sampleRateHz, options = {}) {
        const values = Array.from(samples || [], Number).filter(Number.isFinite);
        const rate = Number(sampleRateHz);
        if (values.length < 4 || !(rate > 0)) return {};

        // Keep this bounded for the live path. The ratio is only a conservative
        // delta-evidence feature; offline PSD remains the analysis reference.
        const maxSamples = Math.max(32, Math.floor(Number(options.maxSamples) || 2048));
        const length = Math.min(values.length, maxSamples);
        const start = values.length - length;
        const segment = values.slice(start);
        const mean = segment.reduce((sum, value) => sum + value, 0) / length;
        const nyquist = rate / 2;
        const minFrequency = Math.min(0.5, nyquist);
        const maxFrequency = Math.min(18, nyquist);
        const minBin = Math.max(1, Math.ceil(minFrequency * length / rate));
        const maxBin = Math.floor(maxFrequency * length / rate);
        if (maxBin < minBin) return { sampleRateHz: rate, spectralSamples: length, deltaPower: 0, totalPower: 0, deltaRatio: null };

        let deltaPower = 0;
        let totalPower = 0;
        for (let bin = minBin; bin <= maxBin; bin++) {
            const frequency = bin * rate / length;
            let real = 0;
            let imaginary = 0;
            for (let index = 0; index < length; index++) {
                const window = 0.5 * (1 - Math.cos(2 * Math.PI * index / Math.max(1, length - 1)));
                const value = (segment[index] - mean) * window;
                const phase = 2 * Math.PI * bin * index / length;
                real += value * Math.cos(phase);
                imaginary -= value * Math.sin(phase);
            }
            const power = (real * real + imaginary * imaginary) / (length * length);
            totalPower += power;
            if (frequency >= 0.5 && frequency < 4) deltaPower += power;
        }
        return {
            sampleRateHz: rate,
            spectralSamples: length,
            deltaPower,
            totalPower,
            deltaRatio: totalPower > 0 ? deltaPower / totalPower : null,
        };
    }

    function qualityMetrics(samples, options = {}) {
        const values = Array.from(samples || [], Number).filter(Number.isFinite);
        if (!values.length) return { ok: false, reason: 'empty', validSamples: 0 };
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        let maxAbs = 0;
        for (const value of values) {
            sum += value;
            min = Math.min(min, value);
            max = Math.max(max, value);
            maxAbs = Math.max(maxAbs, Math.abs(value));
        }
        const mean = sum / values.length;
        let squareSum = 0;
        for (const value of values) squareSum += (value - mean) ** 2;
        const stdUv = Math.sqrt(squareSum / Math.max(1, values.length - 1));
        const rmsUv = Math.sqrt(values.reduce((total, value) => total + value ** 2, 0) / values.length);
        const maxAbsUv = Number(options.maxAbsUv || 500);
        const minStdUv = Number(options.minStdUv || 0.01);
        const ok = maxAbs <= maxAbsUv && stdUv >= minStdUv;
        return {
            ok,
            reason: ok ? 'ok' : (maxAbs > maxAbsUv ? 'amplitude' : 'flatline'),
            validSamples: values.length,
            meanUv: mean,
            stdUv,
            rmsUv,
            crestFactor: rmsUv > 0 ? maxAbs / rmsUv : null,
            peakToPeakUv: max - min,
            maxAbsUv: maxAbs,
            ...spectralFeatures(values, options.sampleRateHz, options),
        };
    }

    function temporalFeatures(centerIndex, temporalContext) {
        const half = Math.floor(temporalContext / 2);
        const epochIndex = new Float32Array(temporalContext);
        const epochCycleIndex = new Float32Array(temporalContext * 5);
        const cycles = [10, 30, 60, 90, 120];
        for (let i = 0; i < temporalContext; i++) {
            const index = Math.max(0, centerIndex - half + i);
            epochIndex[i] = index / 1200;
            for (let j = 0; j < cycles.length; j++) {
                epochCycleIndex[i * cycles.length + j] = Math.cos(Math.PI * index / cycles[j]);
            }
        }
        return { epochIndex, epochCycleIndex };
    }

    function causalTemporalFeatures(latestIndex, temporalContext) {
        const epochIndex = new Float32Array(temporalContext);
        const epochCycleIndex = new Float32Array(temporalContext * 5);
        const cycles = [10, 30, 60, 90, 120];
        const firstIndex = latestIndex - temporalContext + 1;
        for (let i = 0; i < temporalContext; i++) {
            const index = Math.max(0, firstIndex + i);
            epochIndex[i] = index / 1200;
            for (let j = 0; j < cycles.length; j++) {
                epochCycleIndex[i * cycles.length + j] = Math.cos(Math.PI * index / cycles[j]);
            }
        }
        return { epochIndex, epochCycleIndex };
    }

    class RealtimeSleepPipeline {
        constructor(options = {}) {
            this.inputRateHz = Number(options.inputRateHz || 250);
            this.modelRateHz = Number(options.modelRateHz || 100);
            this.epochSeconds = Number(options.epochSeconds || 30);
            this.temporalContext = Number(options.temporalContext || 21);
            this.inputEpochLength = Math.round(this.inputRateHz * this.epochSeconds);
            this.modelEpochLength = Math.round(this.modelRateHz * this.epochSeconds);
            this.maxAbsUv = Number(options.maxAbsUv || 500);
            this.reset();
        }

        reset() {
            this.current = [];
            this.currentGapSamples = 0;
            this.epochs = [];
            this.qualities = [];
            this.totalEpochs = 0;
        }

        get progress() { return this.current.length / this.inputEpochLength; }

        push(sample, options = {}) {
            if (!Number.isFinite(sample)) return null;
            const gapSamples = Math.max(0, Math.min(32767, Math.floor(Number(options.seqGap) || 0)));
            if (gapSamples) {
                const fillValue = this.current.length ? this.current[this.current.length - 1] : Number(sample);
                for (let index = 0; index < gapSamples; index++) this.current.push(fillValue);
                this.currentGapSamples += gapSamples;
            }
            this.current.push(Number(sample));
            if (this.current.length < this.inputEpochLength) return null;
            const rawEpoch = this.current.splice(0, this.inputEpochLength);
            const epochGapSamples = this.currentGapSamples;
            this.currentGapSamples = 0;
            const quality = qualityMetrics(rawEpoch, { maxAbsUv: this.maxAbsUv, sampleRateHz: this.inputRateHz });
            if (epochGapSamples) {
                quality.ok = false;
                quality.reason = 'sample_gap';
                quality.gapSamples = epochGapSamples;
            }
            const modelEpoch = resampleForRate(rawEpoch, this.inputRateHz, this.modelRateHz, this.modelEpochLength);
            for (let index = 0; index < modelEpoch.length; index++) {
                modelEpoch[index] *= MILLIVOLTS_PER_MICROVOLT;
            }
            // A gap is represented by the original received samples plus a held value only
            // to keep epoch timing. Do not let that synthetic interval enter the next model
            // context; the next valid epoch starts a fresh causal context.
            if (epochGapSamples) {
                this.epochs = [];
                this.qualities = [];
                this.totalEpochs += 1;
                return { quality, totalEpochs: this.totalEpochs, ready: false, gapSamples: epochGapSamples };
            }
            this.epochs.push(modelEpoch);
            this.qualities.push(quality);
            if (this.epochs.length > this.temporalContext) this.epochs.shift();
            if (this.qualities.length > this.temporalContext) this.qualities.shift();
            this.totalEpochs += 1;
            return { quality, totalEpochs: this.totalEpochs, ready: this.epochs.length === this.temporalContext, gapSamples: 0 };
        }

        inferenceInput() {
            if (this.epochs.length !== this.temporalContext) return null;
            const eeg = new Float32Array(this.temporalContext * this.modelEpochLength);
            this.epochs.forEach((epoch, index) => eeg.set(epoch, index * this.modelEpochLength));
            const centerIndex = this.totalEpochs - Math.floor(this.temporalContext / 2) - 1;
            const features = temporalFeatures(centerIndex, this.temporalContext);
            return {
                eeg,
                epochIndex: features.epochIndex,
                epochCycleIndex: features.epochCycleIndex,
                temporalContext: this.temporalContext,
                windowLength: this.modelEpochLength,
                classifiedEpochIndex: centerIndex,
                outputIndex: Math.floor(this.temporalContext / 2),
                inferenceMode: 'center',
                modelDelayEpochs: Math.floor(this.temporalContext / 2),
                modelDelaySeconds: Math.floor(this.temporalContext / 2) * this.epochSeconds,
                controlEligible: false,
                centerQuality: this.qualities[Math.floor(this.temporalContext / 2)],
                targetQuality: this.qualities[Math.floor(this.temporalContext / 2)],
                historyEpochs: this.epochs.length,
            };
        }

        onlineInferenceInput() {
            if (!this.epochs.length) return null;
            const eeg = new Float32Array(this.temporalContext * this.modelEpochLength);
            const paddingCount = this.temporalContext - this.epochs.length;
            const earliestEpoch = this.epochs[0];
            for (let index = 0; index < paddingCount; index++) {
                eeg.set(earliestEpoch, index * this.modelEpochLength);
            }
            this.epochs.forEach((epoch, index) => {
                eeg.set(epoch, (paddingCount + index) * this.modelEpochLength);
            });
            const latestIndex = this.totalEpochs - 1;
            const features = causalTemporalFeatures(latestIndex, this.temporalContext);
            return {
                eeg,
                epochIndex: features.epochIndex,
                epochCycleIndex: features.epochCycleIndex,
                temporalContext: this.temporalContext,
                windowLength: this.modelEpochLength,
                classifiedEpochIndex: latestIndex,
                outputIndex: this.temporalContext - 1,
                inferenceMode: 'causal',
                modelDelayEpochs: 0,
                modelDelaySeconds: 0,
                // The currently exported model was trained with bidirectional
                // context; causal output is retained for diagnostics only.
                controlEligible: false,
                targetQuality: this.qualities[this.qualities.length - 1],
                historyEpochs: this.epochs.length,
            };
        }
    }

    return Object.freeze({
        STAGES,
        DEFAULT_STIMULUS_PROTOCOL,
        normalizeStimulusProtocol,
        validateStimulusProtocol,
        lightStimulusPresentation,
        SleepStageStimulusGate,
        resampleLinear,
        resampleForRate,
        qualityMetrics,
        spectralFeatures,
        temporalFeatures,
        causalTemporalFeatures,
        RealtimeSleepPipeline,
    });
}));
