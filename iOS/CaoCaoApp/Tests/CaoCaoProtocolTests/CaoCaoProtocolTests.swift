import XCTest
@testable import CaoCaoProtocol

final class CaoCaoProtocolTests: XCTestCase {
    private func hex(_ data: Data) -> String {
        data.map { String(format: "%02X", $0) }.joined()
    }

    func testIndicatorGoldenVectors() {
        XCTAssertEqual(hex(CaoCaoProtocol.startIndicatorCommand()), "AA550102110048AC")
        XCTAssertEqual(hex(CaoCaoProtocol.stopIndicatorCommand()), "AA5501021000D8AD")
    }

    func testSplitParserAndFixedCH2Config() {
        let bytes = CaoCaoProtocol.configureCH2Command()
        let parser = ActionBusParser()
        let split = Array(bytes)
        var frames = parser.append(Data([0x00, 0x7F] + Array(split.prefix(7))))
        frames += parser.append(Data(split.dropFirst(7)))
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].function, CaoCaoProtocol.Function.eegConfig)
        XCTAssertEqual(frames[0].payload.count, 30)
        XCTAssertEqual(frames[0].payload[5], 0x60, "CH2 must be the only enabled EEG channel")
        XCTAssertEqual(CaoCaoProtocol.fixedPlanEEGChannel, 2)
    }

    func testStatusAndEEGDecoding() {
        let status = CaoCaoProtocol.decodeStatus([57, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 42])
        XCTAssertEqual(status?.batteryLevel, 57)
        XCTAssertEqual(status?.charging, true)
        let payload = [UInt8(0), 1, 0, 0, 0] + Array(repeating: UInt8(0), count: 24)
        XCTAssertEqual(CaoCaoProtocol.decodeEEG(payload)?.sequence, 1)
    }
}
