'use strict';

const BAND_DEFINITIONS = Object.freeze([
    Object.freeze({ id: 'delta', label: 'Delta', lowHz: 0.5, highHz: 4 }),
    Object.freeze({ id: 'theta', label: 'Theta', lowHz: 4, highHz: 8 }),
    Object.freeze({ id: 'alpha', label: 'Alpha', lowHz: 8, highHz: 13 }),
    Object.freeze({ id: 'beta', label: 'Beta', lowHz: 13, highHz: 30 }),
    Object.freeze({ id: 'gamma', label: 'Gamma', lowHz: 30, highHz: 45 }),
    Object.freeze({ id: 'stimulus40', label: '39-41 Hz', lowHz: 39, highHz: 41 }),
]);

function parseCsvLine(line) {
    const fields = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < String(line).length; index++) {
        const character = line[index];
        if (quoted) {
            if (character === '"' && line[index + 1] === '"') { value += '"'; index++; }
            else if (character === '"') quoted = false;
            else value += character;
        } else if (character === '"') quoted = true;
        else if (character === ',') { fields.push(value); value = ''; }
        else value += character;
    }
    fields.push(value);
    return fields;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number(value)));
}

function finiteValues(values, maxSamples = Infinity) {
    const source = values || [];
    const stride = Math.max(1, Math.ceil(source.length / maxSamples));
    const output = [];
    for (let index = 0; index < source.length; index += stride) {
        const value = Number(source[index]);
        if (Number.isFinite(value)) output.push(value);
    }
    return output;
}

function percentile(values, quantile, maxSamples = 200000) {
    const sorted = finiteValues(values, maxSamples).sort((left, right) => left - right);
    if (!sorted.length) return 0;
    const position = clamp(quantile, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position);
    const fraction = position - lower;
    return sorted[lower] + (sorted[Math.min(sorted.length - 1, lower + 1)] - sorted[lower]) * fraction;
}

function rms(values) {
    let sum = 0;
    let count = 0;
    for (const raw of values || []) {
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        sum += value * value;
        count++;
    }
    return count ? Math.sqrt(sum / count) : 0;
}

function peakToPeak(values) {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const raw of values || []) {
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
    }
    return Number.isFinite(minimum) ? maximum - minimum : 0;
}

function robustRange(values, maxSamples = 200000) {
    return percentile(values, 0.99, maxSamples) - percentile(values, 0.01, maxSamples);
}

function biquadCoefficients(type, sampleRateHz, frequencyHz, q) {
    const omega = 2 * Math.PI * frequencyHz / sampleRateHz;
    const cosine = Math.cos(omega);
    const sine = Math.sin(omega);
    const alpha = sine / (2 * q);
    let b0, b1, b2;
    if (type === 'highpass') {
        b0 = (1 + cosine) / 2; b1 = -(1 + cosine); b2 = (1 + cosine) / 2;
    } else if (type === 'lowpass') {
        b0 = (1 - cosine) / 2; b1 = 1 - cosine; b2 = (1 - cosine) / 2;
    } else if (type === 'notch') {
        b0 = 1; b1 = -2 * cosine; b2 = 1;
    } else throw new RangeError(`Unsupported biquad type: ${type}`);
    const a0 = 1 + alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0 };
}

function displayFilterChain(sampleRateHz) {
    return [
        biquadCoefficients('highpass', sampleRateHz, 0.5, Math.SQRT1_2),
        biquadCoefficients('lowpass', sampleRateHz, 45, 0.5411961),
        biquadCoefficients('lowpass', sampleRateHz, 45, 1.306563),
        biquadCoefficients('notch', sampleRateHz, 50, 30),
    ];
}

function filterPass(input, coefficients, reverse = false) {
    const output = new Float64Array(input.length);
    if (!input.length) return output;
    let x1 = input[reverse ? input.length - 1 : 0];
    let x2 = x1;
    const dcGain = (coefficients.b0 + coefficients.b1 + coefficients.b2)
        / (1 + coefficients.a1 + coefficients.a2);
    let y1 = Number.isFinite(dcGain) ? x1 * dcGain : 0;
    let y2 = y1;
    const start = reverse ? input.length - 1 : 0;
    const end = reverse ? -1 : input.length;
    const step = reverse ? -1 : 1;
    for (let index = start; index !== end; index += step) {
        const x0 = Number.isFinite(input[index]) ? input[index] : 0;
        const y0 = coefficients.b0 * x0 + coefficients.b1 * x1 + coefficients.b2 * x2
            - coefficients.a1 * y1 - coefficients.a2 * y2;
        output[index] = Number.isFinite(y0) ? y0 : 0;
        x2 = x1; x1 = x0; y2 = y1; y1 = output[index];
    }
    return output;
}

function zeroPhaseFilter(signal, sampleRateHz = 250) {
    const source = Float64Array.from(signal || [], value => Number.isFinite(Number(value)) ? Number(value) : 0);
    if (source.length < 8) return source;
    const padding = Math.min(source.length - 1, Math.max(12, Math.round(sampleRateHz * 2)));
    let values = new Float64Array(source.length + padding * 2);
    for (let index = 0; index < padding; index++) {
        values[index] = 2 * source[0] - source[Math.min(source.length - 1, padding - index)];
        values[padding + source.length + index] = 2 * source[source.length - 1]
            - source[Math.max(0, source.length - 2 - index)];
    }
    values.set(source, padding);
    const chain = displayFilterChain(sampleRateHz);
    for (const coefficients of chain) values = filterPass(values, coefficients, false);
    for (let index = chain.length - 1; index >= 0; index--) values = filterPass(values, chain[index], true);
    return values.slice(padding, padding + source.length);
}

function nextPowerOfTwo(value) {
    let output = 1;
    while (output < value) output <<= 1;
    return output;
}

function fftPower(signal, sampleRateHz) {
    const size = nextPowerOfTwo(signal.length);
    const real = new Float64Array(size);
    const imaginary = new Float64Array(size);
    let mean = 0;
    for (const value of signal) mean += value;
    mean /= Math.max(1, signal.length);
    let windowPower = 0;
    for (let index = 0; index < signal.length; index++) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, signal.length - 1));
        real[index] = (signal[index] - mean) * window;
        windowPower += window * window;
    }
    for (let index = 1, reversed = 0; index < size; index++) {
        let bit = size >> 1;
        for (; reversed & bit; bit >>= 1) reversed ^= bit;
        reversed ^= bit;
        if (index < reversed) [real[index], real[reversed]] = [real[reversed], real[index]];
    }
    for (let length = 2; length <= size; length <<= 1) {
        const angle = -2 * Math.PI / length;
        const stepReal = Math.cos(angle);
        const stepImaginary = Math.sin(angle);
        for (let start = 0; start < size; start += length) {
            let twiddleReal = 1;
            let twiddleImaginary = 0;
            for (let offset = 0; offset < length / 2; offset++) {
                const even = start + offset;
                const odd = even + length / 2;
                const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
                const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
                real[odd] = real[even] - oddReal;
                imaginary[odd] = imaginary[even] - oddImaginary;
                real[even] += oddReal;
                imaginary[even] += oddImaginary;
                const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
                twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
                twiddleReal = nextReal;
            }
        }
    }
    const bins = Math.floor(size / 2) + 1;
    const power = new Float64Array(bins);
    const scale = Math.max(Number.EPSILON, sampleRateHz * windowPower);
    for (let index = 0; index < bins; index++) {
        power[index] = (real[index] ** 2 + imaginary[index] ** 2) / scale;
        if (index > 0 && index < bins - 1) power[index] *= 2;
    }
    return { power, binHz: sampleRateHz / size };
}

function welchPsd(signal, sampleRateHz = 250, options = {}) {
    const source = signal || [];
    const segmentSize = Math.min(options.segmentSize || 2048, nextPowerOfTwo(Math.max(8, source.length)));
    if (source.length < 8) return { frequencies: [], power: [], binHz: sampleRateHz / segmentSize };
    const hop = Math.max(1, Math.floor(segmentSize / 2));
    const starts = [];
    for (let start = 0; start + segmentSize <= source.length; start += hop) starts.push(start);
    if (!starts.length) starts.push(0);
    const maxSegments = options.maxSegments || 240;
    const stride = Math.max(1, Math.ceil(starts.length / maxSegments));
    let accumulated = null;
    let count = 0;
    let binHz = 0;
    for (let item = 0; item < starts.length; item += stride) {
        const chunk = Float64Array.from({ length: Math.min(segmentSize, source.length - starts[item]) }, (_, index) => source[starts[item] + index]);
        const spectrum = fftPower(chunk, sampleRateHz);
        if (!accumulated) accumulated = new Float64Array(spectrum.power.length);
        for (let index = 0; index < accumulated.length; index++) accumulated[index] += spectrum.power[index];
        binHz = spectrum.binHz;
        count++;
    }
    if (!accumulated) return { frequencies: [], power: [], binHz: 0 };
    for (let index = 0; index < accumulated.length; index++) accumulated[index] /= count;
    return {
        frequencies: Array.from(accumulated, (_value, index) => index * binHz),
        power: Array.from(accumulated),
        binHz,
    };
}

function spectrogram(signal, sampleRateHz = 250, options = {}) {
    const source = signal || [];
    const windowSeconds = clamp(Number(options.windowSeconds) || 2, 0.5, 8);
    const requestedWindow = Math.max(8, Math.round(windowSeconds * sampleRateHz));
    const windowSamples = Math.min(source.length, requestedWindow);
    const overlap = clamp(Number(options.overlap ?? 0.75), 0, 0.95);
    const hopSamples = Math.max(1, Math.round(windowSamples * (1 - overlap)));
    const maxHz = clamp(Number(options.maxHz) || 45, 1, sampleRateHz / 2);
    const maxTimeBins = Math.max(20, Math.min(1200, Number(options.maxTimeBins) || 720));
    if (windowSamples < 8) return { times: [], frequencies: [], powerDb: [], timeBins: 0, frequencyBins: 0, windowSamples, hopSamples, windowSeconds, maxHz };
    const starts = [];
    for (let start = 0; start + windowSamples <= source.length; start += hopSamples) starts.push(start);
    if (!starts.length) starts.push(0);
    const stride = Math.max(1, Math.ceil(starts.length / maxTimeBins));
    const selectedStarts = starts.filter((_start, index) => index % stride === 0);
    const first = fftPower(source.subarray ? source.subarray(selectedStarts[0], selectedStarts[0] + windowSamples) : source.slice(selectedStarts[0], selectedStarts[0] + windowSamples), sampleRateHz);
    const frequencyBins = Math.min(first.power.length, Math.floor(maxHz / first.binHz) + 1);
    const frequencies = Array.from({ length: frequencyBins }, (_value, index) => index * first.binHz);
    const times = [];
    const powerDb = [];
    for (const start of selectedStarts) {
        const chunk = source.subarray ? source.subarray(start, start + windowSamples) : source.slice(start, start + windowSamples);
        const spectrum = fftPower(chunk, sampleRateHz);
        times.push((start + windowSamples / 2) / sampleRateHz);
        for (let frequencyIndex = 0; frequencyIndex < frequencyBins; frequencyIndex++) {
            powerDb.push(10 * Math.log10(Math.max(Number.EPSILON, spectrum.power[frequencyIndex])));
        }
    }
    const ordered = powerDb.filter(Number.isFinite).sort((a, b) => a - b);
    const pick = quantile => ordered.length ? ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * quantile))] : 0;
    let colorMinDb = pick(0.05);
    let colorMaxDb = pick(0.95);
    if (colorMaxDb - colorMinDb < 1) { colorMinDb -= 0.5; colorMaxDb += 0.5; }
    return {
        times, frequencies, powerDb, timeBins: times.length, frequencyBins,
        windowSamples, hopSamples, windowSeconds: windowSamples / sampleRateHz,
        maxHz, colorMinDb, colorMaxDb,
    };
}

function bandPowers(psd) {
    const output = {};
    const total = integrateBand(psd, 0.5, 45);
    for (const band of BAND_DEFINITIONS) {
        const absolute = integrateBand(psd, band.lowHz, band.highHz);
        output[band.id] = { label: band.label, absolute, relativePercent: total > 0 ? absolute / total * 100 : 0 };
    }
    return output;
}

function integrateBand(psd, lowHz, highHz) {
    let total = 0;
    for (let index = 0; index < psd.power.length; index++) {
        const frequency = psd.frequencies[index];
        if (frequency >= lowHz && frequency < highHz) total += psd.power[index] * psd.binHz;
    }
    return total;
}

function toneRms(signal, sampleRateHz, frequencyHz) {
    const source = signal || [];
    if (!source.length) return 0;
    let cosine = 0;
    let sine = 0;
    let mean = 0;
    for (const value of source) mean += value;
    mean /= source.length;
    for (let index = 0; index < source.length; index++) {
        const angle = 2 * Math.PI * frequencyHz * index / sampleRateHz;
        const value = source[index] - mean;
        cosine += value * Math.cos(angle);
        sine += value * Math.sin(angle);
    }
    const peak = 2 * Math.hypot(cosine, sine) / source.length;
    return peak / Math.sqrt(2);
}

function pairLightEvents(events, durationSeconds) {
    const active = new Map();
    const segments = [];
    const warnings = [];
    const origin = events.find(event => event.action === 'session_started')?.ts || events[0]?.ts;
    const originMs = Date.parse(origin || 0);
    const secondsFor = event => Math.max(0, (Date.parse(event.ts) - originMs) / 1000);
    for (const event of events) {
        const channel = Number(event.channel || 1);
        if (event.action === 'light_started') active.set(channel, event);
        if (event.action === 'light_stopped') {
            const start = active.get(channel);
            if (!start) { warnings.push(`光刺激 CH${channel} 有停止事件但没有开始事件`); continue; }
            const startSec = clamp(secondsFor(start), 0, durationSeconds);
            const endSec = clamp(secondsFor(event), startSec, durationSeconds);
            const length = Math.max(1 / 250, endSec - startSec);
            segments.push({
                id: `light-${channel}-${segments.length + 1}`,
                channel,
                startSec,
                endSec,
                preStartSec: Math.max(0, startSec - length),
                postEndSec: Math.min(durationSeconds, endSec + length),
                source: 'event-log',
            });
            active.delete(channel);
        }
    }
    for (const [channel] of active) warnings.push(`光刺激 CH${channel} 缺少停止事件，请手工设置结束时间`);
    return { segments, warnings };
}

function validateSegments(segments, durationSeconds) {
    return (segments || []).map((segment, index) => {
        const startSec = clamp(segment.startSec, 0, durationSeconds);
        const endSec = clamp(segment.endSec, startSec, durationSeconds);
        return {
            id: String(segment.id || `manual-${index + 1}`),
            channel: clamp(Math.round(segment.channel || 1), 1, 2),
            preStartSec: clamp(segment.preStartSec, 0, startSec),
            startSec,
            endSec,
            postEndSec: clamp(segment.postEndSec, endSec, durationSeconds),
            source: segment.source === 'event-log' ? 'event-log' : 'manual',
        };
    }).filter(segment => segment.endSec > segment.startSec);
}

function createViewport(values, startSample, endSample, pixelWidth) {
    const start = clamp(Math.floor(startSample), 0, Math.max(0, values.length - 1));
    const end = clamp(Math.ceil(endSample), start + 1, values.length);
    const count = end - start;
    const width = clamp(Math.round(pixelWidth), 1, 10000);
    let minimum = Infinity;
    let maximum = -Infinity;
    if (count <= width * 1.25) {
        const samples = [];
        for (let index = start; index < end; index++) {
            const value = values[index];
            samples.push(value);
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
        }
        return { mode: 'line', startSample: start, endSample: end, samples, minimum, maximum };
    }
    const lows = [];
    const highs = [];
    for (let pixel = 0; pixel < width; pixel++) {
        const bucketStart = start + Math.floor(pixel * count / width);
        const bucketEnd = Math.min(end, start + Math.ceil((pixel + 1) * count / width));
        let low = Infinity;
        let high = -Infinity;
        for (let index = bucketStart; index < bucketEnd; index++) {
            const value = values[index];
            if (!Number.isFinite(value)) continue;
            low = Math.min(low, value);
            high = Math.max(high, value);
        }
        if (!Number.isFinite(low)) low = high = 0;
        lows.push(low); highs.push(high);
        minimum = Math.min(minimum, low); maximum = Math.max(maximum, high);
    }
    return { mode: 'envelope', startSample: start, endSample: end, lows, highs, minimum, maximum };
}

module.exports = {
    BAND_DEFINITIONS, parseCsvLine, clamp, percentile, rms, peakToPeak, robustRange,
    zeroPhaseFilter, welchPsd, spectrogram, bandPowers, toneRms, pairLightEvents, validateSegments, createViewport,
};
