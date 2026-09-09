package com.brainlume.caocao;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Minimal one-signal EDF writer for fixed 250 SPS CH2 bipolar EEG. */
public final class EdfWriter implements AutoCloseable {
    // Keep the Android archive's physical calibration aligned with the Upper
    // EDF writer.  A ±500 µV clamp silently destroyed large transients and
    // made Android EDF files incomparable with desktop recordings.
    private static final double PHYSICAL_MIN_UV = -187_500.0;
    private static final double PHYSICAL_MAX_UV = 187_500.0;
    private static final DateTimeFormatter FILE_TIME = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss", Locale.US);
    private final File file;
    private final RandomAccessFile output;
    private final List<Double> pending = new ArrayList<>();
    private int records;
    private int receivedSamples;
    private boolean finalized;

    public EdfWriter(File file) throws IOException {
        this.file = file;
        this.output = new RandomAccessFile(file, "rw");
        this.output.setLength(0);
        this.output.write(header());
    }

    public static String newFileName() {
        return "eeg_CH2_" + LocalDateTime.now().format(FILE_TIME) + ".edf.partial";
    }

    public int getReceivedSamples() {
        return receivedSamples;
    }

    public File getFile() {
        return file;
    }

    public void append(double microvolts) throws IOException {
        if (!Double.isFinite(microvolts) || finalized) return;
        pending.add(microvolts);
        receivedSamples++;
        while (pending.size() >= CaoCaoProtocol.SAMPLE_RATE) {
            writeRecord(pending.subList(0, CaoCaoProtocol.SAMPLE_RATE));
            pending.subList(0, CaoCaoProtocol.SAMPLE_RATE).clear();
        }
    }

    public void finish() throws IOException {
        if (finalized) return;
        if (!pending.isEmpty()) {
            double fill = pending.get(pending.size() - 1);
            while (pending.size() < CaoCaoProtocol.SAMPLE_RATE) pending.add(fill);
            writeRecord(pending);
            pending.clear();
        }
        output.seek(236);
        output.write(asciiField(Integer.toString(records), 8));
        output.getFD().sync();
        output.close();
        finalized = true;
        String finalName = file.getName().replace(".edf.partial", ".edf");
        File finalFile = new File(file.getParentFile(), finalName);
        if (!file.renameTo(finalFile)) {
            throw new IOException("无法将 EDF 临时文件改名为 " + finalFile.getName());
        }
    }

    @Override
    public void close() throws IOException {
        finish();
    }

    private void writeRecord(List<Double> values) throws IOException {
        for (double value : values) {
            double clamped = Math.min(PHYSICAL_MAX_UV, Math.max(PHYSICAL_MIN_UV, value));
            double normalized = (clamped - PHYSICAL_MIN_UV) / (PHYSICAL_MAX_UV - PHYSICAL_MIN_UV);
            int digital = (int) Math.round(normalized * 65535.0 - 32768.0);
            output.write(digital & 0xFF);
            output.write((digital >>> 8) & 0xFF);
        }
        records++;
    }

    private byte[] header() {
        LocalDateTime now = LocalDateTime.now();
        String date = String.format(Locale.US, "%02d.%02d.%02d", now.getDayOfMonth(), now.getMonthValue(), now.getYear() % 100);
        String time = String.format(Locale.US, "%02d.%02d.%02d", now.getHour(), now.getMinute(), now.getSecond());
        byte[] header = concat(
                asciiField("0", 8), asciiField("", 80), asciiField("Cao Cao Android CH2", 80),
                asciiField(date, 8), asciiField(time, 8), asciiField("512", 8), asciiField("24BIT", 44),
                asciiField("-1", 8), asciiField("1", 8), asciiField("1", 4), asciiField("CH2", 16),
                asciiField("bipolar differential", 80), asciiField("uV", 8), asciiField("-187500", 8),
                asciiField("187500", 8), asciiField("-32768", 8), asciiField("32767", 8),
                asciiField("raw CH2; Android EDF archive", 80), asciiField("250", 8), asciiField("", 32)
        );
        if (header.length != 512) throw new IllegalStateException("EDF header must be 512 bytes");
        return header;
    }

    private static byte[] asciiField(String value, int length) {
        byte[] result = new byte[length];
        byte[] source = value.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        int count = Math.min(source.length, length);
        System.arraycopy(source, 0, result, 0, count);
        for (int i = count; i < length; i++) result[i] = 0x20;
        return result;
    }

    private static byte[] concat(byte[]... arrays) {
        int length = 0;
        for (byte[] array : arrays) length += array.length;
        byte[] result = new byte[length];
        int offset = 0;
        for (byte[] array : arrays) {
            System.arraycopy(array, 0, result, offset, array.length);
            offset += array.length;
        }
        return result;
    }
}
