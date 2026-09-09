package com.brainlume.caocao;

import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.pdf.PdfDocument;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * On-device counterpart of Upper's analysis-core.js/analysis-worker.js.
 *
 * The implementation deliberately keeps the same signal boundary as Upper:
 * EDF contains one raw CH2 bipolar-differential signal in microvolts, while
 * zero-phase filtering, Welch PSD and STFT are analysis-only operations.
 * It is not a sleep-scoring ground truth and never controls stimulation.
 */
public final class AndroidAnalysisEngine {
    private static final double DIGITAL_MIN = -32768.0;
    private static final double DIGITAL_MAX = 32767.0;
    private static final String[] STAGES = {"W", "N1", "N2", "N3", "REM"};
    private static final String[] BAND_IDS = {"delta", "theta", "alpha", "beta", "gamma", "stimulus40"};
    private static final String[] BAND_LABELS = {"Delta", "Theta", "Alpha", "Beta", "Gamma", "39-41 Hz"};
    private static final double[] BAND_LOW = {0.5, 4, 8, 13, 30, 39};
    private static final double[] BAND_HIGH = {4, 8, 13, 30, 45, 41};

    private AndroidAnalysisEngine() {}

    public static final class Session {
        private final File directory;
        private final String sessionId;
        private final JSONObject metadata;
        private final double[] raw;
        private final double[] filtered;
        private final double sampleRateHz;
        private final double durationSeconds;
        private final JSONArray events;
        private JSONArray segments;
        private JSONArray phaseMetrics;
        private final JSONArray epochs;
        private final JSONObject metrics;
        private final JSONObject integrity;
        private final JSONArray warnings;
        private final JSONObject onlineSleepMetrics;

        private Session(File directory, String sessionId, JSONObject metadata, EdfData data,
                        JSONArray events) throws Exception {
            this.directory = directory;
            this.sessionId = sessionId;
            this.metadata = metadata;
            this.raw = data.values;
            this.sampleRateHz = data.sampleRateHz > 0
                    ? data.sampleRateHz : metadata.optDouble("sampleRateHz", 250.0);
            this.durationSeconds = raw.length / Math.max(1.0, sampleRateHz);
            this.events = events;
            this.filtered = zeroPhaseFilter(raw, sampleRateHz);

            Pairing pairing = pairLightEvents(events, durationSeconds, sampleRateHz);
            this.segments = pairing.segments;
            this.warnings = pairing.warnings;
            this.metrics = basicMetrics(raw, filtered, sampleRateHz);
            this.epochs = analyzeEpochs(filtered, sampleRateHz);
            this.integrity = new JSONObject();
            integrity.put("validSamples", raw.length);
            integrity.put("invalidRows", data.invalidRows);
            integrity.put("seqGaps", data.seqGaps);
            integrity.put("clippingSamples", data.clippingSamples);
            integrity.put("effectiveSampleRateHz", sampleRateHz);
            integrity.put("epochs", epochs.length());
            int rejected = 0;
            for (int index = 0; index < epochs.length(); index++) {
                if (epochs.getJSONObject(index).optBoolean("rejected", false)) rejected++;
            }
            integrity.put("rejectedEpochs", rejected);
            integrity.put("usableEpochPercent", epochs.length() == 0
                    ? 0 : (epochs.length() - rejected) * 100.0 / epochs.length());
            this.onlineSleepMetrics = computeOnlineSleepMetrics(events);
            recomputePhaseMetrics();
        }

        public static Session open(File directory, String sessionId) throws Exception {
            if (directory == null || !directory.isDirectory()) {
                throw new IOException("采集会话目录不存在");
            }
            JSONObject metadata = readJson(new File(directory, "session.json"), new JSONObject());
            File edf = new File(directory, "eeg_raw.edf");
            if (!edf.isFile()) edf = new File(directory, "eeg_raw.edf.partial");
            EdfData data;
            if (edf.isFile()) data = readEdf(edf);
            else data = readCsv(new File(directory, "eeg_raw.csv"), metadata.optDouble("sampleRateHz", 250));
            if (data.values.length == 0) throw new IOException("该会话没有可分析的 EEG 数据");
            JSONArray events = readEvents(new File(directory, "events.jsonl"));
            return new Session(directory, sessionId, metadata, data, events);
        }

        public JSONObject summary(boolean includeEpochs, boolean includeSpectra) throws JSONException {
            JSONObject result = new JSONObject();
            result.put("analysisId", "android-analysis-" + sessionId);
            result.put("metadata", metadata);
            result.put("sourceFile", new File(directory, "eeg_raw.edf").isFile()
                    ? new File(directory, "eeg_raw.edf").getAbsolutePath()
                    : new File(directory, "eeg_raw.csv").getAbsolutePath());
            result.put("sampleRateHz", sampleRateHz);
            result.put("durationSeconds", durationSeconds);
            result.put("integrity", integrity);
            result.put("metrics", includeSpectra ? metrics : withoutPsd(metrics));
            result.put("onlineSleepMetrics", onlineSleepMetrics);
            result.put("segments", segments);
            result.put("phaseMetrics", includeSpectra ? phaseMetrics : withoutPhaseSpectra(phaseMetrics));
            result.put("warnings", warnings);
            if (includeEpochs) result.put("epochs", epochs);
            return result;
        }

        public JSONObject viewport(String source, int startSample, int endSample, int pixelWidth) throws JSONException {
            double[] values = "raw".equalsIgnoreCase(source) ? raw : filtered;
            int start = clampInt(startSample, 0, Math.max(0, values.length - 1));
            int end = clampInt(endSample, start + 1, values.length);
            if (end <= start) end = Math.min(values.length, start + 1);
            int width = clampInt(pixelWidth, 1, 10000);
            JSONObject result = new JSONObject();
            result.put("startSample", start);
            result.put("endSample", end);
            result.put("source", source);
            result.put("sampleRateHz", sampleRateHz);
            if (end - start <= width * 1.25) {
                JSONArray samples = new JSONArray();
                double minimum = Double.POSITIVE_INFINITY;
                double maximum = Double.NEGATIVE_INFINITY;
                for (int index = start; index < end; index++) {
                    double value = finite(values[index]);
                    samples.put(value);
                    minimum = Math.min(minimum, value);
                    maximum = Math.max(maximum, value);
                }
                result.put("mode", "line");
                result.put("samples", samples);
                result.put("minimum", finiteOrZero(minimum));
                result.put("maximum", finiteOrZero(maximum));
                return result;
            }
            JSONArray lows = new JSONArray();
            JSONArray highs = new JSONArray();
            double minimum = Double.POSITIVE_INFINITY;
            double maximum = Double.NEGATIVE_INFINITY;
            for (int pixel = 0; pixel < width; pixel++) {
                int bucketStart = start + (int) Math.floor((double) pixel * (end - start) / width);
                int bucketEnd = Math.min(end, start + (int) Math.ceil((double) (pixel + 1) * (end - start) / width));
                double low = Double.POSITIVE_INFINITY;
                double high = Double.NEGATIVE_INFINITY;
                for (int index = bucketStart; index < Math.max(bucketStart + 1, bucketEnd); index++) {
                    if (index >= end) break;
                    double value = finite(values[index]);
                    low = Math.min(low, value);
                    high = Math.max(high, value);
                }
                if (!Double.isFinite(low)) low = high = 0;
                lows.put(low);
                highs.put(high);
                minimum = Math.min(minimum, low);
                maximum = Math.max(maximum, high);
            }
            result.put("mode", "envelope");
            result.put("lows", lows);
            result.put("highs", highs);
            result.put("minimum", finiteOrZero(minimum));
            result.put("maximum", finiteOrZero(maximum));
            return result;
        }

        public JSONObject spectrogram(String source, double windowSeconds, double maxHz, int maxTimeBins)
                throws JSONException {
            double[] values = "raw".equalsIgnoreCase(source) ? raw : filtered;
            double requested = clampDouble(windowSeconds <= 0 ? 2 : windowSeconds, 0.5, 8);
            int windowSamples = Math.min(values.length, Math.max(8, (int) Math.round(requested * sampleRateHz)));
            double overlap = 0.75;
            int hopSamples = Math.max(1, (int) Math.round(windowSamples * (1 - overlap)));
            double hz = clampDouble(maxHz <= 0 ? 45 : maxHz, 1, sampleRateHz / 2.0);
            int binsLimit = clampInt(maxTimeBins, 20, 1200);
            JSONObject result = new JSONObject();
            result.put("source", source);
            result.put("maxHz", hz);
            result.put("windowSamples", windowSamples);
            result.put("hopSamples", hopSamples);
            if (windowSamples < 8) {
                result.put("times", new JSONArray());
                result.put("frequencies", new JSONArray());
                result.put("powerDb", new JSONArray());
                result.put("timeBins", 0);
                result.put("frequencyBins", 0);
                result.put("windowSeconds", requested);
                return result;
            }
            ArrayList<Integer> starts = new ArrayList<>();
            for (int start = 0; start + windowSamples <= values.length; start += hopSamples) starts.add(start);
            if (starts.isEmpty()) starts.add(0);
            int stride = Math.max(1, (int) Math.ceil((double) starts.size() / binsLimit));
            ArrayList<Integer> selected = new ArrayList<>();
            for (int index = 0; index < starts.size(); index += stride) selected.add(starts.get(index));
            Psd first = fftPower(slice(values, selected.get(0), selected.get(0) + windowSamples), sampleRateHz);
            int frequencyBins = Math.min(first.power.length, (int) Math.floor(hz / first.binHz) + 1);
            JSONArray times = new JSONArray();
            JSONArray frequencies = new JSONArray();
            JSONArray powerDb = new JSONArray();
            for (int index = 0; index < frequencyBins; index++) frequencies.put(index * first.binHz);
            ArrayList<Double> finiteDb = new ArrayList<>();
            for (int start : selected) {
                Psd spectrum = fftPower(slice(values, start, start + windowSamples), sampleRateHz);
                times.put((start + windowSamples / 2.0) / sampleRateHz);
                for (int frequencyIndex = 0; frequencyIndex < frequencyBins; frequencyIndex++) {
                    double db = 10 * Math.log10(Math.max(Double.MIN_NORMAL, spectrum.power[frequencyIndex]));
                    powerDb.put(db);
                    if (Double.isFinite(db)) finiteDb.add(db);
                }
            }
            Collections.sort(finiteDb);
            double colorMin = quantile(finiteDb, 0.05);
            double colorMax = quantile(finiteDb, 0.95);
            if (colorMax - colorMin < 1) { colorMin -= 0.5; colorMax += 0.5; }
            result.put("times", times);
            result.put("frequencies", frequencies);
            result.put("powerDb", powerDb);
            result.put("timeBins", selected.size());
            result.put("frequencyBins", frequencyBins);
            result.put("windowSeconds", windowSamples / sampleRateHz);
            result.put("colorMinDb", colorMin);
            result.put("colorMaxDb", colorMax);
            return result;
        }

        public synchronized JSONObject updateSegments(JSONArray input) throws JSONException {
            this.segments = validateSegments(input, durationSeconds);
            recomputePhaseMetrics();
            return summary(false, false);
        }

        public JSONObject exportReport(File outputDirectory) throws Exception {
            if (!outputDirectory.exists() && !outputDirectory.mkdirs()) throw new IOException("无法创建分析报告目录");
            JSONObject report = summary(true, true);
            report.put("generatedAt", Instant.now().toString());
            File jsonFile = new File(outputDirectory, "android_analysis_summary.json");
            try (FileOutputStream output = new FileOutputStream(jsonFile)) {
                output.write(report.toString(2).getBytes(StandardCharsets.UTF_8));
            }
            File pdfFile = new File(outputDirectory, "android_analysis_report.pdf");
            writePdf(pdfFile, report);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("pdfPath", pdfFile.getAbsolutePath());
            result.put("jsonPath", jsonFile.getAbsolutePath());
            result.put("dataDirectory", outputDirectory.getAbsolutePath());
            return result;
        }

        private void recomputePhaseMetrics() throws JSONException {
            JSONArray output = new JSONArray();
            for (int index = 0; index < segments.length(); index++) {
                JSONObject segment = segments.getJSONObject(index);
                JSONObject item = new JSONObject(segment.toString());
                JSONObject phases = new JSONObject();
                phaseFor(phases, "before", segment.optDouble("preStartSec", 0), segment.optDouble("startSec", 0));
                phaseFor(phases, "during", segment.optDouble("startSec", 0), segment.optDouble("endSec", 0));
                phaseFor(phases, "after", segment.optDouble("endSec", 0), segment.optDouble("postEndSec", 0));
                JSONObject before = phases.optJSONObject("before");
                for (String phaseId : new String[]{"during", "after"}) {
                    JSONObject phase = phases.optJSONObject(phaseId);
                    JSONObject changes = new JSONObject();
                    if (phase != null && before != null) {
                        JSONObject beforeBands = before.optJSONObject("bandPowers");
                        JSONObject phaseBands = phase.optJSONObject("bandPowers");
                        if (beforeBands != null && phaseBands != null) {
                            for (String id : BAND_IDS) {
                                double baseline = beforeBands.optJSONObject(id) == null ? 0
                                        : beforeBands.optJSONObject(id).optDouble("absolute", 0);
                                double current = phaseBands.optJSONObject(id) == null ? 0
                                        : phaseBands.optJSONObject(id).optDouble("absolute", 0);
                                changes.put(id, baseline > 0 ? (current - baseline) / baseline * 100 : 0);
                            }
                        }
                    }
                    if (phase != null) phase.put("changeFromBeforePercent", changes);
                }
                item.put("phases", phases);
                output.put(item);
            }
            this.phaseMetrics = output;
        }

        private void phaseFor(JSONObject phases, String id, double startSec, double endSec) throws JSONException {
            int start = clampInt((int) Math.floor(startSec * sampleRateHz), 0, raw.length);
            int end = clampInt((int) Math.ceil(endSec * sampleRateHz), start, raw.length);
            double[] values = Arrays.copyOfRange(filtered, Math.min(start, filtered.length), Math.min(end, filtered.length));
            Psd psd = welchPsd(values, sampleRateHz);
            JSONObject phase = new JSONObject();
            phase.put("id", id);
            phase.put("startSec", startSec);
            phase.put("endSec", endSec);
            phase.put("durationSeconds", Math.max(0, endSec - startSec));
            phase.put("rmsUv", rms(values));
            phase.put("peakToPeakUv", peakToPeak(values));
            phase.put("robustRangeUv", robustRange(values, 200000));
            phase.put("bandPowers", bandPowers(psd));
            phase.put("psd", spectrumPreview(psd));
            phases.put(id, phase);
        }

        private JSONObject withoutPsd(JSONObject source) throws JSONException {
            JSONObject copy = new JSONObject(source.toString());
            copy.remove("psd");
            return copy;
        }

        private JSONArray withoutPhaseSpectra(JSONArray source) throws JSONException {
            JSONArray copy = new JSONArray();
            for (int index = 0; index < source.length(); index++) {
                JSONObject item = new JSONObject(source.getJSONObject(index).toString());
                JSONObject phases = item.optJSONObject("phases");
                if (phases != null) {
                    for (String phaseId : new String[]{"before", "during", "after"}) {
                        JSONObject phase = phases.optJSONObject(phaseId);
                        if (phase != null) phase.remove("psd");
                    }
                }
                copy.put(item);
            }
            return copy;
        }
    }

    private static final class EdfData {
        final double[] values;
        final double sampleRateHz;
        final int invalidRows;
        final int clippingSamples;
        final int seqGaps;

        EdfData(double[] values, double sampleRateHz, int invalidRows, int clippingSamples, int seqGaps) {
            this.values = values;
            this.sampleRateHz = sampleRateHz;
            this.invalidRows = invalidRows;
            this.clippingSamples = clippingSamples;
            this.seqGaps = seqGaps;
        }
    }

    private static final class Psd {
        final double[] frequencies;
        final double[] power;
        final double binHz;

        Psd(double[] frequencies, double[] power, double binHz) {
            this.frequencies = frequencies;
            this.power = power;
            this.binHz = binHz;
        }
    }

    private static final class Pairing {
        final JSONArray segments = new JSONArray();
        final JSONArray warnings = new JSONArray();
    }

    private static final class StageRecord {
        final int epoch;
        final String stage;
        final String candidate;
        final String mode;
        final boolean qualityOk;

        StageRecord(int epoch, String stage, String candidate, String mode, boolean qualityOk) {
            this.epoch = epoch;
            this.stage = stage;
            this.candidate = candidate;
            this.mode = mode;
            this.qualityOk = qualityOk;
        }
    }

    private static final class Biquad {
        final double b0, b1, b2, a1, a2;

        Biquad(double b0, double b1, double b2, double a1, double a2) {
            this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
        }
    }

    private static JSONObject readJson(File file, JSONObject fallback) throws IOException, JSONException {
        if (!file.isFile()) return fallback;
        byte[] bytes = Files.readAllBytes(file.toPath());
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }

    private static JSONArray readEvents(File file) throws IOException {
        JSONArray result = new JSONArray();
        if (!file.isFile()) return result;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                try { result.put(new JSONObject(line)); } catch (JSONException ignored) { }
            }
        }
        return result;
    }

    private static EdfData readEdf(File file) throws IOException {
        byte[] bytes = Files.readAllBytes(file.toPath());
        if (bytes.length < 256) throw new IOException("EDF 文件头不完整");
        int headerBytes = parseInt(field(bytes, 184, 8), 0);
        int declaredRecords = parseInt(field(bytes, 236, 8), -1);
        double recordDuration = parseDouble(field(bytes, 244, 8), 0);
        int signalCount = parseInt(field(bytes, 252, 4), 0);
        if (headerBytes < 256 || signalCount < 1 || recordDuration <= 0) throw new IOException("EDF 文件头参数无效");
        int offset = 256;
        String[] labels = readGroup(bytes, offset, signalCount, 16); offset += signalCount * 16;
        offset += signalCount * 80; // transducer
        offset += signalCount * 8;  // physical dimension
        double[] physicalMin = readDoubleGroup(bytes, offset, signalCount, 8); offset += signalCount * 8;
        double[] physicalMax = readDoubleGroup(bytes, offset, signalCount, 8); offset += signalCount * 8;
        double[] digitalMin = readDoubleGroup(bytes, offset, signalCount, 8); offset += signalCount * 8;
        double[] digitalMax = readDoubleGroup(bytes, offset, signalCount, 8); offset += signalCount * 8;
        offset += signalCount * 80; // prefiltering
        int[] samplesPerRecord = readIntGroup(bytes, offset, signalCount, 8); offset += signalCount * 8;
        int selected = 0;
        int selectedSamples = samplesPerRecord[selected];
        int recordBytes = 0;
        for (int value : samplesPerRecord) recordBytes += Math.max(0, value) * 2;
        int available = recordBytes <= 0 ? 0 : Math.max(0, (bytes.length - headerBytes) / recordBytes);
        int records = declaredRecords >= 0 ? Math.min(declaredRecords, available) : available;
        double[] values = new double[records * selectedSamples];
        int cursor = headerBytes;
        int out = 0;
        int clipping = 0;
        for (int record = 0; record < records; record++) {
            for (int signal = 0; signal < signalCount; signal++) {
                int count = Math.max(0, samplesPerRecord[signal]);
                if (signal == selected) {
                    for (int index = 0; index < count; index++) {
                        if (cursor + index * 2 + 1 >= bytes.length) break;
                        int digital = littleEndianShort(bytes, cursor + index * 2);
                        if (digital == (int) digitalMin[signal] || digital == (int) digitalMax[signal]) clipping++;
                        double denominator = digitalMax[signal] - digitalMin[signal];
                        values[out++] = denominator == 0 ? 0
                                : physicalMin[signal] + (digital - digitalMin[signal])
                                * (physicalMax[signal] - physicalMin[signal]) / denominator;
                    }
                }
                cursor += count * 2;
            }
        }
        if (out != values.length) values = Arrays.copyOf(values, out);
        return new EdfData(values, selectedSamples / recordDuration, 0, clipping, 0);
    }

    private static EdfData readCsv(File file, double sampleRateHz) throws IOException {
        if (!file.isFile()) throw new IOException("未找到 eeg_raw.edf 或旧版 eeg_raw.csv");
        ArrayList<Double> values = new ArrayList<>();
        int invalid = 0;
        try (BufferedReader reader = new BufferedReader(new FileReader(file, StandardCharsets.UTF_8))) {
            String header = reader.readLine();
            int valueColumn = -1;
            if (header != null) {
                String[] columns = header.split(",", -1);
                for (int index = 0; index < columns.length; index++) {
                    String name = columns[index].trim().toLowerCase(Locale.ROOT);
                    if (name.equals("voltage_uv") || name.equals("voltageuv") || name.equals("value_uv")
                            || name.equals("microvolts") || name.equals("uv")) { valueColumn = index; break; }
                }
            }
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                String[] columns = line.split(",", -1);
                int index = valueColumn >= 0 ? valueColumn : columns.length - 1;
                if (index < 0 || index >= columns.length) { invalid++; continue; }
                try {
                    double value = Double.parseDouble(columns[index].trim());
                    if (Double.isFinite(value)) values.add(value); else invalid++;
                } catch (NumberFormatException error) { invalid++; }
            }
        }
        double[] output = new double[values.size()];
        for (int index = 0; index < output.length; index++) output[index] = values.get(index);
        return new EdfData(output, sampleRateHz, invalid, 0, 0);
    }

    private static String[] readGroup(byte[] bytes, int offset, int count, int length) {
        String[] result = new String[count];
        for (int index = 0; index < count; index++) result[index] = field(bytes, offset + index * length, length);
        return result;
    }

    private static double[] readDoubleGroup(byte[] bytes, int offset, int count, int length) {
        double[] result = new double[count];
        for (int index = 0; index < count; index++) result[index] = parseDouble(field(bytes, offset + index * length, length), 0);
        return result;
    }

    private static int[] readIntGroup(byte[] bytes, int offset, int count, int length) {
        int[] result = new int[count];
        for (int index = 0; index < count; index++) result[index] = parseInt(field(bytes, offset + index * length, length), 0);
        return result;
    }

    private static String field(byte[] bytes, int offset, int length) {
        int start = Math.max(0, Math.min(bytes.length, offset));
        int end = Math.max(start, Math.min(bytes.length, offset + length));
        return new String(bytes, start, end - start, StandardCharsets.US_ASCII).trim();
    }

    private static int littleEndianShort(byte[] bytes, int offset) {
        int raw = (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
        return raw >= 32768 ? raw - 65536 : raw;
    }

    private static Pairing pairLightEvents(JSONArray events, double durationSeconds, double sampleRateHz)
            throws JSONException {
        Pairing result = new Pairing();
        Map<Integer, JSONObject> active = new HashMap<>();
        long origin = Long.MIN_VALUE;
        for (int index = 0; index < events.length(); index++) {
            JSONObject event = events.getJSONObject(index);
            long timestamp = parseTimestamp(event.optString("ts", ""));
            if (event.optString("action", "").equals("session_started") && timestamp != Long.MIN_VALUE) {
                origin = timestamp;
                break;
            }
            if (origin == Long.MIN_VALUE && timestamp != Long.MIN_VALUE) origin = timestamp;
        }
        if (origin == Long.MIN_VALUE) origin = 0;
        for (int index = 0; index < events.length(); index++) {
            JSONObject event = events.getJSONObject(index);
            String action = event.optString("action", "");
            int channel = clampInt(event.optInt("channel", 1), 1, 2);
            if (action.equals("light_started")) active.put(channel, event);
            if (!action.equals("light_stopped")) continue;
            JSONObject start = active.remove(channel);
            if (start == null) {
                result.warnings.put("光刺激 CH" + channel + " 有停止事件但没有开始事件");
                continue;
            }
            double startSec = clampDouble((parseTimestamp(start.optString("ts", "")) - origin) / 1000.0, 0, durationSeconds);
            double endSec = clampDouble((parseTimestamp(event.optString("ts", "")) - origin) / 1000.0, startSec, durationSeconds);
            double length = Math.max(1 / Math.max(1, sampleRateHz), endSec - startSec);
            JSONObject segment = new JSONObject();
            segment.put("id", "light-" + channel + "-" + (result.segments.length() + 1));
            segment.put("channel", channel);
            segment.put("startSec", startSec);
            segment.put("endSec", endSec);
            segment.put("preStartSec", Math.max(0, startSec - length));
            segment.put("postEndSec", Math.min(durationSeconds, endSec + length));
            segment.put("source", "event-log");
            result.segments.put(segment);
        }
        for (Integer channel : active.keySet()) result.warnings.put("光刺激 CH" + channel + " 缺少停止事件，请手工设置结束时间");
        return result;
    }

    private static JSONArray validateSegments(JSONArray input, double durationSeconds) throws JSONException {
        JSONArray result = new JSONArray();
        if (input == null) return result;
        for (int index = 0; index < input.length(); index++) {
            JSONObject source = input.optJSONObject(index);
            if (source == null) continue;
            double start = clampDouble(source.optDouble("startSec", 0), 0, durationSeconds);
            double end = clampDouble(source.optDouble("endSec", start), start, durationSeconds);
            if (end <= start) continue;
            JSONObject segment = new JSONObject();
            segment.put("id", source.optString("id", "manual-" + (index + 1)));
            segment.put("channel", clampInt(source.optInt("channel", 1), 1, 2));
            segment.put("preStartSec", clampDouble(source.optDouble("preStartSec", 0), 0, start));
            segment.put("startSec", start);
            segment.put("endSec", end);
            segment.put("postEndSec", clampDouble(source.optDouble("postEndSec", end), end, durationSeconds));
            segment.put("source", source.optString("source", "").equals("event-log") ? "event-log" : "manual");
            result.put(segment);
        }
        return result;
    }

    private static JSONObject basicMetrics(double[] raw, double[] filtered, double sampleRateHz) throws JSONException {
        Psd psd = welchPsd(filtered, sampleRateHz);
        JSONObject result = new JSONObject();
        result.put("rawAbsoluteMedianUv", Math.abs(percentile(raw, 0.5, 200000)));
        int minuteSamples = Math.max(1, (int) Math.round(sampleRateHz * 60));
        ArrayList<Double> minuteMedians = new ArrayList<>();
        for (int start = 0; start < raw.length; start += minuteSamples) {
            minuteMedians.add(percentile(Arrays.copyOfRange(raw, start, Math.min(raw.length, start + minuteSamples)), 0.5, 4000));
        }
        double[] minute = new double[minuteMedians.size()];
        for (int index = 0; index < minute.length; index++) minute[index] = minuteMedians.get(index);
        result.put("baselineRangeUv", peakToPeak(minute));
        result.put("filteredRmsUv", rms(filtered));
        result.put("filteredPeakToPeakUv", peakToPeak(filtered));
        result.put("robustRangeUv", robustRange(filtered, 200000));
        result.put("interference50HzRmsUv", toneRms(Arrays.copyOf(raw, Math.min(raw.length, (int) (sampleRateHz * 600))), sampleRateHz, 50));
        result.put("bandPowers", bandPowers(psd));
        result.put("psd", spectrumPreview(psd));
        return result;
    }

    private static JSONArray analyzeEpochs(double[] values, double sampleRateHz) throws JSONException {
        int epochSamples = Math.max(1, (int) Math.round(sampleRateHz * 30));
        JSONArray result = new JSONArray();
        for (int start = 0, index = 0; start + epochSamples <= values.length; start += epochSamples, index++) {
            double[] epoch = Arrays.copyOfRange(values, start, start + epochSamples);
            double range = robustRange(epoch, 2000);
            JSONObject item = new JSONObject();
            item.put("index", index);
            item.put("startSec", start / sampleRateHz);
            item.put("endSec", (start + epochSamples) / sampleRateHz);
            item.put("rmsUv", rms(epoch));
            item.put("robustRangeUv", range);
            item.put("rejected", range >= 150);
            result.put(item);
        }
        return result;
    }

    private static JSONObject bandPowers(Psd psd) throws JSONException {
        JSONObject result = new JSONObject();
        double total = integrateBand(psd, 0.5, 45);
        for (int index = 0; index < BAND_IDS.length; index++) {
            double absolute = integrateBand(psd, BAND_LOW[index], BAND_HIGH[index]);
            JSONObject band = new JSONObject();
            band.put("label", BAND_LABELS[index]);
            band.put("absolute", absolute);
            band.put("relativePercent", total > 0 ? absolute / total * 100 : 0);
            result.put(BAND_IDS[index], band);
        }
        return result;
    }

    private static double integrateBand(Psd psd, double low, double high) {
        double total = 0;
        for (int index = 0; index < psd.power.length; index++) {
            if (psd.frequencies[index] >= low && psd.frequencies[index] < high) total += psd.power[index] * psd.binHz;
        }
        return total;
    }

    private static JSONObject spectrumPreview(Psd psd) throws JSONException {
        JSONObject result = new JSONObject();
        JSONArray frequencies = new JSONArray();
        JSONArray power = new JSONArray();
        for (int index = 0; index < psd.frequencies.length && psd.frequencies[index] <= 60; index++) {
            frequencies.put(psd.frequencies[index]);
            power.put(psd.power[index]);
        }
        result.put("frequencies", frequencies);
        result.put("power", power);
        result.put("binHz", psd.binHz);
        return result;
    }

    private static Psd welchPsd(double[] source, double sampleRateHz) {
        if (source.length < 8) return new Psd(new double[0], new double[0], 0);
        int segmentSize = Math.min(2048, nextPowerOfTwo(Math.max(8, source.length)));
        int hop = Math.max(1, segmentSize / 2);
        ArrayList<Integer> starts = new ArrayList<>();
        for (int start = 0; start + segmentSize <= source.length; start += hop) starts.add(start);
        if (starts.isEmpty()) starts.add(0);
        int stride = Math.max(1, (int) Math.ceil((double) starts.size() / 240));
        double[] accumulated = null;
        int count = 0;
        double binHz = 0;
        for (int index = 0; index < starts.size(); index += stride) {
            int start = starts.get(index);
            Psd spectrum = fftPower(Arrays.copyOfRange(source, start, Math.min(source.length, start + segmentSize)), sampleRateHz);
            if (accumulated == null) accumulated = new double[spectrum.power.length];
            for (int bin = 0; bin < accumulated.length; bin++) accumulated[bin] += spectrum.power[bin];
            binHz = spectrum.binHz;
            count++;
        }
        if (accumulated == null) return new Psd(new double[0], new double[0], 0);
        for (int index = 0; index < accumulated.length; index++) accumulated[index] /= Math.max(1, count);
        double[] frequencies = new double[accumulated.length];
        for (int index = 0; index < frequencies.length; index++) frequencies[index] = index * binHz;
        return new Psd(frequencies, accumulated, binHz);
    }

    private static Psd fftPower(double[] signal, double sampleRateHz) {
        int size = nextPowerOfTwo(Math.max(1, signal.length));
        double[] real = new double[size];
        double[] imaginary = new double[size];
        double mean = 0;
        for (double value : signal) mean += value;
        mean /= Math.max(1, signal.length);
        double windowPower = 0;
        for (int index = 0; index < signal.length; index++) {
            double window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / Math.max(1, signal.length - 1));
            real[index] = (signal[index] - mean) * window;
            windowPower += window * window;
        }
        for (int index = 1, reversed = 0; index < size; index++) {
            int bit = size >> 1;
            while ((reversed & bit) != 0) { reversed ^= bit; bit >>= 1; }
            reversed ^= bit;
            if (index < reversed) {
                double temp = real[index]; real[index] = real[reversed]; real[reversed] = temp;
            }
        }
        for (int length = 2; length <= size; length <<= 1) {
            double angle = -2 * Math.PI / length;
            double stepReal = Math.cos(angle);
            double stepImaginary = Math.sin(angle);
            for (int start = 0; start < size; start += length) {
                double twiddleReal = 1;
                double twiddleImaginary = 0;
                for (int offset = 0; offset < length / 2; offset++) {
                    int even = start + offset;
                    int odd = even + length / 2;
                    double oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
                    double oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
                    real[odd] = real[even] - oddReal;
                    imaginary[odd] = imaginary[even] - oddImaginary;
                    real[even] += oddReal;
                    imaginary[even] += oddImaginary;
                    double nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
                    twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
                    twiddleReal = nextReal;
                }
            }
        }
        int bins = size / 2 + 1;
        double[] power = new double[bins];
        double scale = Math.max(Double.MIN_NORMAL, sampleRateHz * windowPower);
        for (int index = 0; index < bins; index++) {
            power[index] = (real[index] * real[index] + imaginary[index] * imaginary[index]) / scale;
            if (index > 0 && index < bins - 1) power[index] *= 2;
        }
        double[] frequencies = new double[bins];
        double binHz = sampleRateHz / size;
        for (int index = 0; index < bins; index++) frequencies[index] = index * binHz;
        return new Psd(frequencies, power, binHz);
    }

    private static double[] zeroPhaseFilter(double[] signal, double sampleRateHz) {
        double[] source = Arrays.copyOf(signal, signal.length);
        if (source.length < 8) return source;
        int padding = Math.min(source.length - 1, Math.max(12, (int) Math.round(sampleRateHz * 2)));
        double[] values = new double[source.length + padding * 2];
        for (int index = 0; index < padding; index++) {
            values[index] = 2 * source[0] - source[Math.min(source.length - 1, padding - index)];
            values[padding + source.length + index] = 2 * source[source.length - 1]
                    - source[Math.max(0, source.length - 2 - index)];
        }
        System.arraycopy(source, 0, values, padding, source.length);
        Biquad[] chain = new Biquad[]{
                coefficients("highpass", sampleRateHz, 0.5, Math.sqrt(0.5)),
                coefficients("lowpass", sampleRateHz, 45, 0.5411961),
                coefficients("lowpass", sampleRateHz, 45, 1.306563),
                coefficients("notch", sampleRateHz, 50, 30),
        };
        for (Biquad coefficient : chain) values = filterPass(values, coefficient, false);
        for (int index = chain.length - 1; index >= 0; index--) values = filterPass(values, chain[index], true);
        return Arrays.copyOfRange(values, padding, padding + source.length);
    }

    private static Biquad coefficients(String type, double sampleRateHz, double frequencyHz, double q) {
        double omega = 2 * Math.PI * frequencyHz / sampleRateHz;
        double cosine = Math.cos(omega);
        double sine = Math.sin(omega);
        double alpha = sine / (2 * q);
        double b0;
        double b1;
        double b2;
        if (type.equals("highpass")) {
            b0 = (1 + cosine) / 2; b1 = -(1 + cosine); b2 = b0;
        } else if (type.equals("lowpass")) {
            b0 = (1 - cosine) / 2; b1 = 1 - cosine; b2 = b0;
        } else {
            b0 = 1; b1 = -2 * cosine; b2 = 1;
        }
        double a0 = 1 + alpha;
        return new Biquad(b0 / a0, b1 / a0, b2 / a0, -2 * cosine / a0, (1 - alpha) / a0);
    }

    private static double[] filterPass(double[] input, Biquad c, boolean reverse) {
        double[] output = new double[input.length];
        if (input.length == 0) return output;
        double x1 = input[reverse ? input.length - 1 : 0];
        double x2 = x1;
        double dcGain = (c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2);
        double y1 = Double.isFinite(dcGain) ? x1 * dcGain : 0;
        double y2 = y1;
        int start = reverse ? input.length - 1 : 0;
        int end = reverse ? -1 : input.length;
        int step = reverse ? -1 : 1;
        for (int index = start; index != end; index += step) {
            double x0 = finite(input[index]);
            double y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
            output[index] = Double.isFinite(y0) ? y0 : 0;
            x2 = x1; x1 = x0; y2 = y1; y1 = output[index];
        }
        return output;
    }

    private static double rms(double[] values) {
        double sum = 0;
        int count = 0;
        for (double value : values) if (Double.isFinite(value)) { sum += value * value; count++; }
        return count == 0 ? 0 : Math.sqrt(sum / count);
    }

    private static double peakToPeak(double[] values) {
        double minimum = Double.POSITIVE_INFINITY;
        double maximum = Double.NEGATIVE_INFINITY;
        for (double value : values) if (Double.isFinite(value)) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
        return Double.isFinite(minimum) ? maximum - minimum : 0;
    }

    private static double robustRange(double[] values, int maxSamples) {
        return percentile(values, 0.99, maxSamples) - percentile(values, 0.01, maxSamples);
    }

    private static double percentile(double[] values, double quantile, int maxSamples) {
        int stride = Math.max(1, (int) Math.ceil((double) values.length / Math.max(1, maxSamples)));
        ArrayList<Double> finite = new ArrayList<>();
        for (int index = 0; index < values.length; index += stride) if (Double.isFinite(values[index])) finite.add(values[index]);
        if (finite.isEmpty()) return 0;
        Collections.sort(finite);
        double position = clampDouble(quantile, 0, 1) * (finite.size() - 1);
        int lower = (int) Math.floor(position);
        double fraction = position - lower;
        double left = finite.get(lower);
        double right = finite.get(Math.min(finite.size() - 1, lower + 1));
        return left + (right - left) * fraction;
    }

    private static double toneRms(double[] values, double sampleRateHz, double frequencyHz) {
        if (values.length == 0) return 0;
        double cosine = 0;
        double sine = 0;
        double mean = 0;
        for (double value : values) mean += value;
        mean /= values.length;
        for (int index = 0; index < values.length; index++) {
            double angle = 2 * Math.PI * frequencyHz * index / sampleRateHz;
            double value = values[index] - mean;
            cosine += value * Math.cos(angle);
            sine += value * Math.sin(angle);
        }
        return 2 * Math.hypot(cosine, sine) / values.length / Math.sqrt(2);
    }

    private static double[] slice(double[] values, int start, int end) {
        int left = Math.max(0, Math.min(values.length, start));
        int right = Math.max(left, Math.min(values.length, end));
        return Arrays.copyOfRange(values, left, right);
    }

    private static int nextPowerOfTwo(int value) {
        int output = 1;
        while (output < value && output < (1 << 30)) output <<= 1;
        return output;
    }

    private static JSONObject computeOnlineSleepMetrics(JSONArray events) throws JSONException {
        Map<Integer, StageRecord> selected = new LinkedHashMap<>();
        int sourceCount = 0;
        for (int index = 0; index < events.length(); index++) {
            JSONObject event = events.getJSONObject(index);
            if (!event.optString("action", "").equals("sleep_stage_inferred")) continue;
            sourceCount++;
            int epoch = event.optInt("epochIndex", -1);
            if (epoch < 0) continue;
            String stage = event.optString("stage", event.optString("rawStage", "UNKNOWN"));
            String candidate = event.optString("candidateStage", event.optString("modelStage", event.optString("rawStage", stage)));
            String mode = event.optString("inferenceMode", "unknown");
            Object qualityValue = event.opt("quality");
            boolean quality = qualityValue instanceof Boolean ? (Boolean) qualityValue
                    : qualityValue instanceof JSONObject && ((JSONObject) qualityValue).optBoolean("ok", false);
            StageRecord current = selected.get(epoch);
            StageRecord next = new StageRecord(epoch, stage, candidate, mode, quality);
            if (current == null || priority(next.mode) > priority(current.mode) || priority(next.mode) == priority(current.mode)) selected.put(epoch, next);
        }
        ArrayList<StageRecord> records = new ArrayList<>(selected.values());
        records.sort(Comparator.comparingInt(value -> value.epoch));
        JSONObject result = new JSONObject();
        result.put("sourceRecordCount", sourceCount);
        result.put("inputRecordCount", sourceCount);
        result.put("recordCount", records.size());
        result.put("deduplicatedRecordCount", records.size());
        result.put("epochSeconds", 30);
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String stage : STAGES) counts.put(stage, 0);
        int scored = 0;
        int rejected = 0;
        int unknown = 0;
        int candidateN3 = 0;
        int confirmedN3 = 0;
        int suppressedN3 = 0;
        for (StageRecord record : records) {
            if (!record.qualityOk) rejected++;
            if (!containsStage(record.stage)) unknown++;
            if (record.qualityOk && containsStage(record.stage)) { counts.put(record.stage, counts.get(record.stage) + 1); scored++; }
            if (record.qualityOk && record.candidate.equals("N3")) {
                candidateN3++;
                if (record.stage.equals("N3")) confirmedN3++; else suppressedN3++;
            }
        }
        JSONObject durations = new JSONObject();
        JSONObject percentages = new JSONObject();
        for (String stage : STAGES) {
            durations.put(stage, counts.get(stage) * 30);
            percentages.put(stage, scored == 0 ? 0 : counts.get(stage) * 100.0 / scored);
        }
        int sleep = scored - counts.get("W");
        int firstSleep = -1;
        for (StageRecord record : records) if (record.qualityOk && containsStage(record.stage) && !record.stage.equals("W")) { firstSleep = record.epoch; break; }
        result.put("stageCounts", new JSONObject(counts));
        result.put("stageDurationsSeconds", durations);
        result.put("stagePercentages", percentages);
        result.put("scoredEpochs", scored);
        result.put("unscoredEpochs", Math.max(0, records.size() - scored));
        result.put("sleepEpochs", sleep);
        result.put("wakeEpochs", counts.get("W"));
        result.put("totalScoredSeconds", scored * 30);
        result.put("totalSleepSeconds", sleep * 30);
        result.put("wakeSeconds", counts.get("W") * 30);
        result.put("sleepEfficiencyPercent", scored == 0 ? JSONObject.NULL : sleep * 100.0 / scored);
        result.put("sleepOnsetEpoch", firstSleep < 0 ? JSONObject.NULL : firstSleep);
        result.put("sleepOnsetSeconds", firstSleep < 0 ? JSONObject.NULL : firstSleep * 30);
        result.put("wasoEpochs", 0);
        result.put("wasoSeconds", 0);
        result.put("transitionCount", transitionCount(records));
        result.put("longestBouts", longestBouts(records));
        result.put("longestBoutSeconds", longestBouts(records));
        result.put("qualityRejectedEpochs", rejected);
        result.put("unknownEpochs", unknown);
        result.put("n3CandidateEpochs", candidateN3);
        result.put("n3ConfirmedEpochs", confirmedN3);
        result.put("n3SuppressedEpochs", suppressedN3);
        result.put("n3QualityRejectedEpochs", 0);
        result.put("qualityPassRatePercent", records.isEmpty() ? JSONObject.NULL : (records.size() - rejected) * 100.0 / records.size());
        return result;
    }

    private static int priority(String mode) { return mode.equals("causal") ? 3 : mode.equals("center") ? 2 : 1; }

    private static boolean containsStage(String stage) {
        for (String value : STAGES) if (value.equals(stage)) return true;
        return false;
    }

    private static int transitionCount(List<StageRecord> records) {
        int result = 0;
        for (int index = 1; index < records.size(); index++) {
            StageRecord previous = records.get(index - 1);
            StageRecord current = records.get(index);
            if (current.epoch == previous.epoch + 1 && !current.stage.equals(previous.stage)) result++;
        }
        return result;
    }

    private static JSONObject longestBouts(List<StageRecord> records) throws JSONException {
        Map<String, Integer> longest = new LinkedHashMap<>();
        for (String stage : STAGES) longest.put(stage, 0);
        String currentStage = null;
        int length = 0;
        int previousEpoch = -2;
        for (StageRecord record : records) {
            boolean contiguous = record.epoch == previousEpoch + 1;
            if (!record.qualityOk || !containsStage(record.stage) || !record.stage.equals(currentStage) || !contiguous) {
                if (currentStage != null && longest.containsKey(currentStage)) longest.put(currentStage, Math.max(longest.get(currentStage), length * 30));
                currentStage = record.qualityOk && containsStage(record.stage) ? record.stage : null;
                length = currentStage == null ? 0 : 1;
            } else length++;
            previousEpoch = record.epoch;
        }
        if (currentStage != null && longest.containsKey(currentStage)) longest.put(currentStage, Math.max(longest.get(currentStage), length * 30));
        return new JSONObject(longest);
    }

    private static void writePdf(File file, JSONObject report) throws IOException {
        PdfDocument document = new PdfDocument();
        PdfDocument.Page page = null;
        Canvas canvas = null;
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTextSize(12);
        paint.setColor(0xff14212b);
        int y = 40;
        int pageNumber = 0;
        try {
            JSONObject metadata = report.optJSONObject("metadata");
            JSONObject integrity = report.optJSONObject("integrity");
            String[] lines = {
                    "曹操 Android 离线 EEG 分析报告",
                    "研究性结果：不构成 PSG 金标准或医疗诊断",
                    "会话：" + (metadata == null ? "--" : metadata.optString("id", "--")),
                    "有效样本：" + (integrity == null ? 0 : integrity.optInt("validSamples", 0)),
                    "采样率：" + report.optDouble("sampleRateHz", 0) + " Hz",
                    "记录时长：" + String.format(Locale.US, "%.1f s", report.optDouble("durationSeconds", 0)),
                    "可用 epoch：" + (integrity == null ? 0 : integrity.optInt("epochs", 0)),
                    "质量拒绝 epoch：" + (integrity == null ? 0 : integrity.optInt("rejectedEpochs", 0)),
                    "分析源：CH2 双极差分原始 EDF；滤波仅用于分析显示",
            };
            for (String line : lines) {
                if (page == null || y > 790) {
                    if (page != null) { document.finishPage(page); }
                    page = document.startPage(new PdfDocument.PageInfo.Builder(595, 842, ++pageNumber).create());
                    canvas = page.getCanvas();
                    y = 40;
                }
                canvas.drawText(line, 32, y, paint);
                y += 24;
            }
        } finally {
            if (page != null) document.finishPage(page);
            try (FileOutputStream output = new FileOutputStream(file)) { document.writeTo(output); }
            document.close();
        }
    }

    private static double finite(double value) { return Double.isFinite(value) ? value : 0; }
    private static double finiteOrZero(double value) { return Double.isFinite(value) ? value : 0; }
    private static int clampInt(int value, int minimum, int maximum) { return Math.max(minimum, Math.min(maximum, value)); }
    private static double clampDouble(double value, double minimum, double maximum) { return Math.max(minimum, Math.min(maximum, value)); }
    private static int parseInt(String value, int fallback) { try { return Integer.parseInt(value.trim()); } catch (Exception ignored) { return fallback; } }
    private static double parseDouble(String value, double fallback) { try { return Double.parseDouble(value.trim()); } catch (Exception ignored) { return fallback; } }
    private static long parseTimestamp(String value) {
        if (value == null || value.trim().isEmpty()) return Long.MIN_VALUE;
        try { return Instant.parse(value).toEpochMilli(); } catch (DateTimeParseException ignored) { }
        try { return OffsetDateTime.parse(value).toInstant().toEpochMilli(); } catch (DateTimeParseException ignored) { return Long.MIN_VALUE; }
    }
    private static double quantile(List<Double> values, double q) {
        if (values.isEmpty()) return 0;
        int index = clampInt((int) Math.floor((values.size() - 1) * q), 0, values.size() - 1);
        return values.get(index);
    }
}
