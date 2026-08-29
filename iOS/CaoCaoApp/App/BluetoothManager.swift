import Foundation
import CoreBluetooth
import Combine
#if canImport(CaoCaoProtocol)
import CaoCaoProtocol
#endif

@MainActor
final class BluetoothManager: NSObject, ObservableObject {
    @Published private(set) var bluetoothState: CBManagerState = .unknown
    @Published private(set) var discovered: [CBPeripheral] = []
    @Published private(set) var connected = false
    @Published private(set) var batteryLevel: Int?
    @Published private(set) var charging = false
    @Published private(set) var eegRunning = false
    @Published private(set) var lightRunning = false
    @Published private(set) var recording = false
    @Published private(set) var recordingURL: URL?
    @Published private(set) var waveformMicrovolts: [Double] = []
    @Published private(set) var lastError: String?
    @Published private(set) var lastUpdate: Date?

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var notifyCharacteristic: CBCharacteristic?
    private let parser = ActionBusParser()
    private var pendingWrites: [Data] = []
    private var writeInFlight = false
    private var waveformBuffer: [Double] = []
    private var edfWriter: EdfWriter?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    func scan() {
        guard bluetoothState == .poweredOn else {
            lastError = "请先在系统设置中打开蓝牙"
            return
        }
        discovered.removeAll()
        lastError = nil
        central.scanForPeripherals(
            withServices: [CBUUID(string: CaoCaoProtocol.serviceUUID)],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    func stopScan() {
        central.stopScan()
    }

    func connect(_ candidate: CBPeripheral) {
        stopScan()
        lastError = nil
        peripheral = candidate
        candidate.delegate = self
        central.connect(candidate, options: nil)
    }

    func disconnect() {
        stopRecording()
        guard let peripheral else { return }
        central.cancelPeripheralConnection(peripheral)
    }

    func queryStatus() {
        enqueue(CaoCaoProtocol.statusCommand())
    }

    func startEEG() {
        guard connected else { lastError = "设备尚未连接"; return }
        startRecording()
        guard recording else { return }
        enqueue(CaoCaoProtocol.configureCH2Command())
        enqueue(CaoCaoProtocol.startEEGCommand())
    }

    func stopEEG() {
        enqueue(CaoCaoProtocol.stopEEGCommand())
        stopRecording()
    }

    func startLight() {
        enqueue(CaoCaoProtocol.setLightConfigCommand(channel: 1, frequencyHz: 10, powerPercent: 5))
        enqueue(CaoCaoProtocol.startLightCommand(channel: 1))
    }

    func stopLight() {
        enqueue(CaoCaoProtocol.stopLightCommand(channel: 1))
    }

    func startRecording() {
        guard !recording else { return }
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("CaoCao", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyyMMdd_HHmmss"
            let stamp = formatter.string(from: Date())
            let finalURL = directory.appendingPathComponent("eeg_CH2_\(stamp).edf")
            let partialURL = directory.appendingPathComponent("eeg_CH2_\(stamp).edf.partial")
            edfWriter = try EdfWriter(url: partialURL)
            recordingURL = finalURL
            recording = true
        } catch {
            lastError = "EDF 创建失败：\(error.localizedDescription)"
        }
    }

    func stopRecording() {
        guard let edfWriter else { return }
        do {
            try edfWriter.finalize()
            if let recordingURL, FileManager.default.fileExists(atPath: recordingURL.path) {
                lastError = "EDF 文件已存在，保留 partial 文件：\(edfWriter.url.lastPathComponent)"
            } else if let recordingURL {
                try FileManager.default.moveItem(at: edfWriter.url, to: recordingURL)
            }
        } catch { lastError = "EDF 关闭失败：\(error.localizedDescription)" }
        self.edfWriter = nil
        recording = false
    }

    private func enqueue(_ data: Data) {
        guard connected else {
            lastError = "设备尚未连接"
            return
        }
        pendingWrites.append(data)
        drainWrites()
    }

    private func drainWrites() {
        guard !writeInFlight, let characteristic = writeCharacteristic, !pendingWrites.isEmpty else { return }
        writeInFlight = true
        peripheral?.writeValue(pendingWrites.removeFirst(), for: characteristic, type: .withResponse)
    }

    private func resetConnectionState() {
        connected = false
        eegRunning = false
        lightRunning = false
        batteryLevel = nil
        charging = false
        writeCharacteristic = nil
        notifyCharacteristic = nil
        pendingWrites.removeAll()
        writeInFlight = false
        waveformBuffer.removeAll()
        waveformMicrovolts = []
    }

    private func consume(_ frame: ActionBusFrame) {
        switch frame.function {
        case CaoCaoProtocol.Function.status:
            if let status = CaoCaoProtocol.decodeStatus(frame.payload) {
                batteryLevel = min(100, max(0, status.batteryLevel))
                charging = status.charging
                eegRunning = status.eegRunning
                lightRunning = status.light1Running || status.light2Running
                lastUpdate = Date()
            }
        case CaoCaoProtocol.Function.eegRaw:
            guard let eeg = CaoCaoProtocol.decodeEEG(frame.payload), eeg.rawCodes.count >= 2 else { return }
            // CH2 is a bipolar differential lead made from two mutually referenced electrodes.
            let code = Double(eeg.rawCodes[CaoCaoProtocol.fixedPlanEEGChannel - 1])
            let microvolts = code * 4.5 * 1_000_000 / (24 * 8_388_608)
            do { try edfWriter?.append(microvolts: microvolts) }
            catch { lastError = "EDF 写入失败：\(error.localizedDescription)"; stopRecording() }
            waveformBuffer.append(microvolts)
            if waveformBuffer.count > 1500 { waveformBuffer.removeFirst(waveformBuffer.count - 1500) }
            // Avoid publishing a SwiftUI array on every 250 SPS notification.
            if Int(eeg.sequence) % 10 == 0 { waveformMicrovolts = waveformBuffer }
        default:
            break
        }
    }
}

extension BluetoothManager: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        bluetoothState = central.state
        if central.state != .poweredOn { resetConnectionState() }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                       advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = advertisedName ?? peripheral.name ?? ""
        guard name.hasPrefix("BrainLume") || name == CaoCaoProtocol.deviceName else { return }
        if !discovered.contains(where: { $0.identifier == peripheral.identifier }) { discovered.append(peripheral) }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        self.peripheral = peripheral
        peripheral.delegate = self
        connected = true
        lastError = nil
        peripheral.discoverServices([CBUUID(string: CaoCaoProtocol.serviceUUID)])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        resetConnectionState()
        lastError = error?.localizedDescription ?? "BLE 连接失败"
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        resetConnectionState()
        if let error { lastError = "BLE 已断开：\(error.localizedDescription)" }
    }
}

extension BluetoothManager: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        guard let service = peripheral.services?.first(where: { $0.uuid == CBUUID(string: CaoCaoProtocol.serviceUUID) }) else {
            lastError = "未发现 ABF0 服务"
            return
        }
        peripheral.discoverCharacteristics([
            CBUUID(string: CaoCaoProtocol.writeUUID),
            CBUUID(string: CaoCaoProtocol.notifyUUID),
        ], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error { lastError = error.localizedDescription; return }
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == CBUUID(string: CaoCaoProtocol.writeUUID) { writeCharacteristic = characteristic }
            if characteristic.uuid == CBUUID(string: CaoCaoProtocol.notifyUUID) {
                notifyCharacteristic = characteristic
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
        drainWrites()
        queryStatus()
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        writeInFlight = false
        if let error { lastError = "BLE 写入失败：\(error.localizedDescription)" }
        drainWrites()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { lastError = "BLE 通知读取失败：\(error.localizedDescription)"; return }
        guard characteristic.uuid == CBUUID(string: CaoCaoProtocol.notifyUUID), let data = characteristic.value else { return }
        for frame in parser.append(data) { consume(frame) }
    }
}
