'use strict';

const fs = require('node:fs');
const fsp = fs.promises;

const EDF_FIXED_HEADER_BYTES = 256;
const EDF_SIGNAL_HEADER_BYTES = 256;
const DIGITAL_MIN = -32768;
const DIGITAL_MAX = 32767;

function padAscii(value, length) {
    const text = String(value ?? '').replace(/[^\x20-\x7e]/g, '?');
    return `${text}${' '.repeat(length)}`.slice(0, length);
}

function pad2(value) { return String(value).padStart(2, '0'); }

function startDateTime(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const valid = Number.isNaN(date.getTime()) ? new Date() : date;
    return {
        date: `${pad2(valid.getDate())}.${pad2(valid.getMonth() + 1)}.${pad2(valid.getFullYear() % 100)}`,
        time: `${pad2(valid.getHours())}.${pad2(valid.getMinutes())}.${pad2(valid.getSeconds())}`,
    };
}

function numberField(value, length) {
    const text = String(value);
    if (text.length > length) throw new RangeError(`EDF header value does not fit in ${length} bytes: ${text}`);
    return padAscii(text, length);
}

function signalField(values, length) { return values.map(value => padAscii(value, length)).join(''); }

/** Build a single-channel EDF/EDF+ compatible header. */
function buildEdfHeader(options = {}) {
    const signalCount = Number(options.signalCount || 1);
    if (signalCount !== 1) throw new RangeError('The current EDF writer supports one selected EEG channel');
    const sampleRateHz = Number(options.sampleRateHz || 250);
    const samplesPerRecord = Number(options.samplesPerRecord || Math.round(sampleRateHz));
    const recordDurationSeconds = Number(options.recordDurationSeconds || 1);
    const physicalMinUv = Number(options.physicalMinUv ?? -187500);
    const physicalMaxUv = Number(options.physicalMaxUv ?? 187500);
    const { date, time } = startDateTime(options.startTime);
    const headerBytes = EDF_FIXED_HEADER_BYTES + signalCount * EDF_SIGNAL_HEADER_BYTES;
    const recordCount = Number.isInteger(options.numberDataRecords) ? options.numberDataRecords : -1;
    const fixed = [
        padAscii('0', 8),
        padAscii(options.patientId || 'X X X X', 80),
        padAscii(options.recordingId || 'Startdate X X X X', 80),
        padAscii(date, 8),
        padAscii(time, 8),
        numberField(headerBytes, 8),
        padAscii('EDF+C', 44),
        numberField(recordCount, 8),
        numberField(recordDurationSeconds, 8),
        numberField(signalCount, 4),
    ].join('');
    const signals = [
        signalField([options.label || 'EEG CH2'], 16),
        signalField([options.transducer || 'BrainLume ADS1299'], 80),
        signalField([options.physicalDimension || 'uV'], 8),
        signalField([physicalMinUv], 8),
        signalField([physicalMaxUv], 8),
        signalField([DIGITAL_MIN], 8),
        signalField([DIGITAL_MAX], 8),
        signalField([options.prefiltering || 'Raw ADC; no filtering'], 80),
        signalField([samplesPerRecord], 8),
        signalField([options.reserved || ''], 32),
    ].join('');
    const header = Buffer.from(`${fixed}${signals}`, 'ascii');
    if (header.length !== headerBytes) throw new Error(`Invalid EDF header length: ${header.length}`);
    return header;
}

function digitalFromMicrovolts(value, physicalMinUv, physicalMaxUv) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const bounded = Math.min(physicalMaxUv, Math.max(physicalMinUv, numeric));
    const fraction = (bounded - physicalMinUv) / (physicalMaxUv - physicalMinUv);
    return Math.max(DIGITAL_MIN, Math.min(DIGITAL_MAX, Math.round(DIGITAL_MIN + fraction * (DIGITAL_MAX - DIGITAL_MIN))));
}

function microvoltsFromDigital(value, physicalMinUv, physicalMaxUv) {
    return physicalMinUv + (Number(value) - DIGITAL_MIN) * (physicalMaxUv - physicalMinUv) / (DIGITAL_MAX - DIGITAL_MIN);
}

/**
 * Streaming EDF writer. Samples are the received raw selected-channel values in microvolts.
 * EDF data records are one second long; a final incomplete record is padded with its last
 * received value and the padded count is exposed to session.json.
 */
class EdfWriter {
    constructor(filePath, options = {}) {
        this.filePath = filePath;
        this.sampleRateHz = Number(options.sampleRateHz || 250);
        this.samplesPerRecord = Number(options.samplesPerRecord || Math.round(this.sampleRateHz));
        this.recordDurationSeconds = Number(options.recordDurationSeconds || 1);
        this.physicalMinUv = Number(options.physicalMinUv ?? -187500);
        this.physicalMaxUv = Number(options.physicalMaxUv ?? 187500);
        if (!(this.sampleRateHz > 0) || !Number.isInteger(this.samplesPerRecord) || this.samplesPerRecord <= 0) {
            throw new RangeError('Invalid EDF sample rate');
        }
        if (!(this.physicalMaxUv > this.physicalMinUv)) throw new RangeError('Invalid EDF physical range');
        this.headerBytes = EDF_FIXED_HEADER_BYTES + EDF_SIGNAL_HEADER_BYTES;
        this.dataRecordBytes = this.samplesPerRecord * 2;
        this.dataOffset = this.headerBytes;
        this.handle = null;
        this.pendingDigital = [];
        this.lastDigital = 0;
        this.records = 0;
        this.receivedSamples = 0;
        this.paddedSamples = 0;
        this._writeChain = Promise.resolve();
        this._closed = false;
        this.headerOptions = { ...options };
    }

    static async create(filePath, options = {}) {
        const writer = new EdfWriter(filePath, options);
        await writer.open();
        return writer;
    }

    async open() {
        if (this.handle) return this;
        await fsp.mkdir(require('node:path').dirname(this.filePath), { recursive: true });
        this.handle = await fsp.open(this.filePath, 'w+');
        const header = buildEdfHeader({
            ...this.headerOptions,
            sampleRateHz: this.sampleRateHz,
            samplesPerRecord: this.samplesPerRecord,
            recordDurationSeconds: this.recordDurationSeconds,
            physicalMinUv: this.physicalMinUv,
            physicalMaxUv: this.physicalMaxUv,
            numberDataRecords: -1,
        });
        await this.handle.write(header, 0, header.length, 0);
        return this;
    }

    enqueue(operation) {
        const result = this._writeChain.then(operation);
        this._writeChain = result.catch(() => {});
        return result;
    }

    appendSamples(samples) {
        return this.enqueue(async () => {
            if (this._closed) throw new Error('EDF writer is already closed');
            if (!this.handle) await this.open();
            for (const value of samples || []) {
                this.pendingDigital.push(digitalFromMicrovolts(value, this.physicalMinUv, this.physicalMaxUv));
                this.receivedSamples++;
            }
            const records = [];
            while (this.pendingDigital.length >= this.samplesPerRecord) {
                const values = this.pendingDigital.splice(0, this.samplesPerRecord);
                this.lastDigital = values[values.length - 1] ?? this.lastDigital;
                const record = Buffer.allocUnsafe(this.dataRecordBytes);
                values.forEach((value, index) => record.writeInt16LE(value, index * 2));
                records.push(record);
                this.records++;
            }
            if (records.length) {
                const data = Buffer.concat(records);
                await this.handle.write(data, 0, data.length, this.dataOffset + (this.records - records.length) * this.dataRecordBytes);
            }
            return { rows: this.receivedSamples, records: this.records };
        });
    }

    async finalize() {
        await this._writeChain;
        if (this._closed) return this.summary;
        if (!this.handle) await this.open();
        if (this.pendingDigital.length) {
            const padded = this.samplesPerRecord - this.pendingDigital.length;
            while (this.pendingDigital.length < this.samplesPerRecord) this.pendingDigital.push(this.lastDigital);
            const record = Buffer.allocUnsafe(this.dataRecordBytes);
            this.pendingDigital.forEach((value, index) => record.writeInt16LE(value, index * 2));
            await this.handle.write(record, 0, record.length, this.dataOffset + this.records * this.dataRecordBytes);
            this.records++;
            this.paddedSamples = padded;
            this.pendingDigital.length = 0;
        }
        const header = buildEdfHeader({
            ...this.headerOptions,
            sampleRateHz: this.sampleRateHz,
            samplesPerRecord: this.samplesPerRecord,
            recordDurationSeconds: this.recordDurationSeconds,
            physicalMinUv: this.physicalMinUv,
            physicalMaxUv: this.physicalMaxUv,
            numberDataRecords: this.records,
        });
        await this.handle.write(header, 0, header.length, 0);
        await this.handle.sync();
        await this.handle.close();
        this._closed = true;
        this.handle = null;
        return this.summary;
    }

    get summary() {
        return {
            path: this.filePath,
            records: this.records,
            receivedSamples: this.receivedSamples,
            paddedSamples: this.paddedSamples,
            sampleRateHz: this.sampleRateHz,
        };
    }
}

function parseEdfField(buffer, offset, length) {
    return buffer.toString('ascii', offset, offset + length).trim();
}

/** Read the first signal from a finalized EDF file into physical microvolts. */
async function readEdf(filePath, signalIndex = 0) {
    const buffer = await fsp.readFile(filePath);
    if (buffer.length < EDF_FIXED_HEADER_BYTES) throw new Error('EDF 文件头不完整');
    const headerBytes = Number.parseInt(parseEdfField(buffer, 184, 8), 10);
    const recordCountHeader = Number.parseInt(parseEdfField(buffer, 236, 8), 10);
    const recordDurationSeconds = Number.parseFloat(parseEdfField(buffer, 244, 8));
    const signalCount = Number.parseInt(parseEdfField(buffer, 252, 4), 10);
    if (!(headerBytes >= 256) || !(signalCount >= 1) || !(recordDurationSeconds > 0)) throw new Error('EDF 文件头参数无效');
    const signalHeaders = { labels: [], physicalMinUv: [], physicalMaxUv: [], digitalMin: [], digitalMax: [], samplesPerRecord: [] };
    let offset = 256;
    const readGroup = length => Array.from({ length: signalCount }, () => {
        const value = parseEdfField(buffer, offset, length);
        offset += length;
        return value;
    });
    signalHeaders.labels = readGroup(16);
    readGroup(80); // transducer
    readGroup(8); // physical dimension
    signalHeaders.physicalMinUv = readGroup(8).map(Number);
    signalHeaders.physicalMaxUv = readGroup(8).map(Number);
    signalHeaders.digitalMin = readGroup(8).map(Number);
    signalHeaders.digitalMax = readGroup(8).map(Number);
    readGroup(80); // prefiltering
    signalHeaders.samplesPerRecord = readGroup(8).map(value => Number.parseInt(value, 10));
    readGroup(32); // reserved
    const selected = Math.max(0, Math.min(signalCount - 1, Number(signalIndex) || 0));
    const samplesPerRecord = signalHeaders.samplesPerRecord[selected];
    const dataRecordBytes = signalHeaders.samplesPerRecord.reduce((sum, value) => sum + value * 2, 0);
    const availableRecords = Math.floor(Math.max(0, buffer.length - headerBytes) / dataRecordBytes);
    const recordCount = recordCountHeader >= 0 ? Math.min(recordCountHeader, availableRecords) : availableRecords;
    const values = new Float64Array(recordCount * samplesPerRecord);
    let cursor = headerBytes;
    let outputIndex = 0;
    for (let record = 0; record < recordCount; record++) {
        for (let signal = 0; signal < signalCount; signal++) {
            const count = signalHeaders.samplesPerRecord[signal];
            if (signal === selected) {
                const physicalMinUv = signalHeaders.physicalMinUv[signal];
                const physicalMaxUv = signalHeaders.physicalMaxUv[signal];
                const digitalMin = signalHeaders.digitalMin[signal];
                const digitalMax = signalHeaders.digitalMax[signal];
                for (let index = 0; index < count; index++) {
                    const digital = buffer.readInt16LE(cursor + index * 2);
                    values[outputIndex++] = physicalMinUv + (digital - digitalMin) * (physicalMaxUv - physicalMinUv) / (digitalMax - digitalMin);
                }
            }
            cursor += count * 2;
        }
    }
    return {
        values,
        sampleRateHz: samplesPerRecord / recordDurationSeconds,
        recordCount,
        samplesPerRecord,
        labels: signalHeaders.labels,
        physicalMinUv: signalHeaders.physicalMinUv[selected],
        physicalMaxUv: signalHeaders.physicalMaxUv[selected],
    };
}

module.exports = {
    EDF_FIXED_HEADER_BYTES,
    EDF_SIGNAL_HEADER_BYTES,
    DIGITAL_MIN,
    DIGITAL_MAX,
    buildEdfHeader,
    digitalFromMicrovolts,
    microvoltsFromDigital,
    EdfWriter,
    readEdf,
};
