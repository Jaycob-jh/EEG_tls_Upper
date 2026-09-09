package com.brainlume.caocao;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** On-device runner for the same Stage-1 model interface used by Upper. */
public final class SleepModelRunner implements AutoCloseable {
    private final Context context;
    private OrtEnvironment environment;
    private OrtSession session;
    private File modelFile;

    public SleepModelRunner(Context context) {
        this.context = context.getApplicationContext();
    }

    private synchronized void ensureSession() throws Exception {
        if (session != null) return;
        File modelDirectory = new File(context.getFilesDir(), "models");
        if (!modelDirectory.exists() && !modelDirectory.mkdirs()) throw new IOException("无法创建 Android 模型目录");
        modelFile = new File(modelDirectory, "stage1_sleep.onnx");
        copyAssetIfNeeded("stage1_sleep.onnx", modelFile);
        // The model uses an external data file; both files must be present in
        // the same directory before ORT opens the graph.
        copyAssetIfNeeded("stage1_sleep.onnx.data", new File(modelDirectory, "stage1_sleep.onnx.data"));
        environment = OrtEnvironment.getEnvironment();
        session = environment.createSession(modelFile.getAbsolutePath(), new OrtSession.SessionOptions());
    }

    public synchronized JSONObject info() throws Exception {
        ensureSession();
        JSONObject result = new JSONObject();
        JSONArray inputs = new JSONArray();
        for (String name : session.getInputNames()) inputs.put(name);
        JSONArray outputs = new JSONArray();
        for (String name : session.getOutputNames()) outputs.put(name);
        result.put("modelPath", modelFile.getAbsolutePath());
        result.put("inputs", inputs);
        result.put("outputs", outputs);
        result.put("modelVersion", "stage1_sleep.onnx");
        result.put("interface", new JSONObject()
                .put("eeg", "[1,21,1,3000] mV")
                .put("epoch_index", "[1,21,1]")
                .put("epoch_cycle_index", "[1,21,5]")
                .put("output", "prob: [1,21,5], center/causal index selected by request"));
        return result;
    }

    public synchronized JSONObject infer(JSONObject input) throws Exception {
        ensureSession();
        int temporalContext = input.optInt("temporalContext", 21);
        int windowLength = input.optInt("windowLength", 3000);
        int outputIndex = input.has("outputIndex") ? input.optInt("outputIndex", temporalContext / 2) : temporalContext / 2;
        float[] eeg = vector(input.opt("eeg"), temporalContext * windowLength);
        float[] epochIndex = vector(input.opt("epochIndex"), temporalContext);
        float[] epochCycleIndex = vector(input.opt("epochCycleIndex"), temporalContext * 5);
        if (eeg.length != temporalContext * windowLength) {
            throw new IllegalArgumentException("eeg length must be " + (temporalContext * windowLength) + ", got " + eeg.length);
        }
        if (epochIndex.length != temporalContext || epochCycleIndex.length != temporalContext * 5) {
            throw new IllegalArgumentException("temporal feature length mismatch");
        }
        Map<String, OnnxTensor> feeds = Map.of(
                "eeg", OnnxTensor.createTensor(environment, FloatBuffer.wrap(eeg), new long[]{1, temporalContext, 1, windowLength}),
                "epoch_index", OnnxTensor.createTensor(environment, FloatBuffer.wrap(epochIndex), new long[]{1, temporalContext, 1}),
                "epoch_cycle_index", OnnxTensor.createTensor(environment, FloatBuffer.wrap(epochCycleIndex), new long[]{1, temporalContext, 5})
        );
        try (OrtSession.Result result = session.run(feeds)) {
            OnnxValue value = result.get("prob")
                    .orElseThrow(() -> new IllegalStateException("ONNX output prob is missing"));
            List<Float> flattened = new ArrayList<>();
            appendNumbers(value.getValue(), flattened);
            if (flattened.size() != 5 && flattened.size() != temporalContext * 5) {
                throw new IllegalStateException("Unexpected sleep-model output length " + flattened.size());
            }
            int index = flattened.size() == 5 ? 0 : outputIndex;
            if (index < 0 || index >= temporalContext) throw new IllegalArgumentException("outputIndex out of range");
            int offset = flattened.size() == 5 ? 0 : index * 5;
            double[] probabilities = new double[5];
            double sum = 0;
            for (int classIndex = 0; classIndex < 5; classIndex++) {
                probabilities[classIndex] = Math.max(0, flattened.get(offset + classIndex));
                sum += probabilities[classIndex];
            }
            if (sum > 0) for (int classIndex = 0; classIndex < 5; classIndex++) probabilities[classIndex] /= sum;
            int stage = 0;
            for (int classIndex = 1; classIndex < 5; classIndex++) if (probabilities[classIndex] > probabilities[stage]) stage = classIndex;
            JSONArray values = new JSONArray();
            for (double probability : probabilities) values.put(probability);
            return new JSONObject()
                    .put("stage", stage)
                    .put("probabilities", values)
                    .put("selectedOutputIndex", index)
                    .put("outputDims", new JSONArray().put(1).put(temporalContext).put(5));
        } finally {
            for (OnnxTensor tensor : feeds.values()) tensor.close();
        }
    }

    private void copyAssetIfNeeded(String assetName, File destination) throws IOException {
        if (destination.isFile() && destination.length() > 0) return;
        try (InputStream input = context.getAssets().open(assetName);
             FileOutputStream output = new FileOutputStream(destination, false)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count > 0) output.write(buffer, 0, count);
            }
        }
    }

    private static float[] vector(Object value, int expectedLength) throws JSONException {
        if (value instanceof JSONArray array) {
            float[] result = new float[array.length()];
            for (int index = 0; index < array.length(); index++) result[index] = (float) array.optDouble(index, Double.NaN);
            return result;
        }
        if (value instanceof JSONObject object) {
            TreeMap<Integer, Float> values = new TreeMap<>();
            for (java.util.Iterator<String> iterator = object.keys(); iterator.hasNext();) {
                String key = iterator.next();
                try { values.put(Integer.parseInt(key), (float) object.optDouble(key, Double.NaN)); }
                catch (NumberFormatException ignored) {}
            }
            float[] result = new float[Math.max(expectedLength, values.isEmpty() ? 0 : values.lastKey() + 1)];
            for (Map.Entry<Integer, Float> entry : values.entrySet()) result[entry.getKey()] = entry.getValue();
            return result;
        }
        return new float[0];
    }

    private static void appendNumbers(Object value, List<Float> result) {
        if (value == null) return;
        if (value instanceof float[] values) { for (float item : values) result.add(item); return; }
        if (value instanceof double[] values) { for (double item : values) result.add((float) item); return; }
        if (value instanceof int[] values) { for (int item : values) result.add((float) item); return; }
        if (value instanceof long[] values) { for (long item : values) result.add((float) item); return; }
        if (value instanceof Object[] values) { for (Object item : values) appendNumbers(item, result); }
    }

    @Override
    public synchronized void close() {
        if (session != null) {
            try { session.close(); } catch (Exception ignored) {}
            session = null;
        }
    }
}
