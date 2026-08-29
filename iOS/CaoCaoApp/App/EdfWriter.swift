import Foundation

/// Minimal one-signal EDF writer for the fixed 250 SPS CH2 bipolar lead.
/// It writes physical microvolts to EDF and never replaces the desktop archive.
final class EdfWriter {
    private let handle: FileHandle
    private let sampleRate = 250
    private var pending: [Double] = []
    private(set) var receivedSamples = 0
    private var records = 0

    let url: URL

    init(url: URL, startDate: Date = Date()) throws {
        self.url = url
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try FileHandle(forWritingTo: url)
        try handle.write(contentsOf: Self.header(startDate: startDate))
    }

    func append(microvolts: Double) throws {
        guard microvolts.isFinite else { return }
        pending.append(microvolts)
        receivedSamples += 1
        while pending.count >= sampleRate {
            try writeRecord(Array(pending.prefix(sampleRate)))
            pending.removeFirst(sampleRate)
        }
    }

    func finalize() throws {
        if !pending.isEmpty {
            let fill = pending.last ?? 0
            try writeRecord(pending + Array(repeating: fill, count: sampleRate - pending.count))
            pending.removeAll()
        }
        try handle.seek(toFileOffset: 236)
        try handle.write(contentsOf: Self.asciiField(String(records), length: 8))
        try handle.synchronize()
        try handle.close()
    }

    private func writeRecord(_ values: [Double]) throws {
        var data = Data(capacity: sampleRate * 2)
        for value in values {
            let clamped = min(500, max(-500, value))
            let normalized = (clamped + 500) / 1000
            let digital = Int16((normalized * 65535 - 32768).rounded())
            data.append(UInt8(truncatingIfNeeded: digital))
            data.append(UInt8(truncatingIfNeeded: digital >> 8))
        }
        try handle.write(contentsOf: data)
        records += 1
    }

    private static func asciiField(_ value: String, length: Int) -> Data {
        let ascii = Array(value.utf8.prefix(length))
        return Data(ascii + Array(repeating: 0x20, count: max(0, length - ascii.count)))
    }

    private static func header(startDate: Date) -> Data {
        let calendar = Calendar(identifier: .gregorian)
        let components = calendar.dateComponents([.day, .month, .year, .hour, .minute, .second], from: startDate)
        let date = String(format: "%02d.%02d.%02d", components.day ?? 1, components.month ?? 1, (components.year ?? 2000) % 100)
        let time = String(format: "%02d.%02d.%02d", components.hour ?? 0, components.minute ?? 0, components.second ?? 0)
        var header = Data()
        header.append(asciiField("0", length: 8))
        header.append(asciiField("", length: 80))
        header.append(asciiField("Cao Cao CH2", length: 80))
        header.append(asciiField(date, length: 8))
        header.append(asciiField(time, length: 8))
        header.append(asciiField("512", length: 8))
        header.append(asciiField("24BIT", length: 44))
        header.append(asciiField("-1", length: 8))
        header.append(asciiField("1", length: 8))
        header.append(asciiField("1", length: 4))
        header.append(asciiField("CH2", length: 16))
        header.append(asciiField("bipolar differential", length: 80))
        header.append(asciiField("uV", length: 8))
        header.append(asciiField("-500", length: 8))
        header.append(asciiField("500", length: 8))
        header.append(asciiField("-32768", length: 8))
        header.append(asciiField("32767", length: 8))
        header.append(asciiField("raw CH2; EDF archive", length: 80))
        header.append(asciiField("250", length: 8))
        header.append(asciiField("", length: 32))
        return header
    }
}
