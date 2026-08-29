import SwiftUI
import CoreBluetooth
import UIKit
#if canImport(CaoCaoProtocol)
import CaoCaoProtocol
#endif

struct ContentView: View {
    @StateObject private var ble = BluetoothManager()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    connectionCard
                    statusCard
                    waveformCard
                    controls
                    if !ble.discovered.isEmpty { deviceList }
                    if let lastError = ble.lastError {
                        Text(lastError).foregroundStyle(.red).font(.footnote)
                    }
                }
                .padding()
            }
            .navigationTitle("曹操")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("扫描") { ble.scan() }
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("EEG 闭环平台").font(.title3.weight(.semibold))
            Text("CH2 双极差分导联 · 两枚互为参考电极")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var connectionCard: some View {
        GroupBox("设备") {
            HStack {
                Circle().fill(ble.connected ? .green : .gray).frame(width: 10, height: 10)
                Text(ble.connected ? "已连接" : "未连接")
                Spacer()
                if ble.connected {
                    Button("断开") { ble.disconnect() }.buttonStyle(.bordered)
                } else {
                    Button("扫描 BLE") { ble.scan() }.buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private var statusCard: some View {
        GroupBox("状态") {
            HStack {
                VStack(alignment: .leading) {
                    Text("电量").font(.caption).foregroundStyle(.secondary)
                    Text(ble.batteryLevel.map { "\($0)%" } ?? "--%").font(.title2.weight(.bold))
                }
                Spacer()
                VStack(alignment: .trailing) {
                    Text("EEG").font(.caption).foregroundStyle(.secondary)
                    Text(ble.eegRunning ? "RUNNING" : "STOPPED").font(.headline)
                }
            }
            Text(ble.recording ? "EDF 记录中：CH2 原始 µV" : (ble.charging ? "充电中" : "未充电"))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var waveformCard: some View {
        GroupBox("CH2 实时波形") {
            WaveformView(values: ble.waveformMicrovolts)
                .frame(height: 180)
            Text("原始 CH2 µV 同步写入本机 CaoCao/*.edf；桌面端仍是完整归档主端")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack {
                Button("查询状态") { ble.queryStatus() }.buttonStyle(.bordered)
                Button(ble.eegRunning ? "停止 EEG" : "启动 EEG") {
                    ble.eegRunning ? ble.stopEEG() : ble.startEEG()
                }.buttonStyle(.borderedProminent)
            }
            HStack {
                Button("开启光 CH1") { ble.startLight() }.buttonStyle(.bordered)
                Button("停止光 CH1") { ble.stopLight() }.buttonStyle(.bordered)
            }
            Button("全部停止") {
                ble.stopLight()
                ble.stopEEG()
            }
            .buttonStyle(.bordered)
            .tint(.red)
        }
        .disabled(!ble.connected)
    }

    private var deviceList: some View {
        GroupBox("发现的设备") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(ble.discovered, id: \.identifier) { device in
                    Button {
                        ble.connect(device)
                    } label: {
                        HStack {
                            Text(device.name ?? CaoCaoProtocol.deviceName)
                            Spacer()
                            Text("连接").foregroundStyle(.blue)
                        }
                    }
                }
            }
        }
    }
}

private struct WaveformView: View {
    let values: [Double]

    var body: some View {
        GeometryReader { proxy in
            Path { path in
                guard values.count > 1 else { return }
                let minValue = values.min() ?? -1
                let maxValue = values.max() ?? 1
                let span = max(maxValue - minValue, 1e-6)
                for (index, value) in values.enumerated() {
                    let x = proxy.size.width * CGFloat(index) / CGFloat(values.count - 1)
                    let y = proxy.size.height * CGFloat((maxValue - value) / span)
                    if index == 0 { path.move(to: CGPoint(x: x, y: y)) }
                    else { path.addLine(to: CGPoint(x: x, y: y)) }
                }
            }
            .stroke(.teal, lineWidth: 1.2)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }
}
