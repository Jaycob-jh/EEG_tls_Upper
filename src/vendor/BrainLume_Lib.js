/**
 * BrainLume JavaScript SDK
 *
 * 设计目标：
 * 1. 本文件是 SDK 的唯一运行时文件，不依赖 Electron、Web Bluetooth 或 SerialPort。
 * 2. 上层只需要实现 Transport.write()/onData()/isConnected() 即可接入任意传输链路。
 * 3. 协议、设备命令和信号算法都可以脱离硬件，以纯函数方式单独测试。
 *
 * 模块加载方式：
 * - 浏览器 <script>：挂载到 globalThis.BrainLume。
 * - Node.js CommonJS：通过 module.exports 导出。
 * - Node.js ESM：把 CommonJS 对象作为 default import 使用。
 *
 * ActionBus 帧格式：
 * AA 55 | Addr | Func | Stat | Len | Data... | CRC_H | CRC_L
 * CRC 计算范围从 Addr 开始，到 Data 最后一个字节结束。
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BrainLume = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VERSION = '1.0.3';

    // ---------------------------------------------------------------------
    // 常量和设备协议枚举
    // ---------------------------------------------------------------------

    // 固定帧头。解析器会利用这两个字节从噪声或半帧中重新同步。
    const HEADER_A = 0xAA;
    const HEADER_B = 0x55;

    // ADS1299 是 24 位补码 ADC。正满量程换算分母使用 2^23，而不是 2^24。
    const ADC_FULL_SCALE_CODES = 0x800000;

    // 当前两套滤波预设都有对应系数或动态设计支持的采样率。
    const SUPPORTED_SAMPLE_RATES = Object.freeze([125, 250, 500, 1000, 2000]);
    const LEGACY_FILTER_PRESET = 'eeg-data-analyse';
    const DISPLAY_FILTER_PRESET = 'eeg-display-0p5-45';
    const MODEL_TRAINING_FILTER_PRESET = 'eeg-model-training-0p4-18';

    /** BrainLume 当前使用的 ActionBus 功能码。 */
    const FUNC = Object.freeze({
        STATUS: 0x01,
        INDICATOR_CONTROL: 0x02,
        LIGHT1_CONFIG: 0x10,
        LIGHT2_CONFIG: 0x11,
        LIGHT1_CONTROL: 0x12,
        LIGHT2_CONTROL: 0x13,
        EEG_CONFIG: 0x20,
        EEG_CONTROL: 0x21,
        EEG_RAW: 0x22,
        EEG_REGISTERS: 0x23,
        PROTOCOL_QUERY: 0xF0,
        ACTION_DESCRIPTION: 0xFE,
    });
    // Stat.bit4=1 表示主机发起；bit0=1 表示启动/运行；bit7=1 表示错误。
    const STAT = Object.freeze({ DEVICE_OK: 0x00, DEVICE_RUNNING: 0x01, HOST_QUERY: 0x10, HOST_START: 0x11, ERROR: 0x80 });
    const PROTOCOL_QUERY = Object.freeze({ VERSION: 0x00, DEVICE_ID: 0x01, ACTION_COUNT: 0x02, UPTIME: 0x03, ADDRESS: 0x04 });
    const DEVICE_ERROR = Object.freeze({
        0x00: 'No error', 0x01: 'Invalid parameter', 0x02: 'Invalid length or payload',
        0x03: 'Not supported', 0x04: 'Wrong state', 0x05: 'Busy', 0x06: 'Internal error',
        0x07: 'Permission denied', 0x08: 'Timeout', 0x09: 'CRC error',
    });
    // 数组索引就是 ADS1299 寄存器地址，可直接用于 0x23 返回的 31 字节表。
    const ADS1299_REGISTER_NAMES = Object.freeze([
        'ID', 'CONFIG1', 'CONFIG2', 'CONFIG3', 'LOFF', 'CH1SET', 'CH2SET', 'CH3SET', 'CH4SET',
        'CH5SET', 'CH6SET', 'CH7SET', 'CH8SET', 'BIAS_SENSP', 'BIAS_SENSN', 'LOFF_SENSP',
        'LOFF_SENSN', 'LOFF_FLIP', 'LOFF_STATP', 'LOFF_STATN', 'GPIO', 'MISC1', 'MISC2', 'CONFIG4',
        'reg_0x18', 'reg_0x19', 'reg_0x1A', 'reg_0x1B', 'reg_0x1C', 'reg_0x1D', 'reg_0x1E',
    ]);
    const ADS1299_CONFIG_REGISTERS = Object.freeze([
        ...Array.from({ length: 0x12 - 0x01 }, (_, index) => index + 0x01),
        ...Array.from({ length: 0x17 - 0x14 + 1 }, (_, index) => index + 0x14),
    ]);
    const ADS1299_GAINS = Object.freeze([1, 2, 4, 6, 8, 12, 24, null]);
    const LOFF_CURRENTS_AMPS = Object.freeze([6e-9, 24e-9, 6e-6, 24e-6]);

    // ---------------------------------------------------------------------
    // 字节和整数基础工具
    // ---------------------------------------------------------------------

    /**
     * 将调用方常见的二进制容器统一为 Uint8Array。
     *
     * TypedArray/DataView 输入只创建同一底层内存的字节视图；普通 Array 会复制并逐项
     * 校验为 0..255。公开 API 在需要保存数据时会再调用 slice()，避免外部后续修改。
     *
     * @param {Uint8Array|ArrayBuffer|ArrayBufferView|number[]} value 输入数据。
     * @param {string} name 错误信息中使用的参数名。
     * @returns {Uint8Array}
     */
    function toBytes(value, name = 'bytes') {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (Array.isArray(value)) return Uint8Array.from(value.map((item, index) => assertByte(item, `${name}[${index}]`)));
        throw new TypeError(`${name} must be an Array, ArrayBuffer, or Uint8Array`);
    }

    /** 严格整数校验。SDK 不对硬件参数做静默钳制。 */
    function assertInteger(value, min, max, name) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < min || number > max) {
            throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
        }
        return number;
    }

    function assertByte(value, name = 'value') { return assertInteger(value, 0, 0xFF, name); }
    function assertChannel(channel) { return assertInteger(channel, 1, 2, 'channel'); }

    /**
     * 从字节流读取指定端序和位宽的整数。
     *
     * int24be 使用手动符号扩展：若 bit23 为 1，则把 JavaScript 32 位整数的高 8 位
     * 全部补 1。该格式正是 0x22 中每路 ADS1299 原始采样的编码。
     *
     * @param {Uint8Array|number[]} bytes 数据源。
     * @param {number} offset 起始字节偏移。
     * @param {'uint8'|'int8'|'uint16le'|'uint16be'|'int16le'|'int16be'|'uint24be'|'int24be'|'uint32le'|'uint32be'|'int32le'|'int32be'} type 数值格式。
     * @returns {number}
     */
    function readValue(bytes, offset, type = 'uint8') {
        const data = toBytes(bytes);
        const at = assertInteger(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
        const need = { uint8: 1, int8: 1, uint16le: 2, uint16be: 2, int16le: 2, int16be: 2,
            uint24be: 3, int24be: 3, uint32le: 4, uint32be: 4, int32le: 4, int32be: 4 }[type];
        if (!need) throw new RangeError(`Unsupported numeric type: ${type}`);
        if (at + need > data.length) throw new RangeError(`${type} at offset ${at} exceeds ${data.length} bytes`);
        const b0 = data[at]; const b1 = data[at + 1]; const b2 = data[at + 2]; const b3 = data[at + 3];
        switch (type) {
        case 'uint8': return b0;
        case 'int8': return b0 & 0x80 ? b0 - 0x100 : b0;
        case 'uint16le': return b0 | (b1 << 8);
        case 'uint16be': return (b0 << 8) | b1;
        case 'int16le': { const v = b0 | (b1 << 8); return v & 0x8000 ? v - 0x10000 : v; }
        case 'int16be': { const v = (b0 << 8) | b1; return v & 0x8000 ? v - 0x10000 : v; }
        case 'uint24be': return (b0 << 16) | (b1 << 8) | b2;
        case 'int24be': { let v = (b0 << 16) | (b1 << 8) | b2; if (v & 0x800000) v |= 0xFF000000; return v | 0; }
        case 'uint32be': return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
        case 'uint32le': return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
        case 'int32be': return (b0 << 24) | (b1 << 16) | (b2 << 8) | b3;
        case 'int32le': return (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
        default: return 0;
        }
    }

    // ---------------------------------------------------------------------
    // ActionBus 帧编解码
    // ---------------------------------------------------------------------

    /**
     * CRC-16/MODBUS：初值 0xFFFF，反射多项式 0xA001。
     *
     * 注意：标准 MODBUS 在线路上通常低字节先发，但 ActionBus 帧约定 CRC_H 在前、
     * CRC_L 在后。这个函数只返回 16 位数值，字节发送顺序由 buildFrame() 决定。
     */
    function crc16Modbus(bytes) {
        let crc = 0xFFFF;
        for (const byte of toBytes(bytes)) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
        }
        return crc & 0xFFFF;
    }

    /**
     * 构造一帧完整 ActionBus 数据。
     *
     * @param {number} address 从机地址，BrainLume 默认 0x01。
     * @param {number} func 功能码。
     * @param {number} stat 状态/方向字段。
     * @param {Uint8Array|number[]} payload Data 字段，最大 255 字节。
     * @returns {Uint8Array} 包含帧头和 CRC 的完整发送数据。
     */
    function buildFrame(address, func, stat, payload = []) {
        const addr = assertByte(address, 'address');
        const functionCode = assertByte(func, 'func');
        const status = assertByte(stat, 'stat');
        const data = toBytes(payload, 'payload');
        if (data.length > 0xFF) throw new RangeError('payload cannot exceed 255 bytes');
        const body = Uint8Array.from([addr, functionCode, status, data.length, ...data]);
        const crc = crc16Modbus(body);
        return Uint8Array.from([HEADER_A, HEADER_B, ...body, crc >>> 8, crc & 0xFF]);
    }

    /**
     * 校验并解析一帧已经完整切分的数据。
     *
     * 此函数不处理粘包和分包；流式数据应交给 ActionBusParser.feed()。长度或帧头错误
     * 抛 ProtocolError，CRC 错误抛 CrcError，调用方可以据此区分链路噪声和业务错误。
     */
    function parseFrame(rawFrame) {
        const raw = toBytes(rawFrame, 'frame');
        if (raw.length < 8 || raw[0] !== HEADER_A || raw[1] !== HEADER_B) throw new ProtocolError('Invalid ActionBus header');
        const expectedLength = 8 + raw[5];
        if (raw.length !== expectedLength) throw new ProtocolError(`Invalid frame length: ${raw.length}/${expectedLength}`);
        const expectedCrc = (raw[raw.length - 2] << 8) | raw[raw.length - 1];
        const actualCrc = crc16Modbus(raw.subarray(2, raw.length - 2));
        if (actualCrc !== expectedCrc) throw new CrcError(expectedCrc, actualCrc, raw);
        return Object.freeze({
            raw: raw.slice(), addr: raw[2], func: raw[3], stat: raw[4], len: raw[5],
            data: raw.slice(6, raw.length - 2), crc: actualCrc,
        });
    }

    /** ActionBus 帧结构不合法。 */
    class ProtocolError extends Error { constructor(message) { super(message); this.name = 'ProtocolError'; } }
    /** CRC 字段与重新计算结果不一致。 */
    class CrcError extends ProtocolError {
        constructor(expected, actual, raw) {
            super(`CRC mismatch: received 0x${expected.toString(16).padStart(4, '0')}, calculated 0x${actual.toString(16).padStart(4, '0')}`);
            this.name = 'CrcError'; this.expected = expected; this.actual = actual; this.raw = raw.slice();
        }
    }
    /** 下位机通过 Stat.bit7 返回的业务错误。错误码取响应 Data[0]。 */
    class DeviceError extends Error {
        constructor(frame, request = null) {
            const code = frame.data[0] ?? 0;
            super(`Device error 0x${code.toString(16).padStart(2, '0')}: ${DEVICE_ERROR[code] || 'Unknown error'}`);
            this.name = 'DeviceError'; this.code = code; this.frame = frame; this.request = request;
            this.addr = frame.addr; this.func = frame.func; this.stat = frame.stat; this.len = frame.len;
            this.data = frame.data.slice();
        }
    }
    /** 命令在 timeoutMs 内没有收到匹配响应。 */
    class TimeoutError extends Error { constructor(message) { super(message); this.name = 'TimeoutError'; } }

    /**
     * 增量 ActionBus 字节流解析器。
     *
     * feed() 可以接收任意大小的 BLE notify 或串口 chunk。内部缓冲会：
     * 1. 搜索 AA 55 帧头并丢弃前置噪声；
     * 2. 根据 Len 等待完整帧；
     * 3. 校验 CRC 后输出帧；
     * 4. 帧损坏时只丢一个字节，再次搜索帧头，避免把后续正常帧一起丢弃。
     */
    class ActionBusParser {
        constructor(options = {}) { this.buffer = []; this.onError = typeof options.onError === 'function' ? options.onError : null; }
        reset() { this.buffer.length = 0; }
        feed(chunk) {
            this.buffer.push(...toBytes(chunk, 'chunk'));
            const frames = [];
            while (this.buffer.length >= 2) {
                let header = -1;
                for (let i = 0; i + 1 < this.buffer.length; i++) {
                    if (this.buffer[i] === HEADER_A && this.buffer[i + 1] === HEADER_B) { header = i; break; }
                }
                if (header < 0) { this.buffer.splice(0, Math.max(0, this.buffer.length - 1)); break; }
                if (header > 0) this.buffer.splice(0, header);
                if (this.buffer.length < 6) break;
                const total = 8 + this.buffer[5];
                if (this.buffer.length < total) {
                    // Recover only at a complete CRC-verified boundary; a header
                    // by itself can occur inside a fragmented EEG payload.
                    let recovered = -1;
                    for (let i = 1; i + 8 <= this.buffer.length; i++) {
                        if (this.buffer[i] !== HEADER_A || this.buffer[i + 1] !== HEADER_B) continue;
                        const nextLength = 8 + this.buffer[i + 5];
                        if (i + nextLength > this.buffer.length) continue;
                        try { parseFrame(Uint8Array.from(this.buffer.slice(i, i + nextLength))); recovered = i; break; }
                        catch { /* keep searching */ }
                    }
                    if (recovered < 0) break;
                    if (this.onError) this.onError(new ProtocolError(`Recovered framing after ${recovered} bytes with invalid/incomplete length`));
                    this.buffer.splice(0, recovered);
                    continue;
                }
                const candidate = Uint8Array.from(this.buffer.slice(0, total));
                try {
                    frames.push(parseFrame(candidate));
                    this.buffer.splice(0, total);
                } catch (error) {
                    if (this.onError) this.onError(error);
                    this.buffer.shift();
                }
            }
            return frames;
        }
    }

    // ---------------------------------------------------------------------
    // 纯命令构造器
    // ---------------------------------------------------------------------

    /**
     * 创建尚未编码的命令对象。命令对象适合测试、日志和二次修改；真正发送前再通过
     * encodeCommand() 增加帧头、Len 与 CRC。
     */
    function command(address, func, stat, data = []) {
        return Object.freeze({ addr: assertByte(address, 'address'), func: assertByte(func, 'func'),
            stat: assertByte(stat, 'stat'), data: toBytes(data, 'data').slice() });
    }
    /** 将命令对象编码为完整 ActionBus 帧。 */
    function encodeCommand(value) { return buildFrame(value.addr, value.func, value.stat, value.data); }
    function uint32be(value, name) {
        const n = assertInteger(value, 0, 0xFFFFFFFF, name);
        return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
    }
    /**
     * 光刺激配置 Data 布局：
     * [0] frequencyHz, [1..4] durationMs(uint32 BE), [5] powerPercent。
     * durationMs=0 表示不限时；频率和功率严格检查，不自动修改调用方参数。
     */
    function lightConfigData(options = {}) {
        const frequencyHz = assertInteger(options.frequencyHz, 1, 100, 'frequencyHz');
        const durationMs = assertInteger(options.durationMs, 0, 0xFFFFFFFF, 'durationMs');
        const powerPercent = assertInteger(options.powerPercent, 0, 100, 'powerPercent');
        return Uint8Array.from([frequencyHz, ...uint32be(durationMs, 'durationMs'), powerPercent]);
    }

    /**
     * 将 ADS1299 配置规范化为寄存器 0x01..0x1E 的 30 字节 Data。
     *
     * 可接受：
     * - 30 字节：已经是 0x01..0x1E，直接复制；
     * - 31 字节：认为包含 0x00 ID，自动去掉第一个字节；
     * - 对象：必须完整给出每个地址，可用 CONFIG1、0x01 或 reg_0x01 等键名。
     */
    function normalizeAdsConfig(input) {
        if (input instanceof Uint8Array || Array.isArray(input) || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
            const bytes = toBytes(input, 'registers');
            if (bytes.length === 30) return bytes.slice();
            if (bytes.length === 31) return bytes.slice(1);
            throw new RangeError(`ADS1299 config must contain registers 0x01..0x1E (30 bytes), got ${bytes.length}`);
        }
        if (!input || typeof input !== 'object') throw new TypeError('registers must be a byte array or register object');
        const output = new Uint8Array(30);
        for (let address = 1; address <= 0x1E; address++) {
            const hex = address.toString(16).padStart(2, '0').toUpperCase();
            const name = ADS1299_REGISTER_NAMES[address];
            const candidates = [address, String(address), `0x${hex}`, `reg_0x${hex}`, name];
            let found;
            for (const key of candidates) if (Object.prototype.hasOwnProperty.call(input, key)) { found = input[key]; break; }
            if (found == null) throw new RangeError(`Missing ADS1299 register 0x${hex} (${name})`);
            output[address - 1] = assertByte(found, `register 0x${hex}`);
        }
        return output;
    }

    /**
     * 把通道选择转换为 CH1..CH8 的 bit mask。
     *
     * 支持三种写法：
     * - 不传：8 路全部启用；
     * - 传整数：直接作为 bit0..bit7 mask；
     * - 传数组：`[1, 3, 8]` 表示通道编号，或 `[true, false, ...]` 表示 8 路开关。
     */
    function normalizeEnabledChannelMask(channels) {
        if (channels == null) return 0xFF;
        if (Number.isInteger(channels)) return assertInteger(channels, 0, 0xFF, 'channels');
        if (!Array.isArray(channels)) throw new TypeError('channels must be a bit mask or channel array');
        if (channels.length === 8 && channels.every(value => typeof value === 'boolean')) {
            return channels.reduce((mask, enabled, index) => mask | (enabled ? (1 << index) : 0), 0);
        }
        let mask = 0;
        for (const channel of channels) mask |= 1 << assertInteger(channel, 1, 8, 'channel');
        return (mask >>> 1) & 0xFF;
    }

    /**
     * 生成当前 BrainLume 项目的 ADS1299 推荐配置。
     *
     * 返回值固定为寄存器 0x01..0x1E 的 30 字节，顺序如下：
     *
     *   0x01 CONFIG1 = 0x96       250 SPS
     *   0x02 CONFIG2 = 0xC0       固定
     *   0x03 CONFIG3 = 0xEC       固定
     *   0x04 LOFF   = 0x05/0x00  阻抗/非阻抗模式
     *   0x05..0x0C CHnSET         启用 0x60，禁用 0x81
     *   普通采集：0x0D BIAS_SENSP = mask，其余 BIAS/LOFF sense = 0
     *   阻抗检测：0x0D = 0，0x0E = mask，0x0F = 0，0x10 = mask
     *   0x11..0x14 = 0x00
     *   0x15 MISC1 = 0x20
     *   0x16 = 0x00, 0x17 = 0x00, 0x18 = 0x00
     *   0x19..0x1E = CF 80 63 80 03 00
     *
     * 普通采集通过 BIAS_SENSP 将启用通道加入右腿驱动共模反馈；阻抗检测时关闭
     * BIAS_SENSP，并沿用当前硬件的 N 端 LOFF 激励。该函数不启用内部比较器脱落检测。
     *
     * @param {{impedance?: boolean, channels?: number|number[]|boolean[]}} options
     * @returns {Uint8Array} 可直接传给 commands.configureEeg() 的 30 字节配置。
     */
    function createRecommendedAdsConfig(options = {}) {
        const impedance = Boolean(options.impedance);
        const channelMask = normalizeEnabledChannelMask(options.channels);
        const senseMask = impedance ? channelMask : 0;
        const biasSenseP = impedance ? 0 : channelMask;
        const channelRegisters = Array.from({ length: 8 }, (_, index) =>
            channelMask & (1 << index) ? 0x60 : 0x81);
        return Uint8Array.from([
            0x96, 0xC0, 0xEC, impedance ? 0x05 : 0x00,
            ...channelRegisters,
            biasSenseP, senseMask, 0x00, senseMask,
            0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
            0xCF, 0x80, 0x63, 0x80, 0x03, 0x00,
        ]);
    }

    /**
     * 无副作用的设备命令集合。所有函数只返回 Command，不访问 Transport。
     * BrainLumeClient 的同名方法最终也会调用这里，保证手工构帧和 Client 行为一致。
     */
    const commands = Object.freeze({
        protocolVersion: address => command(address, FUNC.PROTOCOL_QUERY, STAT.HOST_QUERY, [PROTOCOL_QUERY.VERSION]),
        deviceId: address => command(address, FUNC.PROTOCOL_QUERY, STAT.HOST_QUERY, [PROTOCOL_QUERY.DEVICE_ID]),
        actionCount: address => command(address, FUNC.PROTOCOL_QUERY, STAT.HOST_QUERY, [PROTOCOL_QUERY.ACTION_COUNT]),
        uptime: address => command(address, FUNC.PROTOCOL_QUERY, STAT.HOST_QUERY, [PROTOCOL_QUERY.UPTIME]),
        busAddress: address => command(address, FUNC.PROTOCOL_QUERY, STAT.HOST_QUERY, [PROTOCOL_QUERY.ADDRESS]),
        actionSchema: address => command(address, FUNC.ACTION_DESCRIPTION, STAT.HOST_QUERY, [0x00]),
        actionDescription: (address, index) => command(address, FUNC.ACTION_DESCRIPTION, STAT.HOST_QUERY, [0x01, assertByte(index, 'index')]),
        status: address => command(address, FUNC.STATUS, STAT.HOST_QUERY),
        startIndicator: address => command(address, FUNC.INDICATOR_CONTROL, STAT.HOST_START),
        stopIndicator: address => command(address, FUNC.INDICATOR_CONTROL, STAT.HOST_QUERY),
        setLightConfig: (address, channelNumber, options) => command(address,
            assertChannel(channelNumber) === 1 ? FUNC.LIGHT1_CONFIG : FUNC.LIGHT2_CONFIG, STAT.HOST_START, lightConfigData(options)),
        startLight: (address, channelNumber) => command(address,
            assertChannel(channelNumber) === 1 ? FUNC.LIGHT1_CONTROL : FUNC.LIGHT2_CONTROL, STAT.HOST_START),
        stopLight: (address, channelNumber) => command(address,
            assertChannel(channelNumber) === 1 ? FUNC.LIGHT1_CONTROL : FUNC.LIGHT2_CONTROL, STAT.HOST_QUERY),
        configureEeg: (address, registers) => command(address, FUNC.EEG_CONFIG, STAT.HOST_START, normalizeAdsConfig(registers)),
        startEeg: address => command(address, FUNC.EEG_CONTROL, STAT.HOST_START),
        stopEeg: address => command(address, FUNC.EEG_CONTROL, STAT.HOST_QUERY),
        readAds1299Registers: address => command(address, FUNC.EEG_REGISTERS, STAT.HOST_QUERY),
    });

    // ---------------------------------------------------------------------
    // BrainLume 响应和 ADS1299 数据解码
    // ---------------------------------------------------------------------

    /** 解码 Func=0x01 的 13 字节状态响应。uptime 使用 uint32 大端。 */
    function decodeStatus(data) {
        const bytes = toBytes(data, 'status data');
        if (bytes.length < 13) throw new ProtocolError(`Status response requires 13 bytes, got ${bytes.length}`);
        return Object.freeze({ batteryLevel: bytes[0], charging: Boolean(bytes[1]), eegRunning: Boolean(bytes[2]),
            light1Running: Boolean(bytes[3]), light2Running: Boolean(bytes[4]), lastError: bytes[5],
            systemStatus: bytes[6], portStatus: bytes[7], chargingDone: Boolean(bytes[8]),
            uptimeMs: readValue(bytes, 9, 'uint32be') });
    }
    /**
     * 根据当前发出的 F0 子命令解释响应 Data。
     * 响应中不包含 subcommand，因此调用方必须保留请求上下文，不能从 Data[0] 猜测。
     */
    function decodeProtocolResponse(subcommand, data) {
        const bytes = toBytes(data);
        switch (subcommand) {
        case PROTOCOL_QUERY.VERSION:
            if (bytes.length < 2) throw new ProtocolError('Protocol version response requires 2 bytes');
            return { major: bytes[0], minor: bytes[1], text: `${bytes[0]}.${bytes[1]}` };
        case PROTOCOL_QUERY.DEVICE_ID:
            if (bytes.length < 5) throw new ProtocolError('Device ID response requires 5 bytes');
            return { bytes: bytes.slice(0, 5), hex: [...bytes.slice(0, 5)].map(v => v.toString(16).padStart(2, '0')).join('') };
        case PROTOCOL_QUERY.ACTION_COUNT:
            if (bytes.length < 1) throw new ProtocolError('Action count response requires 1 byte'); return bytes[0];
        case PROTOCOL_QUERY.UPTIME:
            if (bytes.length < 4) throw new ProtocolError('Uptime response requires 4 bytes'); return readValue(bytes, 0, 'uint32be');
        case PROTOCOL_QUERY.ADDRESS:
            if (bytes.length < 1) throw new ProtocolError('Address response requires 1 byte'); return bytes[0];
        default: throw new RangeError(`Unknown protocol subcommand: ${subcommand}`);
        }
    }
    /**
     * 解码 FE/01 响应：[FuncCode][DescLen][ASCII...]。
     * 描述长度异常时按实际可用字节截断，并通过 truncated=true 通知调用方。
     */
    function decodeActionDescription(data) {
        const bytes = toBytes(data);
        if (bytes.length < 2) throw new ProtocolError('Action description requires at least 2 bytes');
        const declaredLength = bytes[1];
        const availableLength = Math.min(declaredLength, bytes.length - 2);
        const description = String.fromCharCode(...bytes.slice(2, 2 + availableLength));
        return { func: bytes[0], declaredLength, availableLength, truncated: declaredLength !== bytes.length - 2, description };
    }
    /** 解码 0x23 返回的 0x00..0x1E 共 31 个 ADS1299 寄存器。 */
    function decodeRegisters(data) {
        const bytes = toBytes(data, 'register data');
        if (bytes.length < 31) throw new ProtocolError(`ADS1299 register response requires 31 bytes, got ${bytes.length}`);
        const values = bytes.slice(0, 31);
        const byName = {};
        ADS1299_REGISTER_NAMES.forEach((name, address) => { byName[name] = values[address]; });
        return { values, byName };
    }

    /**
     * 从 ADS1299 三个状态字节中提取八路 P/N 脱落标志。
     * 这里的 statusBytes 对应 0x22 Data[2..4]，返回 true 表示该状态位被置位。
     */
    function decodeLeadOff(statusBytes) {
        const status = toBytes(statusBytes, 'statusBytes');
        if (status.length < 3) throw new ProtocolError('ADS1299 status requires 3 bytes');
        const positive = []; const negative = [];
        for (let channel = 0; channel < 8; channel++) {
            const bit = channel < 4 ? channel + 4 : channel - 4;
            positive.push(Boolean((status[channel < 4 ? 1 : 0] >>> bit) & 1));
            negative.push(Boolean((status[channel < 4 ? 2 : 1] >>> bit) & 1));
        }
        return { positive, negative };
    }
    /**
     * 解码 Func=0x22 的 29 字节 EEG payload：
     * [seq uint16 BE][ADS status 3B][CH1..CH8，每路 int24 BE]。
     * rawCodes 使用 Int32Array 保存符号扩展后的 24 位原始 ADC 码。
     */
    function decodeEegPayload(data) {
        const bytes = toBytes(data, 'EEG payload');
        if (bytes.length < 29) throw new ProtocolError(`EEG payload requires 29 bytes, got ${bytes.length}`);
        const rawCodes = new Int32Array(8);
        for (let channel = 0; channel < 8; channel++) rawCodes[channel] = readValue(bytes, 5 + channel * 3, 'int24be');
        const statusBytes = bytes.slice(2, 5);
        return { seq: readValue(bytes, 0, 'uint16be'), statusBytes, leadOff: decodeLeadOff(statusBytes), rawCodes };
    }
    /**
     * ADS1299 原始码转换为输入端电压：V = code * VREF / (PGA * 2^23)。
     * 默认值对应当前 BrainLume：VREF=4.5V、PGA=24。
     */
    function codeToVolts(code, options = {}) {
        const vrefVolts = Number(options.vrefVolts ?? 4.5); const gain = Number(options.gain ?? 24);
        if (!(vrefVolts > 0) || !(gain > 0)) throw new RangeError('vrefVolts and gain must be positive');
        return Number(code) * vrefVolts / (gain * ADC_FULL_SCALE_CODES);
    }
    function codeToMicrovolts(code, options = {}) { return codeToVolts(code, options) * 1e6; }
    /** 从 CHnSET[6:4] 解码 PGA 增益。保留值 111 返回 null。 */
    function ads1299GainFromChSet(value) { return ADS1299_GAINS[(assertByte(value, 'CHnSET') >>> 4) & 0x07]; }
    /** 从 CONFIG1.DR[2:0] 解码采样率；保留编码返回 null。 */
    function sampleRateFromConfig1(value) {
        return Object.freeze({ 0: 16000, 1: 8000, 2: 4000, 3: 2000, 4: 1000, 5: 500, 6: 250 })[assertByte(value, 'CONFIG1') & 7] || null;
    }
    /** 解码 LOFF 的电流档和交流激励频率。 */
    function decodeLoff(value, sampleRateHz = 250) {
        const register = assertByte(value, 'LOFF'); const currentCode = (register >>> 2) & 3; const frequencyCode = register & 3;
        return { register, currentCode, currentAmps: LOFF_CURRENTS_AMPS[currentCode], frequencyCode,
            excitationHz: [0, 7.8125, 31.25, Number(sampleRateHz) / 4][frequencyCode] };
    }
    /**
     * 校验当前项目使用的 N 端 24nA 阻抗配置。
     * 预期 LOFF=0x05、LOFF_SENSP=0、LOFF_SENSN=0xFF、MISC1.SRB1=1。
     * 返回 errors 而不是直接抛错，方便 UI 同时显示所有寄存器问题。
     */
    function decodeImpedanceRegisters(registers, sampleRateHz = 250) {
        const values = toBytes(registers);
        if (values.length < 0x18) throw new ProtocolError(`ADS1299 register response is too short: ${values.length}/24`);
        const loff = decodeLoff(values[0x04], sampleRateHz);
        const gains = Array.from({ length: 8 }, (_, channel) => ads1299GainFromChSet(values[0x05 + channel]));
        const errors = [];
        if (loff.register !== 0x05) errors.push(`LOFF expected 0x05, got 0x${loff.register.toString(16).padStart(2, '0')}`);
        if (values[0x0F] !== 0x00) errors.push('LOFF_SENSP expected 0x00');
        if (values[0x10] !== 0xFF) errors.push('LOFF_SENSN expected 0xFF');
        if ((values[0x15] & 0x20) === 0) errors.push('MISC1.SRB1 expected 1');
        gains.forEach((gain, channel) => { if (!gain) errors.push(`CH${channel + 1}SET has unsupported PGA bits`); });
        return { ...loff, gains, loffSensP: values[0x0F], loffSensN: values[0x10], misc1: values[0x15],
            enabledChannels: gains.map((gain, channel) => Boolean(gain) && Boolean(values[0x10] & (1 << channel))),
            valid: errors.length === 0, errors };
    }
    function compareAdsConfig(expected, readback) {
        const target = toBytes(expected, 'expected config');
        const values = toBytes(readback, 'readback registers');
        const mismatches = [];
        for (const address of ADS1299_CONFIG_REGISTERS) {
            const expectedValue = target[address - 1];
            const actualValue = values[address];
            // CONFIG3 bit 0 is the read-only BIAS_STAT flag (TI SBAS499C,
            // section 9.6.1.4). Its live value is not a failed configuration.
            const mask = address === 0x03 ? 0xFE : 0xFF;
            if ((actualValue & mask) !== (expectedValue & mask)) mismatches.push({ address, expected: expectedValue, actual: actualValue });
        }
        return mismatches;
    }

    // ---------------------------------------------------------------------
    // EEG 实时滤波
    // ---------------------------------------------------------------------

    /**
     * 旧版上位机 EegFilter.cs 的系数表，按采样率直接复用。
     *
     * 每个数组元素都是一个串联 IIR 节，b 为前向系数，a 为反馈系数。保留这套预设
     * 是为了兼容旧布局和历史数据；新项目默认使用下方动态设计的 0.5~45 Hz 预设。
     */
    const LEGACY_FILTER_CHAINS = Object.freeze({
        125: [
            { b: [0.982385438526092, -1.96477087705218, 0.982385438526092], a: [1, -1.96446058020523, 0.965081173899135] },
            { b: [0.911897419411676, 1.47548101886141, 0.911897419411676], a: [1, 1.47548101886141, 0.823794838823351] }],
        250: [
            { b: [0.991153595101663, -1.98230719020333, 0.991153595101663], a: [1, -1.98222892979253, 0.982385450614125] },
            { b: [0.872683978124476, 0, 0, 0, 0, -0.872683978124476], a: [1, 0, 0, 0, 0, -0.745367956248952] }],
        500: [
            { b: [0.991824212000533, -3.96729684800213, 5.95094527200320, -3.96729684800213, 0.991824212000533], a: [1, -3.98358125865852, 5.95087842926670, -3.95101243657283, 0.983715267510479] },
            { b: [0.0465829066364437, 0.186331626545775, 0.279497439818662, 0.186331626545775, 0.0465829066364437], a: [1, -0.782095198023338, 0.679978526916300, -0.182675697753033, 0.0301188750431693] },
            { b: [0.976529811793961, -1.58005842651017, 0.976529811793961], a: [1, -1.58005842651017, 0.953059623587922] },
            { b: [0.976529811793961, -0.603528614716206, 0.976529811793961], a: [1, -0.603528614716206, 0.953059623587922] }],
        1000: [
            { b: [0.995903722138425, -3.98361488855370, 5.97542233283055, -3.98361488855370, 0.995903722138425], a: [1, -3.99179062441447, 5.97540555338674, -3.97543915264442, 0.991824223769170] },
            { b: [0.00482434335771623, 0.0192973734308649, 0.0289460601462974, 0.0192973734308649, 0.00482434335771623], a: [1, -2.36951300718204, 2.31398841441588, -1.05466540587857, 0.187379492368185] },
            { b: [0.988128453800010, -1.87953200984631, 0.988128453800010], a: [1, -1.87953200984631, 0.976256907600020] },
            { b: [0.988128453800010, -1.59882542349930, 0.988128453800010], a: [1, -1.59882542349930, 0.976256907600020] }],
        2000: [
            { b: [0.997949760065881, -3.99179904026353, 5.98769856039529, -3.99179904026353, 0.997949760065881], a: [1, -3.99589531159288, 5.98769435691454, -3.98770276893113, 0.995903723615550] },
            { b: [0.000416599204406599, 0.00166639681762640, 0.00249959522643960, 0.00166639681762640, 0.000416599204406599], a: [1, -3.18063854887472, 3.86119434899421, -2.11215535511097, 0.438265142261980] },
            { b: [0.994029149261888, -1.96358200187534, 0.994029149261888], a: [1, -1.96358200187534, 0.988058298523775] },
            { b: [0.994029149261888, -1.89075579958569, 0.994029149261888], a: [1, -1.89075579958569, 0.988058298523775] }],
    });

    /**
     * 与睡眠分期模型训练预处理一致的 250 Hz filter_base 系数。
     *
     * 训练代码依次构造：Butterworth 0.4–18 Hz 带通、58–62 Hz 陷波、
     * 48–52 Hz 陷波、Bessel 62–63 Hz 陷波，然后用 np.polymul 合并并以
     * scipy.signal.lfilter 因果实现。这里保留合并后的 ba 形式，以便实时端
     * 与训练端使用同一差分方程；它只供模型输入，不改变原始 EDF/CSV 或显示波形。
     */
    const TRAINING_FILTER_CHAINS = Object.freeze({
        250: [{
            b: [0.029835566792489405, -0.06664270011237414, 0.20576151516252628, -0.2892564526720828, 0.41283834176050854, -0.3123455839230592, 0.061000500215101894, 0.2892564526720828, -0.7094359239306259, 0.7579765680708667, -0.7094359239306259, 0.2892564526720828, 0.061000500215101866, -0.3123455839230592, 0.4128383417605085, -0.2892564526720828, 0.20576151516252628, -0.06664270011237414, 0.0298355667924894],
            a: [1.0, -5.538550523392161, 19.938567267029605, -52.801920249583205, 112.18469813323537, -199.4451167000127, 302.85161480374444, -399.6569511637718, 461.6360366426025, -469.2603660577762, 420.3574097630005, -330.9573120611098, 228.01599268448518, -135.98221078562574, 69.13514876689717, -29.215448629438438, 9.795101352757673, -2.4053686539841745, 0.3491127900153634],
        }],
    });

    /**
     * 使用 RBJ Audio EQ Cookbook 公式生成归一化二阶 IIR（biquad）系数。
     * 返回结果始终满足 a[0] = 1，IirFilter 因而无需在每个样本处重复除以 a0。
     * 当截止频率超过 Nyquist 或参数无效时返回 null，由调用方决定是否旁路滤波。
     */
    function makeBiquad(type, sampleRateHz, frequencyHz, q) {
        const rate = Number(sampleRateHz); const frequency = Number(frequencyHz); const quality = Number(q);
        if (!(rate > 0) || !(frequency > 0) || frequency >= rate / 2 || !(quality > 0)) return null;
        const omega = 2 * Math.PI * frequency / rate; const cosine = Math.cos(omega); const alpha = Math.sin(omega) / (2 * quality);
        let b0; let b1; let b2;
        if (type === 'highpass') { b0 = (1 + cosine) / 2; b1 = -(1 + cosine); b2 = b0; }
        else if (type === 'lowpass') { b0 = (1 - cosine) / 2; b1 = 1 - cosine; b2 = b0; }
        else if (type === 'notch') { b0 = 1; b1 = -2 * cosine; b2 = 1; }
        else throw new RangeError(`Unsupported biquad type: ${type}`);
        const a0 = 1 + alpha;
        return { b: [b0 / a0, b1 / a0, b2 / a0], a: [1, -2 * cosine / a0, (1 - alpha) / a0] };
    }
    /**
     * 创建设备当前使用的实时显示滤波链：
     * 1. 二阶 0.5 Hz Butterworth 高通，抑制直流基线和缓慢漂移；
     * 2. 两个二阶 45 Hz 低通串联，组成四阶 Butterworth 低通；
     * 3. 50 Hz、Q=30 陷波，抑制工频干扰。
     *
     * 所有滤波器均为因果 IIR，不需要整窗缓存，因此不会引入数秒显示延迟。
     */
    function createDisplayFilterChain(sampleRateHz) {
        const rate = Number(sampleRateHz);
        if (!SUPPORTED_SAMPLE_RATES.includes(rate)) return null;
        return [makeBiquad('highpass', rate, 0.5, Math.SQRT1_2), makeBiquad('lowpass', rate, 45, 0.5411961),
            makeBiquad('lowpass', rate, 45, 1.306563), makeBiquad('notch', rate, 50, 30)];
    }
    /** 根据预设名和采样率返回系数链；返回 null 表示该采样率不受支持。 */
    function filterChainForPreset(sampleRateHz, preset = LEGACY_FILTER_PRESET) {
        const normalizedPreset = String(preset).toLowerCase();
        if (normalizedPreset === DISPLAY_FILTER_PRESET) return createDisplayFilterChain(sampleRateHz);
        if (normalizedPreset === MODEL_TRAINING_FILTER_PRESET) return TRAINING_FILTER_CHAINS[Number(sampleRateHz)] || null;
        return LEGACY_FILTER_CHAINS[Number(sampleRateHz)] || null;
    }
    /**
     * 单个直接型 IIR 节。
     *
     * 差分方程：
     * y[n] = b0*x[n] + b1*x[n-1] + ... - a1*y[n-1] - a2*y[n-2] - ...
     *
     * 每个通道、每一级滤波器必须拥有独立实例，否则一个通道的历史状态会串入另一
     * 通道。内部使用 Float64Array，避免长时间运行时 Float32 累积误差破坏稳定性。
     */
    class IirFilter {
        constructor(coefficients, options = {}) {
            const a0 = Number(coefficients.a?.[0]);
            if (!Number.isFinite(a0) || Math.abs(a0) <= Number.EPSILON) throw new RangeError('IIR filter requires a finite, non-zero a[0]');
            this.b = coefficients.b.map(value => Number(value) / a0);
            this.a = coefficients.a.map(value => Number(value) / a0);
            this.initialization = options.initialization === 'zero' ? 'zero' : 'prime';
            this.implementation = options.implementation === 'direct2t' ? 'direct2t' : 'direct1';
            this.x = new Float64Array(this.b.length);
            this.y = new Float64Array(Math.max(0, this.a.length - 1));
            this.state = new Float64Array(Math.max(this.b.length, this.a.length) - 1);
            this.initialized = this.initialization !== 'prime';
        }

        /**
         * 用首个输入的直流稳态初始化历史状态。
         * 若简单地从全零状态启动，大的 ADS1299 直流偏置会在高通中形成持续数秒的假峰。
         */
        prime(input) {
            const value = Number.isFinite(input) ? input : 0; const numerator = this.b.reduce((sum, c) => sum + c, 0); const denominator = this.a.reduce((sum, c) => sum + c, 0);
            const output = Math.abs(denominator) > Number.EPSILON ? value * numerator / denominator : 0;
            this.x.fill(value); this.y.fill(Number.isFinite(output) ? output : 0); this.initialized = true; return Number.isFinite(output) ? output : 0;
        }
        /** 清除历史；prime 模式下一个样本会重新执行稳态预热。 */
        reset() {
            this.x.fill(0); this.y.fill(0); this.state.fill(0);
            this.initialized = this.initialization !== 'prime';
        }

        /**
         * scipy.signal.lfilter 使用的 transposed direct-form II 递推。
         * 模型训练端采用零初始状态；该实现只在模型滤波链显式选择时使用，
         * 不改变显示滤波器原有的首样本稳态预热行为。
         */
        processDirect2T(input) {
            const value = Number.isFinite(input) ? input : 0;
            const order = this.state.length;
            const output = this.b[0] * value + (order ? this.state[0] : 0);
            for (let index = 0; index < order - 1; index++) {
                const numerator = index + 1 < this.b.length ? this.b[index + 1] : 0;
                const denominator = index + 1 < this.a.length ? this.a[index + 1] : 0;
                this.state[index] = numerator * value - denominator * output + this.state[index + 1];
            }
            if (order) {
                const numerator = order < this.b.length ? this.b[order] : 0;
                const denominator = order < this.a.length ? this.a[order] : 0;
                this.state[order - 1] = numerator * value - denominator * output;
            }
            return output;
        }

        /** 输入一个样本并返回当前输出。 */
        process(input) {
            if (this.implementation === 'direct2t') return this.processDirect2T(input);
            if (!this.initialized) return this.prime(input);
            for (let i = this.x.length - 1; i > 0; i--) this.x[i] = this.x[i - 1]; this.x[0] = Number.isFinite(input) ? input : 0;
            let output = 0; for (let i = 0; i < this.b.length; i++) output += this.b[i] * this.x[i];
            for (let i = 1; i < this.a.length; i++) output -= this.a[i] * this.y[i - 1];
            for (let i = this.y.length - 1; i > 0; i--) this.y[i] = this.y[i - 1]; if (this.y.length) this.y[0] = output; return output;
        }
    }
    /** 管理多通道滤波器状态，并按相同顺序级联每个通道的 IIR 节。 */
    class EegFilterBank {
        constructor(sampleRateHz, channelCount = 8, preset = DISPLAY_FILTER_PRESET, options = {}) {
            this.sampleRateHz = Number(sampleRateHz); this.preset = String(preset).toLowerCase(); this.options = { ...options };
            const chain = filterChainForPreset(this.sampleRateHz, this.preset);
            this.supported = Boolean(chain); this.channels = Array.from({ length: assertInteger(channelCount, 1, 256, 'channelCount') }, () => chain ? chain.map(c => new IirFilter(c, this.options)) : []);
        }
        /** 不支持的采样率或越界通道采用旁路输出，调用方可以继续显示原始数据。 */
        process(channel, input) { let output = input; const chain = this.channels[channel]; if (!this.supported || !chain) return output; for (const filter of chain) output = filter.process(output); return output; }
        reset() { this.channels.flat().forEach(filter => filter.reset()); }
    }

    // ---------------------------------------------------------------------
    // 频谱、峰峰值与单频幅值
    // ---------------------------------------------------------------------

    /** 返回不小于输入值的最小 2 的幂，供 radix-2 FFT 使用。 */
    function powerOfTwo(value, max = 65536) { let result = 1; const target = Math.max(2, Math.min(max, Number(value) || 2)); while (result < target) result <<= 1; return result; }

    /**
     * 计算单边线性幅度谱。
     *
     * 默认先去均值并乘 Hann 窗，再补零到 2 的幂。FFT 使用迭代式 radix-2
     * Cooley-Tukey 算法，返回 bin 0..N/2-1；结果乘 2/N 转成单边峰值幅度。
     */
    function fftMagnitude(signal, options = {}) {
        const values = Array.from(signal || [], Number); const n = powerOfTwo(values.length); const re = new Float64Array(n); const im = new Float64Array(n);
        const mean = options.removeMean === false ? 0 : values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
        // 预处理：去直流、加窗，未占满的尾部自然保持为零以完成 zero-padding。
        for (let i = 0; i < values.length; i++) { const window = options.hann === false ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, values.length - 1)); re[i] = (values[i] - mean) * window; }
        // 位反转排列，使后续每一级蝶形可以连续访问数据。
        for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
        // 从长度 2 开始逐级合并，wr/wi 是当前蝶形旋转因子。
        for (let length = 2; length <= n; length <<= 1) {
            const angle = -2 * Math.PI / length; const wr0 = Math.cos(angle); const wi0 = Math.sin(angle);
            for (let start = 0; start < n; start += length) { let wr = 1; let wi = 0; for (let j = 0; j < length / 2; j++) {
                const evenR = re[start + j]; const evenI = im[start + j]; const odd = start + j + length / 2;
                const oddR = re[odd] * wr - im[odd] * wi; const oddI = re[odd] * wi + im[odd] * wr;
                re[start + j] = evenR + oddR; im[start + j] = evenI + oddI; re[odd] = evenR - oddR; im[odd] = evenI - oddI;
                const nextR = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = nextR;
            } }
        }
        const output = new Float64Array(n / 2); for (let i = 0; i < output.length; i++) output[i] = 2 * Math.hypot(re[i], im[i]) / n; return output;
    }
    /** 对线性频谱执行 log10(amplitude + 1)，避免零幅值产生负无穷。 */
    function fftMagnitudeLog10(signal, options = {}) { return Float64Array.from(fftMagnitude(signal, options), value => Math.log10(value + 1)); }
    /** 返回序列最大值与最小值之差；空序列返回 0。 */
    function peakToPeak(signal) { let min = Infinity; let max = -Infinity; for (const value of signal || []) { if (value < min) min = value; if (value > max) max = value; } return Number.isFinite(min) ? max - min : 0; }

    /**
     * 使用 Goertzel 算法提取最接近目标频率的 FFT bin 峰值幅度（单位仍是 ADC code）。
     * 该算法只计算一个频点，适合 7.8125 Hz 阻抗激励，成本远低于计算完整 FFT。
     */
    function tonePeakCodes(samples, sampleRateHz, frequencyHz) {
        const values = Array.from(samples || [], Number); const n = values.length; if (n < 4 || !(sampleRateHz > 0) || !(frequencyHz > 0)) return 0;
        const mean = values.reduce((sum, value) => sum + value, 0) / n; const bin = Math.max(1, Math.min(Math.floor(n / 2), Math.round(frequencyHz * n / sampleRateHz)));
        const omega = 2 * Math.PI * bin / n; const cosine = Math.cos(omega); const sine = Math.sin(omega); const coefficient = 2 * cosine; let s1 = 0; let s2 = 0;
        for (const value of values) { const s0 = value - mean + coefficient * s1 - s2; s2 = s1; s1 = s0; }
        return 2 * Math.hypot(s1 - s2 * cosine, s2 * sine) / n;
    }
    // ---------------------------------------------------------------------
    // ADS1299 导联阻抗
    // ---------------------------------------------------------------------

    /**
     * 将目标频点的 ADC 峰峰值换算为阻抗（kOhm）。
     *
     * Vpp = code_pp * VREF / (PGA * 2^23)
     * 方波电流的基波峰峰值 Ipp = 8 * I_LOFF / PI
     * Z = Vpp / Ipp - seriesOhms
     *
     * seriesOhms 用于扣除电极输入端已知串联电阻。结果小于零时钳制为零。
     */
    function impedanceKohmFromPeakToPeakCodes(peakToPeakCodes, options = {}) {
        const vrefVolts = Number(options.vrefVolts ?? 4.5); const gain = Number(options.gain); const currentAmps = Number(options.currentAmps);
        if (!(vrefVolts > 0) || !(gain > 0) || !(currentAmps > 0)) throw new RangeError('vrefVolts, gain, and currentAmps must be positive');
        const currentPp = String(options.currentWaveform || 'square').toLowerCase() === 'square' ? currentAmps * 8 / Math.PI : currentAmps * 2;
        const voltagePp = Math.abs(Number(peakToPeakCodes)) * vrefVolts / (gain * ADC_FULL_SCALE_CODES);
        return Math.max(0, (voltagePp / currentPp - Math.max(0, Number(options.seriesOhms) || 0)) / 1000);
    }
    function impedanceKohmFromPeakCodes(peakCodes, options = {}) { return impedanceKohmFromPeakToPeakCodes(Math.abs(Number(peakCodes)) * 2, options); }
    /** 清洗、排序并去重板级分段校准点；不足两个有效点时禁用校准。 */
    function normalizePiecewiseCalibration(rawPoints) {
        const points = (Array.isArray(rawPoints) ? rawPoints : []).map(point => ({ measuredKohm: Number(point.measuredKohm), actualKohm: Number(point.actualKohm) }))
            .filter(point => Number.isFinite(point.measuredKohm) && Number.isFinite(point.actualKohm) && point.measuredKohm >= 0 && point.actualKohm >= 0).sort((a, b) => a.measuredKohm - b.measuredKohm);
        const unique = []; for (const point of points) { if (unique.length && Math.abs(unique.at(-1).measuredKohm - point.measuredKohm) < 1e-12) unique[unique.length - 1] = point; else unique.push(point); }
        return unique.length >= 2 ? unique : null;
    }
    /**
     * 对物理计算结果做分段线性插值；范围外沿首段或末段直线外推。
     * 校准不是默认物理公式的一部分，只有显式选择预设或传入 calibration 才会执行。
     */
    function applyPiecewiseCalibration(value, rawPoints) {
        const points = normalizePiecewiseCalibration(rawPoints); const measured = Number(value); if (!points || !Number.isFinite(measured)) return measured;
        let upper = points.findIndex(point => measured <= point.measuredKohm); if (upper < 0) upper = points.length - 1; if (upper === 0) upper = 1;
        const left = points[upper - 1]; const right = points[upper]; return left.actualKohm + (measured - left.measuredKohm) / (right.measuredKohm - left.measuredKohm) * (right.actualKohm - left.actualKohm);
    }
    function median(values) { const data = values.filter(Number.isFinite).sort((a, b) => a - b); if (!data.length) return NaN; const mid = Math.floor(data.length / 2); return data.length % 2 ? data[mid] : (data[mid - 1] + data[mid]) / 2; }
    /** 用多路标准电阻的“实际/测量”中位数生成一个抗离群值的公共比例系数。 */
    function commonScaleFromReferences(measured, expected) { return median(expected.map((value, i) => Number(value) > 0 && Number(measured[i]) > 0 ? Number(value) / Number(measured[i]) : NaN)); }

    /**
     * BrainLume 当前硬件接线的显式板级校准预设。
     * 它包含 24 nA、7.8125 Hz、2 kOhm 串联电阻及实测分段映射，不能当作通用
     * ADS1299 参数。调用方不指定 preset 时，SDK 只返回未经校准的物理公式结果。
     */
    const IMPEDANCE_PRESETS = Object.freeze({
        'brainlume-24na-v1': Object.freeze({
            sampleRateHz: 250, fftSize: 1024, excitationHz: 7.8125, currentAmps: 24e-9, currentWaveform: 'square',
            vrefVolts: 4.5, gain: 24, seriesOhms: 2000, source: 'filtered',
            calibration: Object.freeze([
                { measuredKohm: 2.544, actualKohm: 1.0 }, { measuredKohm: 4.269, actualKohm: 3.3 },
                { measuredKohm: 22.020, actualKohm: 20.5 }, { measuredKohm: 32.918, actualKohm: 32.0 },
                { measuredKohm: 47.986, actualKohm: 46.8 }, { measuredKohm: 221.527, actualKohm: 222.0 },
                { measuredKohm: 467.994, actualKohm: 476.0 },
            ]),
        }),
    });
    /**
     * 多通道滚动阻抗估计器。每次 push 一组同步样本；窗口未达到 fftSize 前返回 null，
     * 达到后基于最近一个完整窗口计算各通道 7.8125 Hz 幅值和阻抗。
     */
    class ImpedanceEstimator {
        constructor(options = {}) {
            const preset = options.preset ? IMPEDANCE_PRESETS[options.preset] : null;
            if (options.preset && !preset) throw new RangeError(`Unknown impedance preset: ${options.preset}`);
            this.options = { sampleRateHz: 250, fftSize: 1024, excitationHz: 7.8125, currentAmps: 24e-9, currentWaveform: 'square', vrefVolts: 4.5, gain: 24, seriesOhms: 0, ...preset, ...options };
            this.channelCount = assertInteger(options.channelCount || 8, 1, 256, 'channelCount'); this.buffers = Array.from({ length: this.channelCount }, () => []);
        }
        reset() { this.buffers.forEach(buffer => { buffer.length = 0; }); }
        push(samples) { if (!samples || samples.length !== this.channelCount) throw new RangeError(`Expected ${this.channelCount} samples`); this.buffers.forEach((buffer, i) => { buffer.push(Number(samples[i])); if (buffer.length > this.options.fftSize) buffer.shift(); }); return this.ready ? this.estimate() : null; }
        get ready() { return this.buffers.every(buffer => buffer.length >= this.options.fftSize); }
        estimate() {
            if (!this.ready) return null;
            return Float64Array.from(this.buffers, (samples, channel) => {
                const gain = this.options.gains?.[channel] || this.options.gain; const peak = tonePeakCodes(samples, this.options.sampleRateHz, this.options.excitationHz);
                const physical = impedanceKohmFromPeakCodes(peak, { ...this.options, gain });
                return this.options.calibration ? Math.max(0, applyPiecewiseCalibration(physical, this.options.calibration)) : physical;
            });
        }
    }

    // ---------------------------------------------------------------------
    // EEG 高层处理管线
    // ---------------------------------------------------------------------

    /**
     * 把单个 0x22 payload 转换为应用可以直接消费的结果。
     *
     * 数据流：int24 解码 -> 每通道因果滤波 -> code/uV 换算 -> 有限历史 -> 峰峰值，
     * 并按配置低频计算 FFT 和阻抗。rawCodes/rawMicrovolts 始终保留原始 ADC 数据；
     * CSV 等长期记录应使用原始字段，而不是 filteredMicrovolts。
     */
    class EegProcessor {
        constructor(options = {}) {
            this.options = { sampleRateHz: 250, channelCount: 8, vrefVolts: 4.5, gains: new Array(8).fill(24),
                filter: { enabled: true, preset: DISPLAY_FILTER_PRESET }, historyPoints: 5000,
                fft: { enabled: true, size: 128, updateEvery: 25, maxHz: 60, log10: true }, ...options };
            this.options.filter = { enabled: true, preset: DISPLAY_FILTER_PRESET, ...(options.filter || {}) };
            this.options.fft = { enabled: true, size: 128, updateEvery: 25, maxHz: 60, log10: true, ...(options.fft || {}) };
            this.filterBank = this.options.filter.enabled ? new EegFilterBank(this.options.sampleRateHz, 8, this.options.filter.preset) : null;
            this.history = Array.from({ length: 8 }, () => []); this.frames = 0;
            this.impedance = options.impedance ? new ImpedanceEstimator({ channelCount: 8, ...options.impedance }) : null;
        }
        reset() { this.filterBank?.reset(); this.history.forEach(values => { values.length = 0; }); this.impedance?.reset(); this.frames = 0; }
        /** 采样率变化会重建系数并清空滤波历史，避免混用两套时基。 */
        setSampleRate(sampleRateHz) { if (!SUPPORTED_SAMPLE_RATES.includes(Number(sampleRateHz))) throw new RangeError(`Unsupported sample rate: ${sampleRateHz}`); this.options.sampleRateHz = Number(sampleRateHz); this.filterBank = this.options.filter.enabled ? new EegFilterBank(sampleRateHz, 8, this.options.filter.preset) : null; this.reset(); }
        /** 设置八路实际 PGA；电压换算必须使用对应通道的 CHnSET 增益。 */
        setGains(gains) { if (!Array.isArray(gains) || gains.length !== 8 || gains.some(gain => !(Number(gain) > 0))) throw new RangeError('gains must contain 8 positive numbers'); this.options.gains = gains.map(Number); }
        /** 处理一个完整 29 字节 EEG payload。 */
        processPayload(payload) {
            const decoded = decodeEegPayload(payload); const filteredCodes = new Float64Array(8); const rawMicrovolts = new Float64Array(8); const filteredMicrovolts = new Float64Array(8);
            for (let channel = 0; channel < 8; channel++) {
                const gain = this.options.gains[channel]; const filtered = this.filterBank ? this.filterBank.process(channel, decoded.rawCodes[channel]) : decoded.rawCodes[channel]; filteredCodes[channel] = filtered;
                rawMicrovolts[channel] = codeToMicrovolts(decoded.rawCodes[channel], { vrefVolts: this.options.vrefVolts, gain }); filteredMicrovolts[channel] = codeToMicrovolts(filtered, { vrefVolts: this.options.vrefVolts, gain });
                const history = this.history[channel]; history.push(filtered); if (history.length > this.options.historyPoints) history.shift();
            }
            this.frames++; const result = { ...decoded, rawMicrovolts, filteredCodes, filteredMicrovolts,
                peakToPeakMicrovolts: Float64Array.from(this.history, (values, channel) => peakToPeak(values) * this.options.vrefVolts * 1e6 / (this.options.gains[channel] * ADC_FULL_SCALE_CODES)) };
            if (this.options.fft.enabled && this.frames % this.options.fft.updateEvery === 0 && this.history[0].length >= 32) {
                const n = Math.min(powerOfTwo(this.options.fft.size), this.history[0].length); const maxBin = Math.min(n / 2 - 1, Math.floor(this.options.fft.maxHz * n / this.options.sampleRateHz));
                result.spectrum = this.history.map(values => { const input = values.slice(-n); const output = this.options.fft.log10 ? fftMagnitudeLog10(input) : fftMagnitude(input); return output.slice(1, maxBin + 1); });
                result.spectrumXAxis = { minHz: 0, maxHz: maxBin * this.options.sampleRateHz / n, binHz: this.options.sampleRateHz / n };
            }
            if (this.impedance) result.impedanceKohm = this.impedance.push(filteredCodes);
            return result;
        }
    }

    // ---------------------------------------------------------------------
    // 事件与设备客户端
    // ---------------------------------------------------------------------

    /**
     * SDK 内部的最小事件分发器，避免为浏览器或嵌入式 Node 环境引入依赖。
     * listener 抛错不会中断协议解析，而会转发为 listenerError 事件。
     */
    class EventEmitter {
        constructor() { this.listeners = new Map(); }
        on(name, listener) { if (typeof listener !== 'function') throw new TypeError('listener must be a function'); const set = this.listeners.get(name) || new Set(); set.add(listener); this.listeners.set(name, set); return () => this.off(name, listener); }
        once(name, listener) { const off = this.on(name, (...args) => { off(); listener(...args); }); return off; }
        off(name, listener) { this.listeners.get(name)?.delete(listener); }
        emit(name, ...args) { for (const listener of this.listeners.get(name) || []) { try { listener(...args); } catch (error) { if (name !== 'listenerError') this.emit('listenerError', error); } } }
    }
    /**
     * BrainLume 设备客户端。
     *
     * Transport 最小接口：
     * - write(Uint8Array): Promise<void>|void
     * - onData(callback): 可选，返回取消订阅函数
     * - isConnected(): 可选
     * - connect()/disconnect(): 可选
     *
     * 请求按顺序串行发送。ActionBus 响应只能可靠匹配 Addr+Func，尤其 F0 响应不会回显
     * subcommand；若允许同 Func 并发，请求 A 的响应可能错误地完成请求 B。
     */
    class BrainLumeClient extends EventEmitter {
        constructor(options = {}) {
            super(); this.address = assertByte(options.address ?? 1, 'address'); this.timeoutMs = assertInteger(options.timeoutMs ?? 1000, 1, 600000, 'timeoutMs');
            this.transport = options.transport || null; this.parser = new ActionBusParser({ onError: error => this.emit('error', error) }); this.pending = null; this.queue = Promise.resolve();
            this.eegProcessor = options.eegProcessor === false ? null : (options.eegProcessor instanceof EegProcessor ? options.eegProcessor : new EegProcessor(options.eeg || {})); this.unsubscribe = null; this._attach();
        }
        /** 连接 Transport 的接收回调；若调用方没有 onData，也可以手动调用 feed()。 */
        _attach() { if (!this.unsubscribe && typeof this.transport?.onData === 'function') { const result = this.transport.onData(chunk => this.feed(chunk)); if (typeof result === 'function') this.unsubscribe = result; } }
        async connect() { if (typeof this.transport?.connect === 'function') await this.transport.connect(); this._attach(); return this; }
        async disconnect() { if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; } if (typeof this.transport?.disconnect === 'function') await this.transport.disconnect(); }
        isConnected() { return typeof this.transport?.isConnected === 'function' ? Boolean(this.transport.isConnected()) : Boolean(this.transport); }
        /** 喂入任意分片大小的原始字节；解析器负责粘包、半包和噪声重同步。 */
        feed(chunk) { for (const frame of this.parser.feed(chunk)) this._handleFrame(frame); }
        _handleFrame(frame) {
            this.emit('frame', frame);
            // 0x22 是下位机主动上报，不属于普通请求/响应。先独立处理并触发 eeg 事件。
            if (frame.func === FUNC.EEG_RAW) { try { const decoded = this.eegProcessor ? this.eegProcessor.processPayload(frame.data) : decodeEegPayload(frame.data); this.emit('eeg', decoded, frame); } catch (error) { this.emit('error', error); } }
            const pending = this.pending;
            // matcher 命中后必须先清除 pending 和超时定时器，再调用用户 Promise 回调。
            if (pending && pending.matcher(frame)) { this.pending = null; clearTimeout(pending.timer); if (frame.stat & STAT.ERROR) pending.reject(new DeviceError(frame, pending.request)); else pending.resolve(frame); }
        }
        /**
         * 将命令加入 Promise 链。无论前一个命令成功或失败，后一个命令都继续执行，
         * 但同一时刻只允许一个等待响应的命令存在。
         */
        sendCommand(value, options = {}) {
            const execute = () => this._sendCommand(value, options); const result = this.queue.then(execute, execute); this.queue = result.catch(() => {}); return result;
        }
        async _sendCommand(value, options) {
            if (!this.transport || typeof this.transport.write !== 'function') throw new TypeError('transport.write(bytes) is required');
            if (!this.isConnected()) throw new Error('Transport is not connected');
            const bytes = encodeCommand(value); const waitForResponse = options.waitForResponse !== false;
            if (!waitForResponse) { await this.transport.write(bytes); return null; }
            const timeoutMs = assertInteger(options.timeoutMs ?? this.timeoutMs, 1, 600000, 'timeoutMs');
            // 先安装响应匹配器，再调用 write，避免低延迟回环 Transport 在 write 内同步回包。
            const response = new Promise((resolve, reject) => {
                const timer = setTimeout(() => { if (this.pending?.timer === timer) this.pending = null; reject(new TimeoutError(`No response for Func 0x${value.func.toString(16).padStart(2, '0')} after ${timeoutMs}ms`)); }, timeoutMs);
                this.pending = { resolve, reject, timer, request: {
                    addr: value.addr, func: value.func, stat: value.stat, len: value.data.length,
                    data: value.data.slice(), frame: bytes.slice(),
                }, matcher: options.matcher || (frame => frame.addr === value.addr && frame.func === value.func) };
            });
            // The GATT write itself can take longer than the response timeout.
            // Keep that rejection handled while awaiting the transport write.
            response.catch(() => {});
            // 写入失败时撤销等待状态，否则下一条命令会被残留 pending 干扰。
            try { await this.transport.write(bytes); } catch (error) { clearTimeout(this.pending?.timer); this.pending = null; throw error; }
            return response;
        }
        /**
         * 执行完整能力发现：F0 查询基础信息和 Action 数量，FE 查询描述表版本并逐项枚举。
         * FE/00 是可选步骤，失败只触发 warning，仍会继续 FE/01 枚举。
         */
        async discover(options = {}) {
            const warnings = [];
            const reportWarning = (queryName, error, data = null) => {
                const warning = error instanceof Error ? error : new Error(String(error));
                warning.query = queryName;
                if (data) warning.data = data.slice();
                warnings.push({
                    query: queryName,
                    message: warning.message,
                    data: data ? Array.from(data) : null,
                });
                this.emit('warning', warning);
            };
            // 版本响应是确认 ActionBus 帧方向和设备协议的最低要求；其余字段属于能力目录，
            // 老固件可能只实现 F0/00，不能因为这些可选查询失败而阻断 EEG/状态/方案控制。
            const query = async (queryName, subcommand, maker, expectedLength, required = false) => {
                let data = null;
                try {
                    const frame = await this.sendCommand(maker(this.address), options);
                    data = toBytes(frame.data);
                    if (expectedLength != null && data.length !== expectedLength) {
                        throw new ProtocolError(`${queryName} response requires ${expectedLength} bytes, got ${data.length}`);
                    }
                    return decodeProtocolResponse(subcommand, data);
                } catch (error) {
                    if (required) throw error;
                    reportWarning(queryName, error, data);
                    return null;
                }
            };
            const protocolVersion = await query('protocolVersion', PROTOCOL_QUERY.VERSION, commands.protocolVersion, 2, true);
            const deviceId = await query('deviceId', PROTOCOL_QUERY.DEVICE_ID, commands.deviceId, 5);
            const actionCountValue = await query('actionCount', PROTOCOL_QUERY.ACTION_COUNT, commands.actionCount, 1);
            const uptimeMs = await query('uptime', PROTOCOL_QUERY.UPTIME, commands.uptime, 4);
            const busAddress = await query('busAddress', PROTOCOL_QUERY.ADDRESS, commands.busAddress, 1);
            let schemaVersion = null;
            if (actionCountValue != null) {
                try {
                    const frame = await this.sendCommand(commands.actionSchema(this.address), options);
                    schemaVersion = frame.data[0] ?? null;
                } catch (error) {
                    reportWarning('actionSchema', error);
                }
            }
            const actionCount = Number.isInteger(actionCountValue) && actionCountValue >= 0 && actionCountValue <= 32
                ? actionCountValue : null;
            if (actionCountValue != null && actionCount == null) {
                reportWarning('actionCount', new ProtocolError(`Action count is outside the supported range: ${actionCountValue}`));
            }
            const actions = [];
            if (actionCount != null) {
                for (let index = 0; index < actionCount; index++) {
                    try {
                        actions.push(decodeActionDescription((await this.sendCommand(commands.actionDescription(this.address, index), options)).data));
                    } catch (error) {
                        reportWarning(`actionDescription[${index}]`, error);
                        break;
                    }
                }
            }
            return {
                address: this.address, protocolVersion, deviceId, actionCount, uptimeMs, schemaVersion, busAddress,
                actions, compatibilityMode: warnings.length > 0, capabilityDiscoveryComplete: warnings.length === 0,
                capabilityWarnings: warnings,
            };
        }
        async getStatus(options = {}) { return decodeStatus((await this.sendCommand(commands.status(this.address), options)).data); }
        startIndicator() { return this.sendCommand(commands.startIndicator(this.address)); }
        stopIndicator() { return this.sendCommand(commands.stopIndicator(this.address)); }
        setLightConfig(channel, options) { return this.sendCommand(commands.setLightConfig(this.address, channel, options)); }
        startLight(channel) { return this.sendCommand(commands.startLight(this.address, channel)); }
        stopLight(channel) { return this.sendCommand(commands.stopLight(this.address, channel)); }
        configureEeg(registers) { return this.sendCommand(commands.configureEeg(this.address, registers)); }
        startEeg() { return this.sendCommand(commands.startEeg(this.address)); }
        stopEeg(options = {}) { return this.sendCommand(commands.stopEeg(this.address), options); }
        async readAds1299Registers() { return decodeRegisters((await this.sendCommand(commands.readAds1299Registers(this.address))).data); }
    }

    // ---------------------------------------------------------------------
    // 旧项目兼容层与导出
    // ---------------------------------------------------------------------

    /**
     * 创建旧版 Set_tLS_Frp()/Send_Data() 风格适配器。
     * 新代码应直接使用 BrainLumeClient；此适配器仅用于平滑迁移历史脚本。
     */
    function createLegacyAdapter(options = {}) {
        const transport = options.transport || { write: async bytes => {
            const send = options.Send_Data || (typeof globalThis !== 'undefined' && globalThis.Send_Data); if (typeof send !== 'function') throw new TypeError('Send_Data is required'); return send(Array.from(bytes));
        }, isConnected: () => true };
        const client = options.client || new BrainLumeClient({ address: options.address ?? 1, timeoutMs: options.timeoutMs ?? 1000, transport, eegProcessor: options.eegProcessor });
        return Object.freeze({ client,
            Set_tLS_Frp: (frequencyHz = 40, durationMs = 0, powerPercent = 20) => client.setLightConfig(1, { frequencyHz, durationMs, powerPercent }),
            SetLight1Config: options => client.setLightConfig(1, options), SetLight2Config: options => client.setLightConfig(2, options),
            StartLight1: () => client.startLight(1), StopLight1: () => client.stopLight(1), StartLight2: () => client.startLight(2), StopLight2: () => client.stopLight(2),
            ConfigureEeg: registers => client.configureEeg(registers), StartEeg: () => client.startEeg(), StopEeg: () => client.stopEeg(), FeedData: bytes => client.feed(bytes),
        });
    }

    /**
     * 当前 24 nA N 端导联阻抗测试的 ADS1299 0x01..0x1E 配置模板。
     * 数组索引 0 对应寄存器 0x01，不包含只读 ID(0x00)。使用前仍应按硬件版本复核。
     */
    const ADS1299_IMPEDANCE_24NA_CONFIG = Uint8Array.from([
        0x96, 0xC0, 0xEC, 0x05, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x60,
        0x00, 0xFF, 0x00, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
        0xCF, 0x80, 0x63, 0x80, 0x03, 0x00,
    ]);

    // 顶层命名空间及子模块全部冻结，防止业务代码意外改写协议常量或算法入口。
    return Object.freeze({
        VERSION, FUNC, STAT, PROTOCOL_QUERY, DEVICE_ERROR,
        protocol: Object.freeze({ HEADER_A, HEADER_B, crc16Modbus, buildFrame, parseFrame, ActionBusParser, command, encodeCommand }),
        commands,
        decoders: Object.freeze({ decodeStatus, decodeProtocolResponse, decodeActionDescription, decodeRegisters, decodeEegPayload, decodeLeadOff }),
        data: Object.freeze({ toBytes, readValue, codeToVolts, codeToMicrovolts, peakToPeak }),
        ads1299: Object.freeze({ ADC_FULL_SCALE_CODES, ADS1299_GAINS, LOFF_CURRENTS_AMPS, REGISTER_NAMES: ADS1299_REGISTER_NAMES,
            IMPEDANCE_24NA_CONFIG: ADS1299_IMPEDANCE_24NA_CONFIG, normalizeConfig: normalizeAdsConfig,
            createRecommendedConfig: createRecommendedAdsConfig, gainFromChSet: ads1299GainFromChSet,
            sampleRateFromConfig1, decodeLoff, decodeImpedanceRegisters, compareAdsConfig, CONFIG_REGISTERS: ADS1299_CONFIG_REGISTERS }),
        filters: Object.freeze({ SUPPORTED_SAMPLE_RATES, LEGACY_PRESET: LEGACY_FILTER_PRESET, DISPLAY_PRESET: DISPLAY_FILTER_PRESET,
            MODEL_TRAINING_PRESET: MODEL_TRAINING_FILTER_PRESET, LEGACY_FILTER_CHAINS, TRAINING_FILTER_CHAINS,
            makeBiquad, createDisplayFilterChain, filterChainForPreset, IirFilter, EegFilterBank }),
        spectrum: Object.freeze({ fftMagnitude, fftMagnitudeLog10, peakToPeak }),
        impedance: Object.freeze({ PRESETS: IMPEDANCE_PRESETS, tonePeakCodes, impedanceKohmFromPeakCodes, impedanceKohmFromPeakToPeakCodes,
            normalizePiecewiseCalibration, applyPiecewiseCalibration, commonScaleFromReferences, ImpedanceEstimator }),
        EegProcessor, BrainLumeClient, errors: Object.freeze({ ProtocolError, CrcError, DeviceError, TimeoutError }),
        legacy: Object.freeze({ createAdapter: createLegacyAdapter }),
    });
}));
