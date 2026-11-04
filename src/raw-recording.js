'use strict';
// Each 16-byte record: int32 LE ADC code, uint16 LE sequence,
// uint16 reserved, float64 LE monotonic receive time (ms since session start).
const RECORD_BYTES = 16;
function encodeRawRecords(samples) {
    const bytes = Buffer.alloc(samples.length * RECORD_BYTES);
    samples.forEach((s, i) => {
        if (!Number.isInteger(s.rawCode) || s.rawCode < -8388608 || s.rawCode > 8388607
            || !Number.isInteger(s.seq) || s.seq < 0 || s.seq > 65535
            || !Number.isFinite(s.elapsedMs) || s.elapsedMs < 0) throw new Error('Invalid raw ADC record');
        const p = i * RECORD_BYTES;
        bytes.writeInt32LE(s.rawCode, p);
        bytes.writeUInt16LE(s.seq, p + 4);
        bytes.writeDoubleLE(s.elapsedMs, p + 8);
    });
    return bytes;
}
function decodeRawRecords(bytes, { vrefVolts = 4.5, gain = 24 } = {}) {
    if (bytes.length % RECORD_BYTES) throw new Error('Truncated raw ADC recording');
    if (!(vrefVolts > 0 && gain > 0)) throw new Error('Invalid ADC scale');
    const n = bytes.length / RECORD_BYTES;
    const values = new Float64Array(n), rawCodes = new Int32Array(n), sequences = new Uint16Array(n), elapsedMs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const p = i * RECORD_BYTES;
        rawCodes[i] = bytes.readInt32LE(p);
        sequences[i] = bytes.readUInt16LE(p + 4);
        elapsedMs[i] = bytes.readDoubleLE(p + 8);
        if (rawCodes[i] < -8388608 || rawCodes[i] > 8388607 || !Number.isFinite(elapsedMs[i]) || elapsedMs[i] < 0) throw new Error('Invalid raw ADC record');
        values[i] = rawCodes[i] * vrefVolts * 1e6 / (gain * 8388608);
    }
    return { values, rawCodes, sequences, elapsedMs };
}
module.exports = { RECORD_BYTES, encodeRawRecords, decodeRawRecords };
