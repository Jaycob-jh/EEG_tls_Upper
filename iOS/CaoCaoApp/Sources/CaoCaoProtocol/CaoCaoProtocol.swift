import Foundation

/// The shared ActionBus codec used by the desktop Upper client and the iPhone client.
/// BLE transport and UI are intentionally kept outside this module so the framing code
/// can be tested without a device.
public enum CaoCaoProtocol {
    public static let deviceName = "BrainLume2.0C"
    public static let serviceUUID = "0000ABF0-0000-1000-8000-00805F9B34FB"
    public static let writeUUID = "0000ABF1-0000-1000-8000-00805F9B34FB"
    public static let notifyUUID = "0000ABF2-0000-1000-8000-00805F9B34FB"
    public static let fixedPlanEEGChannel = 2

    public enum Function {
        public static let status: UInt8 = 0x01
        public static let indicator: UInt8 = 0x02
        public static let light1Config: UInt8 = 0x10
        public static let light2Config: UInt8 = 0x11
        public static let light1Control: UInt8 = 0x12
        public static let light2Control: UInt8 = 0x13
        public static let eegConfig: UInt8 = 0x20
        public static let eegControl: UInt8 = 0x21
        public static let eegRaw: UInt8 = 0x22
    }

    public enum Status {
        public static let hostQuery: UInt8 = 0x10
        public static let hostStart: UInt8 = 0x11
    }

    public static func crc16Modbus(_ bytes: [UInt8]) -> UInt16 {
        var crc: UInt16 = 0xFFFF
        for byte in bytes {
            crc ^= UInt16(byte)
            for _ in 0..<8 {
                crc = (crc & 1) == 1 ? (crc >> 1) ^ 0xA001 : crc >> 1
            }
        }
        return crc
    }

    public static func frame(address: UInt8 = 0x01, function: UInt8, status: UInt8, payload: [UInt8] = []) -> Data {
        precondition(payload.count <= 255, "ActionBus payload exceeds one-byte length field")
        var body = [address, function, status, UInt8(payload.count)] + payload
        let crc = crc16Modbus(body)
        body += [UInt8(crc >> 8), UInt8(crc & 0xFF)]
        return Data([0xAA, 0x55] + body)
    }

    public static func statusCommand() -> Data {
        frame(function: Function.status, status: Status.hostQuery)
    }

    public static func startIndicatorCommand() -> Data {
        frame(function: Function.indicator, status: Status.hostStart)
    }

    public static func stopIndicatorCommand() -> Data {
        frame(function: Function.indicator, status: Status.hostQuery)
    }

    public static func setLightConfigCommand(channel: Int, frequencyHz: Int, powerPercent: Int) -> Data {
        precondition((1...2).contains(channel))
        precondition((1...100).contains(frequencyHz))
        precondition((0...100).contains(powerPercent))
        let function = channel == 1 ? Function.light1Config : Function.light2Config
        // [frequencyHz, durationMs uint32 BE, powerPercent]; duration is fixed to 0.
        return frame(function: function, status: Status.hostStart,
                     payload: [UInt8(frequencyHz), 0, 0, 0, 0, UInt8(powerPercent)])
    }

    public static func startLightCommand(channel: Int) -> Data {
        frame(function: channel == 1 ? Function.light1Control : Function.light2Control,
              status: Status.hostStart)
    }

    public static func stopLightCommand(channel: Int) -> Data {
        frame(function: channel == 1 ? Function.light1Control : Function.light2Control,
              status: Status.hostQuery)
    }

    public static func configureCH2Command(impedance: Bool = false) -> Data {
        let registers: [UInt8] = impedance
            ? [0x96, 0xC0, 0xEC, 0x05, 0x81, 0x60, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81,
               0x00, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
               0xCF, 0x80, 0x63, 0x80, 0x03, 0x00]
            : [0x96, 0xC0, 0xEC, 0x00, 0x81, 0x60, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81,
               0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00, 0x00,
               0xCF, 0x80, 0x63, 0x80, 0x03, 0x00]
        return frame(function: Function.eegConfig, status: Status.hostStart, payload: registers)
    }

    public static func startEEGCommand() -> Data {
        frame(function: Function.eegControl, status: Status.hostStart)
    }

    public static func stopEEGCommand() -> Data {
        frame(function: Function.eegControl, status: Status.hostQuery)
    }

    public static func bigEndianUInt32(_ bytes: [UInt8], at offset: Int) -> UInt32? {
        guard offset >= 0, offset + 4 <= bytes.count else { return nil }
        return (UInt32(bytes[offset]) << 24)
            | (UInt32(bytes[offset + 1]) << 16)
            | (UInt32(bytes[offset + 2]) << 8)
            | UInt32(bytes[offset + 3])
    }

    public static func signedInt24(_ bytes: [UInt8], at offset: Int) -> Int32? {
        guard offset >= 0, offset + 3 <= bytes.count else { return nil }
        var value = (Int32(bytes[offset]) << 16)
            | (Int32(bytes[offset + 1]) << 8)
            | Int32(bytes[offset + 2])
        if value & 0x0080_0000 != 0 { value |= Int32(bitPattern: 0xFF00_0000) }
        return value
    }

    public static func decodeStatus(_ payload: [UInt8]) -> DeviceStatus? {
        guard payload.count >= 13, let uptime = bigEndianUInt32(payload, at: 9) else { return nil }
        return DeviceStatus(
            batteryLevel: Int(payload[0]),
            charging: payload[1] != 0,
            eegRunning: payload[2] != 0,
            light1Running: payload[3] != 0,
            light2Running: payload[4] != 0,
            lastError: payload[5],
            uptimeMilliseconds: uptime
        )
    }

    public static func decodeEEG(_ payload: [UInt8]) -> EEGFrame? {
        guard payload.count >= 29 else { return nil }
        let sequence = (UInt16(payload[0]) << 8) | UInt16(payload[1])
        var values: [Int32] = []
        for channel in 0..<8 {
            guard let value = signedInt24(payload, at: 5 + channel * 3) else { return nil }
            values.append(value)
        }
        return EEGFrame(sequence: sequence, rawCodes: values)
    }
}

public struct DeviceStatus {
    public let batteryLevel: Int
    public let charging: Bool
    public let eegRunning: Bool
    public let light1Running: Bool
    public let light2Running: Bool
    public let lastError: UInt8
    public let uptimeMilliseconds: UInt32
}

public struct EEGFrame {
    public let sequence: UInt16
    public let rawCodes: [Int32]
}

public struct ActionBusFrame {
    public let address: UInt8
    public let function: UInt8
    public let status: UInt8
    public let payload: [UInt8]
}

/// Handles split notifications, noise before a frame, and multiple frames in one BLE packet.
public final class ActionBusParser {
    private var buffer: [UInt8] = []

    public init() {}

    public func append(_ data: Data) -> [ActionBusFrame] {
        buffer.append(contentsOf: data)
        var frames: [ActionBusFrame] = []
        while true {
            guard let header = buffer.firstIndex(of: 0xAA) else {
                buffer.removeAll(keepingCapacity: true)
                break
            }
            if header > 0 { buffer.removeFirst(header) }
            guard buffer.count >= 8, buffer[1] == 0x55 else {
                buffer.removeFirst()
                continue
            }
            let payloadLength = Int(buffer[5])
            let frameLength = 8 + payloadLength
            guard buffer.count >= frameLength else { break }
            let candidate = Array(buffer.prefix(frameLength))
            let body = Array(candidate[2..<(6 + payloadLength)])
            let receivedCRC = (UInt16(candidate[6 + payloadLength]) << 8)
                | UInt16(candidate[7 + payloadLength])
            if CaoCaoProtocol.crc16Modbus(body) != receivedCRC {
                buffer.removeFirst()
                continue
            }
            frames.append(ActionBusFrame(
                address: candidate[2], function: candidate[3], status: candidate[4],
                payload: Array(candidate[6..<(6 + payloadLength)])
            ))
            buffer.removeFirst(frameLength)
        }
        return frames
    }
}
