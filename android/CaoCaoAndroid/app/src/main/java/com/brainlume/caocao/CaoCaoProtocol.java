package com.brainlume.caocao;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;

/** Shared ActionBus 3.0 codec for the Cao Cao Android client. */
public final class CaoCaoProtocol {
    public static final String DEVICE_NAME = "BrainLume2.0C";
    public static final UUID SERVICE_UUID = UUID.fromString("0000ABF0-0000-1000-8000-00805F9B34FB");
    public static final UUID WRITE_UUID = UUID.fromString("0000ABF1-0000-1000-8000-00805F9B34FB");
    public static final UUID NOTIFY_UUID = UUID.fromString("0000ABF2-0000-1000-8000-00805F9B34FB");
    public static final UUID CLIENT_CONFIG_UUID = UUID.fromString("00002902-0000-1000-8000-00805F9B34FB");
    public static final int FIXED_EEG_CHANNEL = 2;
    public static final int SAMPLE_RATE = 250;

    public static final int STATUS = 0x01;
    public static final int INDICATOR = 0x02;
    public static final int LIGHT1_CONFIG = 0x10;
    public static final int LIGHT2_CONFIG = 0x11;
    public static final int LIGHT1_CONTROL = 0x12;
    public static final int LIGHT2_CONTROL = 0x13;
    public static final int EEG_CONFIG = 0x20;
    public static final int EEG_CONTROL = 0x21;
    public static final int EEG_RAW = 0x22;

    public static final int HOST_QUERY = 0x10;
    public static final int HOST_START = 0x11;

    private CaoCaoProtocol() {}

    public static byte[] frame(int function, int status, byte[] payload) {
        byte[] body = new byte[4 + payload.length];
        body[0] = 0x01;
        body[1] = (byte) function;
        body[2] = (byte) status;
        body[3] = (byte) payload.length;
        System.arraycopy(payload, 0, body, 4, payload.length);
        int crc = crc16Modbus(body);
        byte[] result = new byte[body.length + 4];
        result[0] = (byte) 0xAA;
        result[1] = 0x55;
        System.arraycopy(body, 0, result, 2, body.length);
        result[result.length - 2] = (byte) (crc >> 8);
        result[result.length - 1] = (byte) crc;
        return result;
    }

    public static byte[] statusCommand() {
        return frame(STATUS, HOST_QUERY, new byte[0]);
    }

    public static byte[] configureCH2Command() {
        return frame(EEG_CONFIG, HOST_START, new byte[] {
                (byte) 0x96, (byte) 0xC0, (byte) 0xEC, 0x00, (byte) 0x81, 0x60,
                (byte) 0x81, (byte) 0x81, (byte) 0x81, (byte) 0x81, (byte) 0x81, (byte) 0x81,
                0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x20, 0x00, 0x00, 0x00, (byte) 0xCF, (byte) 0x80, 0x63, (byte) 0x80,
                0x03, 0x00
        });
    }

    public static byte[] startEEGCommand() {
        return frame(EEG_CONTROL, HOST_START, new byte[0]);
    }

    public static byte[] stopEEGCommand() {
        return frame(EEG_CONTROL, HOST_QUERY, new byte[0]);
    }

    public static byte[] setLightConfigCommand(int channel, int frequencyHz, int powerPercent) {
        if (channel < 1 || channel > 2) throw new IllegalArgumentException("channel must be 1 or 2");
        if (frequencyHz < 1 || frequencyHz > 100) throw new IllegalArgumentException("frequency out of range");
        if (powerPercent < 0 || powerPercent > 100) throw new IllegalArgumentException("power out of range");
        int function = channel == 1 ? LIGHT1_CONFIG : LIGHT2_CONFIG;
        return frame(function, HOST_START, new byte[] {
                (byte) frequencyHz, 0, 0, 0, 0, (byte) powerPercent
        });
    }

    public static byte[] startLightCommand(int channel) {
        return frame(channel == 1 ? LIGHT1_CONTROL : LIGHT2_CONTROL, HOST_START, new byte[0]);
    }

    public static byte[] stopLightCommand(int channel) {
        return frame(channel == 1 ? LIGHT1_CONTROL : LIGHT2_CONTROL, HOST_QUERY, new byte[0]);
    }

    public static int crc16Modbus(byte[] bytes) {
        int crc = 0xFFFF;
        for (byte value : bytes) {
            crc ^= value & 0xFF;
            for (int i = 0; i < 8; i++) {
                crc = (crc & 1) != 0 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
            }
        }
        return crc & 0xFFFF;
    }

    public static DeviceStatus decodeStatus(byte[] payload) {
        if (payload == null || payload.length < 13) return null;
        long uptime = ((long) (payload[9] & 0xFF) << 24)
                | ((long) (payload[10] & 0xFF) << 16)
                | ((long) (payload[11] & 0xFF) << 8)
                | (payload[12] & 0xFFL);
        return new DeviceStatus(
                payload[0] & 0xFF,
                payload[1] != 0,
                payload[2] != 0,
                payload[3] != 0,
                payload[4] != 0,
                payload[5] & 0xFF,
                uptime
        );
    }

    public static EegFrame decodeEeg(byte[] payload) {
        if (payload == null || payload.length < 29) return null;
        int sequence = ((payload[0] & 0xFF) << 8) | (payload[1] & 0xFF);
        int[] rawCodes = new int[8];
        for (int channel = 0; channel < 8; channel++) {
            rawCodes[channel] = signedInt24(payload, 5 + channel * 3);
        }
        return new EegFrame(sequence, rawCodes);
    }

    private static int signedInt24(byte[] bytes, int offset) {
        int value = ((bytes[offset] & 0xFF) << 16)
                | ((bytes[offset + 1] & 0xFF) << 8)
                | (bytes[offset + 2] & 0xFF);
        return (value & 0x00800000) != 0 ? value | 0xFF000000 : value;
    }

    public static final class DeviceStatus {
        public final int batteryLevel;
        public final boolean charging;
        public final boolean eegRunning;
        public final boolean light1Running;
        public final boolean light2Running;
        public final int lastError;
        public final long uptimeMilliseconds;

        public DeviceStatus(int batteryLevel, boolean charging, boolean eegRunning,
                            boolean light1Running, boolean light2Running, int lastError,
                            long uptimeMilliseconds) {
            this.batteryLevel = batteryLevel;
            this.charging = charging;
            this.eegRunning = eegRunning;
            this.light1Running = light1Running;
            this.light2Running = light2Running;
            this.lastError = lastError;
            this.uptimeMilliseconds = uptimeMilliseconds;
        }
    }

    public static final class EegFrame {
        public final int sequence;
        public final int[] rawCodes;

        public EegFrame(int sequence, int[] rawCodes) {
            this.sequence = sequence;
            this.rawCodes = rawCodes;
        }
    }

    public static final class ActionBusFrame {
        public final int address;
        public final int function;
        public final int status;
        public final byte[] payload;

        public ActionBusFrame(int address, int function, int status, byte[] payload) {
            this.address = address;
            this.function = function;
            this.status = status;
            this.payload = payload;
        }
    }

    /** Handles split notifications, noise before frames, and multiple frames per packet. */
    public static final class Parser {
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

        public List<ActionBusFrame> append(byte[] data) {
            if (data == null || data.length == 0) return new ArrayList<>();
            buffer.write(data, 0, data.length);
            byte[] bytes = buffer.toByteArray();
            List<ActionBusFrame> frames = new ArrayList<>();
            int consumed = 0;
            while (true) {
                int header = indexOf(bytes, (byte) 0xAA, consumed);
                if (header < 0) {
                    consumed = bytes.length;
                    break;
                }
                if (header + 1 >= bytes.length) break;
                if ((bytes[header + 1] & 0xFF) != 0x55) {
                    consumed = header + 1;
                    continue;
                }
                if (bytes.length - header < 8) break;
                int payloadLength = bytes[header + 5] & 0xFF;
                int frameLength = 8 + payloadLength;
                if (bytes.length - header < frameLength) break;
                byte[] candidate = Arrays.copyOfRange(bytes, header, header + frameLength);
                byte[] body = Arrays.copyOfRange(candidate, 2, 6 + payloadLength);
                int receivedCrc = ((candidate[6 + payloadLength] & 0xFF) << 8)
                        | (candidate[7 + payloadLength] & 0xFF);
                if (crc16Modbus(body) != receivedCrc) {
                    consumed = header + 1;
                    continue;
                }
                frames.add(new ActionBusFrame(
                        candidate[2] & 0xFF,
                        candidate[3] & 0xFF,
                        candidate[4] & 0xFF,
                        Arrays.copyOfRange(candidate, 6, 6 + payloadLength)
                ));
                consumed = header + frameLength;
            }
            buffer.reset();
            if (consumed < bytes.length) buffer.write(bytes, consumed, bytes.length - consumed);
            return frames;
        }

        private static int indexOf(byte[] bytes, byte value, int start) {
            for (int i = Math.max(0, start); i < bytes.length; i++) {
                if (bytes[i] == value) return i;
            }
            return -1;
        }
    }
}
