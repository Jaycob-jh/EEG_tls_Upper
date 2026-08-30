'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, session, Menu } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const Core = require('./src/core');
const AnalysisReport = require('./src/analysis-report');
const { EdfWriter } = require('./src/edf');
const BLE_DEVICE_NAME = 'BrainLume2.0C';
const APP_ICON_PATH = path.join(__dirname, 'assets', 'cao-cao-icon-original.png');

app.setName('曹操');
app.setPath('userData', path.join(app.getPath('appData'), 'brainlume-desktop'));

let mainWindow = null;
let splashWindow = null;
let analysisWindow = null;
let pendingBluetoothSelection = null;
let bluetoothCandidates = new Map();
let bluetoothSelectionTimer = null;
const activeRecordings = new Map();
const activeAnalyses = new Map();
let sleepWorkerEntry = null;
const deviceDiagnosticMode = process.argv.includes('--device-diagnostic');
const debugCliMode = process.argv.includes('--debug-cli');
const debugCommandArg = process.argv.find(value => value.startsWith('--debug-command='));
const debugCommand = debugCommandArg ? JSON.parse(Buffer.from(debugCommandArg.slice('--debug-command='.length), 'base64').toString('utf8')) : null;
if (debugCliMode) app.disableHardwareAcceleration();

function configureApplicationMenu() {
    const template = [];
    if (process.platform === 'darwin') {
        template.push({
            label: app.name,
            submenu: [
                { role: 'about', label: '关于曹操' },
                { type: 'separator' },
                { role: 'quit', label: '退出曹操' },
            ],
        });
    }
    template.push({
        label: '工具',
        submenu: [
            { label: '打开数据目录', click: () => { void openDataDirectory('root'); } },
            { label: '打开会话目录', click: () => { void openDataDirectory('sessions'); } },
            { label: '打开日志目录', click: () => { void openDataDirectory('logs'); } },
            { type: 'separator' },
            { label: '导出当前分析报告', click: () => { void exportCurrentAnalysisFromMenu(); } },
            { label: '保存当前页面截图', click: () => { void saveFocusedScreenshotFromMenu(); } },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
        ],
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function nowIso(date = new Date()) {
    return Core.formatLocalIso(date);
}

function localDateKey(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function localFileStamp(date = new Date()) {
    return nowIso(date).replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace(/[+]/g, '_');
}

function safeFilePart(value) {
    return String(value || 'session').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
}

function screenshotFilePart(value) {
    return String(value || '当前页面')
        .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 60) || '当前页面';
}

function appDataPaths() {
    const root = path.join(app.getPath('documents'), 'BrainLume Desktop');
    return {
        root,
        plans: path.join(root, 'plans.json'),
        sessions: path.join(root, 'sessions'),
        logs: path.join(root, 'logs'),
    };
}

async function ensureDataDirectories() {
    const paths = appDataPaths();
    await Promise.all([
        fsp.mkdir(paths.root, { recursive: true }),
        fsp.mkdir(paths.sessions, { recursive: true }),
        fsp.mkdir(paths.logs, { recursive: true }),
    ]);
    return paths;
}

async function readJson(filePath, fallback) {
    try {
        return JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

async function writeJsonAtomic(filePath, value) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsp.rename(temporary, filePath);
}

function emitBluetoothCandidates() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('ble:candidates', Array.from(bluetoothCandidates.values()));
}

function completeBluetoothSelection(id) {
    if (!pendingBluetoothSelection) return;
    const callback = pendingBluetoothSelection;
    pendingBluetoothSelection = null;
    if (bluetoothSelectionTimer) clearTimeout(bluetoothSelectionTimer);
    bluetoothSelectionTimer = null;
    bluetoothCandidates = new Map();
    callback(id || '');
}

function configureBluetoothSelection(window) {
    window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
        event.preventDefault();
        pendingBluetoothSelection = callback;
        // Chromium has already applied requestDevice's name-or-ABF0 filter. Keep
        // unnamed service matches because some advertising cycles omit LocalName.
        const matchingDevices = devices.filter(device => !device.deviceName || device.deviceName.startsWith('BrainLume'));
        for (const device of matchingDevices) {
            if (!bluetoothCandidates.has(device.deviceId)) {
                bluetoothCandidates.set(device.deviceId, {
                    id: device.deviceId,
                    name: device.deviceName || 'BrainLume2.0C（ABF0 服务）',
                });
            }
        }
        emitBluetoothCandidates();
        if (deviceDiagnosticMode && pendingBluetoothSelection && !bluetoothSelectionTimer) {
            const preferred = matchingDevices.find(device => device.deviceName === BLE_DEVICE_NAME);
            if (preferred) completeBluetoothSelection(preferred.deviceId);
            else {
                bluetoothSelectionTimer = setTimeout(() => {
                    const candidate = bluetoothCandidates.values().next().value;
                    completeBluetoothSelection(candidate?.id || '');
                }, 15000);
            }
        }
    });
}

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 520,
        height: 640,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        center: true,
        show: true,
        icon: APP_ICON_PATH,
        webPreferences: { sandbox: true },
    });
    splashWindow.loadFile(path.join(__dirname, 'src', 'splash.html'));
    splashWindow.on('closed', () => { splashWindow = null; });
    return splashWindow;
}

function createWindow() {
    createSplashWindow();
    mainWindow = new BrowserWindow({
        show: false,
        width: 1480,
        height: 920,
        minWidth: 1100,
        minHeight: 720,
        backgroundColor: '#f4f7fa',
        title: '曹操',
        icon: APP_ICON_PATH,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    configureBluetoothSelection(mainWindow);
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
    mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.focus();
            if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        }, 2400);
    });
    if (process.argv.includes('--capture-smoke')) {
        mainWindow.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
                const directory = path.join(__dirname, 'artifacts');
                await fsp.mkdir(directory, { recursive: true });
                const image = await mainWindow.webContents.capturePage();
                await fsp.writeFile(path.join(directory, 'smoke.png'), image.toPNG());
                app.quit();
            }, 1200);
        });
    }
    mainWindow.on('closed', () => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        mainWindow = null;
    });
}

function getFocusedAppWindow() {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && (focused === mainWindow || focused === analysisWindow)) return focused;
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

async function openDataDirectory(kind) {
    try {
        const paths = await ensureDataDirectories();
        const directory = paths[kind];
        if (!directory) throw new Error('未定义的应用目录');
        const error = await shell.openPath(directory);
        if (error) throw new Error(error);
    } catch (error) {
        dialog.showErrorBox('打开目录失败', error.message);
    }
}

function analysisIdsForWindow(window) {
    if (!window || window.isDestroyed()) return [];
    const webContentsId = window.webContents.id;
    return Array.from(activeAnalyses.values())
        .filter(entry => entry.webContentsId === webContentsId)
        .map(entry => entry.id);
}

async function exportCurrentAnalysisFromMenu() {
    try {
        const focused = getFocusedAppWindow();
        const analysisId = analysisIdsForWindow(focused)[0] || Array.from(activeAnalyses.keys()).at(-1);
        if (!analysisId) throw new Error('请先从“记录”打开一条采集记录进行分析');
        await exportAnalysisReport(analysisId);
    } catch (error) {
        dialog.showErrorBox('导出分析报告失败', error.message);
    }
}

async function saveFocusedScreenshotFromMenu() {
    try {
        const target = getFocusedAppWindow();
        if (!target) throw new Error('当前没有可截图的应用窗口');
        const pageTitle = target === analysisWindow
            ? '脑电数据分析'
            : await target.webContents.executeJavaScript("document.querySelector('.topbar h1')?.textContent || document.title || '当前页面'");
        await saveScreenshotForWindow(target, pageTitle);
    } catch (error) {
        dialog.showErrorBox('保存截图失败', error.message);
    }
}

async function openAnalysisWindow(sessionId) {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口尚未就绪');
    const analysisHtml = path.join(__dirname, 'src', 'analysis.html');
    if (analysisWindow && !analysisWindow.isDestroyed()) {
        for (const analysisId of analysisIdsForWindow(analysisWindow)) await closeAnalysis(analysisId);
        await analysisWindow.loadFile(analysisHtml, { query: { sessionId: String(sessionId || '') } });
        analysisWindow.show();
        analysisWindow.focus();
        return true;
    }

    const windowRef = new BrowserWindow({
        parent: mainWindow,
        modal: false,
        show: false,
        width: 1380,
        height: 900,
        minWidth: 960,
        minHeight: 680,
        backgroundColor: '#edf2f6',
        title: '曹操 · EEG 分析',
        icon: APP_ICON_PATH,
        webPreferences: {
            preload: path.join(__dirname, 'analysis-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    analysisWindow = windowRef;
    const ownerWebContentsId = windowRef.webContents.id;
    windowRef.on('closed', () => {
        const ids = Array.from(activeAnalyses.values())
            .filter(entry => entry.webContentsId === ownerWebContentsId)
            .map(entry => entry.id);
        if (analysisWindow === windowRef) analysisWindow = null;
        void Promise.all(ids.map(id => closeAnalysis(id).catch(() => {})));
    });
    try {
        await windowRef.loadFile(analysisHtml, { query: { sessionId: String(sessionId || '') } });
        windowRef.show();
        windowRef.focus();
        return true;
    } catch (error) {
        if (!windowRef.isDestroyed()) windowRef.destroy();
        if (analysisWindow === windowRef) analysisWindow = null;
        throw error;
    }
}

function createDebugWindow() {
    mainWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    mainWindow.loadFile(path.join(__dirname, 'src', 'debug.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

async function appendEventLog(event) {
    const paths = await ensureDataDirectories();
    const day = localDateKey();
    const record = { ts: nowIso(), ...event };
    await fsp.appendFile(path.join(paths.logs, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
}

async function startRecording(metadata) {
    const paths = await ensureDataDirectories();
    const id = metadata.id || crypto.randomUUID();
    const stamp = localFileStamp();
    const directory = path.join(paths.sessions, `${stamp}_${safeFilePart(id)}`);
    await fsp.mkdir(directory, { recursive: true });
    const session = {
        ...metadata,
        id,
        startedAt: nowIso(),
        status: 'recording',
        rows: 0,
        directory,
        storageFormat: 'EDF',
        dataFile: 'eeg_raw.edf',
    };
    await writeJsonAtomic(path.join(directory, 'session.json'), session);
    const edfPartial = path.join(directory, 'eeg_raw.edf.partial');
    const edfWriter = await EdfWriter.create(edfPartial, {
        startTime: session.startedAt,
        label: `EEG CH${Number(metadata.selectedChannel || 2)}`,
        recordingId: `BrainLume ${metadata.deviceId || 'EEG'}`,
        sampleRateHz: Number(metadata.sampleRateHz || 250),
        prefiltering: 'Raw ADC; no filtering',
    });
    const recording = {
        session,
        edfWriter,
        edfPartial,
        edfFinal: path.join(directory, 'eeg_raw.edf'),
        eventsPath: path.join(directory, 'events.jsonl'),
        appendPromise: Promise.resolve(),
        rows: 0,
    };
    activeRecordings.set(id, recording);
    await fsp.appendFile(recording.eventsPath, `${JSON.stringify({ ts: nowIso(), level: 'info', action: 'session_started', sessionId: id })}\n`, 'utf8');
    return { ...session, edfPath: edfPartial };
}

async function appendRecordingSamples(id, samples) {
    const recording = activeRecordings.get(id);
    if (!recording) throw new Error(`Recording ${id} is not active`);
    if (!Array.isArray(samples) || samples.length === 0) return { rows: recording.rows };
    recording.appendPromise = recording.appendPromise.then(() => recording.edfWriter.appendSamples(samples));
    const result = await recording.appendPromise;
    recording.rows = result.rows;
    return { rows: recording.rows, records: result.records };
}

async function appendRecordingEvent(id, event) {
    const recording = activeRecordings.get(id);
    if (!recording) return appendEventLog(event);
    const record = { ts: nowIso(), sessionId: id, ...event };
    await fsp.appendFile(recording.eventsPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
}

async function stopRecording(id, status = 'completed', reason = null) {
    const recording = activeRecordings.get(id);
    if (!recording) return null;
    activeRecordings.delete(id);
    await recording.appendPromise;
    const edf = await recording.edfWriter.finalize();
    const endedAt = nowIso();
    const finalSession = {
        ...recording.session,
        status,
        reason,
        endedAt,
        rows: edf.receivedSamples,
        edfRecords: edf.records,
        edfPaddedSamples: edf.paddedSamples,
    };
    await fsp.appendFile(recording.eventsPath, `${JSON.stringify({ ts: endedAt, level: 'info', action: 'session_stopped', status, reason, rows: edf.receivedSamples })}\n`, 'utf8');
    await fsp.rename(recording.edfPartial, recording.edfFinal);
    await writeJsonAtomic(path.join(recording.session.directory, 'session.json'), finalSession);
    return { ...finalSession, edfPath: recording.edfFinal };
}

async function listSessions() {
    const paths = await ensureDataDirectories();
    const entries = await fsp.readdir(paths.sessions, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(paths.sessions, entry.name);
        const metadata = await readJson(path.join(directory, 'session.json'), null);
        if (metadata) sessions.push({ ...metadata, directory });
    }
    return sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function runChildProcess(command, args) {
    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(command, args, {
            cwd: __dirname,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.once('error', error => {
            if (settled) return;
            settled = true;
            resolve({ error, stdout, stderr });
        });
        child.once('close', (code, signal) => {
            if (settled) return;
            settled = true;
            resolve({ code, signal, stdout, stderr });
        });
    });
}

function parseLastJsonLine(output) {
    const lines = String(output || '').trim().split(/\r?\n/).reverse();
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch { /* Python dependency warnings may precede the JSON result. */ }
    }
    return null;
}

async function runYasaStaging(sessionId) {
    const sessions = await listSessions();
    const selected = sessions.find(item => item.id === sessionId);
    if (!selected) throw new Error('未找到指定采集会话');
    const paths = await ensureDataDirectories();
    const root = path.resolve(paths.sessions);
    const directory = path.resolve(selected.directory);
    const relative = path.relative(root, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('会话路径不在受控记录目录中');
    }

    const scriptPath = path.join(__dirname, 'python', 'yasa_offline_staging.py');
    const outputDir = path.join(directory, 'analysis', 'yasa');
    await fsp.mkdir(outputDir, { recursive: true });
    const scriptArgs = ['--session-dir', directory, '--output-dir', outputDir];
    const explicitPython = String(process.env.BRAINLUME_PYTHON || '').trim();
    const projectPython = process.platform === 'win32'
        ? path.join(__dirname, '.venv-yasa', 'Scripts', 'python.exe')
        : path.join(__dirname, '.venv-yasa', 'bin', 'python');
    const candidates = explicitPython
        ? [[explicitPython, []]]
        : process.platform === 'win32'
            ? [[projectPython, []], ['py', ['-3']], ['python', []], ['python3', []]]
            : [[projectPython, []], ['python3', []], ['python', []]];

    const failures = [];
    for (const [command, prefix] of candidates) {
        if (path.isAbsolute(command) && !fs.existsSync(command)) {
            failures.push(`${command} 不存在`);
            continue;
        }
        const result = await runChildProcess(command, [...prefix, scriptPath, ...scriptArgs]);
        if (result.error) {
            failures.push(`${command}：${result.error.message}`);
            if (explicitPython || result.error.code !== 'ENOENT') break;
            continue;
        }
        const payload = parseLastJsonLine(result.stdout);
        if (result.code === 0 && payload?.ok) {
            return { ...payload, pythonCommand: command, outputDir };
        }
        const message = payload?.error || result.stderr.trim() || `Python 进程退出码 ${result.code}`;
        failures.push(`${command}：${message}`);
        if (explicitPython) break;
    }
    const requirementPath = path.join(__dirname, 'python', 'requirements-yasa.txt');
    throw new Error([
        'YASA 离线环境未就绪。',
        failures.join('；'),
        `请在终端运行："${projectPython}" -m pip install -r "${requirementPath}"`,
    ].filter(Boolean).join('\n'));
}

function analysisRequest(entry, action, payload = {}, timeoutMs = 300000) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            entry.pending.delete(id);
            reject(new Error(`分析任务超时：${action}`));
        }, timeoutMs);
        entry.pending.set(id, { resolve, reject, timer });
        entry.worker.postMessage({ id, action, payload });
    });
}

function ensureSleepWorker() {
    if (sleepWorkerEntry) return sleepWorkerEntry;
    const worker = new Worker(path.join(__dirname, 'sleep-stage-worker.js'));
    const entry = { worker, pending: new Map() };
    sleepWorkerEntry = entry;
    worker.on('message', message => {
        const pending = entry.pending.get(message.id);
        if (!pending) return;
        entry.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error));
    });
    worker.on('error', error => {
        for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        entry.pending.clear();
        sleepWorkerEntry = null;
    });
    worker.on('exit', () => { if (sleepWorkerEntry === entry) sleepWorkerEntry = null; });
    return entry;
}

function sleepRequest(type, payload = {}, timeoutMs = 120000) {
    const entry = ensureSleepWorker();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            entry.pending.delete(id);
            reject(new Error(`实时睡眠分期超时：${type}`));
        }, timeoutMs);
        entry.pending.set(id, { resolve, reject, timer });
        entry.worker.postMessage({ id, type, ...payload });
    });
}

async function closeAnalysis(analysisId) {
    const entry = activeAnalyses.get(analysisId);
    if (!entry) return false;
    activeAnalyses.delete(analysisId);
    for (const pending of entry.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('分析任务已关闭'));
    }
    entry.pending.clear();
    await entry.worker.terminate();
    return true;
}

function sendAnalysisProgress(entry, message) {
    const targets = [];
    const owner = BrowserWindow.getAllWindows().find(window => window.webContents.id === entry.webContentsId);
    if (owner && !owner.isDestroyed()) targets.push(owner);
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow !== owner) targets.push(mainWindow);
    for (const target of targets) target.webContents.send('analysis:progress', { analysisId: entry.id, ...message });
}

async function openAnalysis(sessionId, ownerWebContentsId = null) {
    const sessions = await listSessions();
    const selected = sessions.find(item => item.id === sessionId);
    if (!selected) throw new Error('未找到指定采集会话');
    const paths = await ensureDataDirectories();
    const root = `${path.resolve(paths.sessions)}${path.sep}`;
    const directory = path.resolve(selected.directory);
    if (!directory.startsWith(root)) throw new Error('会话路径不在受控记录目录中');
    for (const id of Array.from(activeAnalyses.keys())) await closeAnalysis(id);
    const analysisId = crypto.randomUUID();
    const worker = new Worker(path.join(__dirname, 'analysis-worker.js'));
    const entry = { id: analysisId, sessionId, directory, worker, pending: new Map(), webContentsId: ownerWebContentsId };
    activeAnalyses.set(analysisId, entry);
    worker.on('message', message => {
        if (message.type === 'progress') {
            sendAnalysisProgress(entry, message);
            return;
        }
        if (message.type !== 'response') return;
        const pending = entry.pending.get(message.id);
        if (!pending) return;
        entry.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
            const error = new Error(message.error.message);
            error.stack = message.error.stack;
            pending.reject(error);
        } else pending.resolve(message.result);
    });
    worker.on('error', error => {
        for (const pending of entry.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        entry.pending.clear();
        activeAnalyses.delete(analysisId);
    });
    worker.on('exit', () => activeAnalyses.delete(analysisId));
    try {
        // The analysis window only needs metrics and phase summaries at first;
        // epoch rows remain in the worker for the later report export.
        const summary = await analysisRequest(entry, 'open', { directory, sessionId, includeEpochs: false });
        return { analysisId, ...summary };
    } catch (error) {
        await closeAnalysis(analysisId);
        throw error;
    }
}

function requireAnalysis(analysisId) {
    const entry = activeAnalyses.get(analysisId);
    if (!entry) throw new Error('分析会话已关闭，请重新打开记录');
    return entry;
}

async function captureReportCharts(window, directory) {
    const names = await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('[data-chart]')).map(node=>node.dataset.chart)");
    for (const name of names) {
        const rect = await window.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[data-chart="${name}"]');node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)),y:Math.max(0,Math.floor(r.y)),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`);
        await new Promise(resolve => setTimeout(resolve, 30));
        const image = await window.webContents.capturePage(rect);
        await fsp.writeFile(path.join(directory, `${safeFilePart(name)}.png`), image.toPNG());
    }
}

async function saveScreenshotForWindow(window, pageTitle = '当前页面') {
    if (!window || window.isDestroyed()) throw new Error('当前窗口已关闭');
    const image = await window.webContents.capturePage();
    const result = await dialog.showSaveDialog(window, {
        title: '保存界面截图',
        defaultPath: `曹操_${screenshotFilePart(pageTitle)}_${localFileStamp()}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, image.toPNG());
    return result.filePath;
}

async function exportAnalysisReport(analysisId) {
    const entry = requireAnalysis(analysisId);
    const data = await analysisRequest(entry, 'report');
    data.generatedAt = nowIso();
    const ownerWindow = BrowserWindow.getAllWindows().find(window => window.webContents.id === entry.webContentsId) || mainWindow;
    const result = await dialog.showSaveDialog(ownerWindow, {
        title: '导出 EEG 分析报告',
        defaultPath: `曹操_EEG_Report_${localFileStamp()}.pdf`,
        filters: [{ name: 'PDF 报告', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const pdfPath = result.filePath.toLowerCase().endsWith('.pdf') ? result.filePath : `${result.filePath}.pdf`;
    const baseName = path.basename(pdfPath, '.pdf');
    const dataDirectory = path.join(path.dirname(pdfPath), `${baseName}_data`);
    await fsp.mkdir(dataDirectory, { recursive: true });
    const serializable = { ...data };
    delete serializable.charts;
    await Promise.all([
        writeJsonAtomic(path.join(dataDirectory, 'summary.json'), serializable),
        fsp.writeFile(path.join(dataDirectory, 'epochs.csv'), AnalysisReport.epochsCsv(data.epochs), 'utf8'),
        fsp.writeFile(path.join(dataDirectory, 'phase_metrics.csv'), AnalysisReport.phaseMetricsCsv(data.phaseMetrics), 'utf8'),
    ]);
    const temporaryHtml = path.join(os.tmpdir(), `brainlume-report-${crypto.randomUUID()}.html`);
    await fsp.writeFile(temporaryHtml, AnalysisReport.buildReportHtml(data), 'utf8');
    const reportWindow = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true } });
    try {
        await reportWindow.loadFile(temporaryHtml);
        await reportWindow.webContents.executeJavaScript('document.fonts.ready');
        await captureReportCharts(reportWindow, dataDirectory);
        const pdf = await reportWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.3, bottom: 0.3, left: 0.3, right: 0.3 } });
        await fsp.writeFile(pdfPath, pdf);
    } finally {
        reportWindow.destroy();
        await fsp.rm(temporaryHtml, { force: true });
    }
    return { pdfPath, dataDirectory };
}

function registerIpc() {
    ipcMain.on('ble:select-device', (_event, id) => {
        completeBluetoothSelection(id);
    });
    ipcMain.on('launch:get-mode', event => { event.returnValue = deviceDiagnosticMode ? 'device-diagnostic' : 'normal'; });
    ipcMain.on('debug:get-request', event => { event.returnValue = debugCommand; });
    ipcMain.handle('paths:get', async () => ensureDataDirectories());
    ipcMain.handle('plans:load', async () => {
        const paths = await ensureDataDirectories();
        return readJson(paths.plans, []);
    });
    ipcMain.handle('plans:save', async (_event, plans) => {
        const paths = await ensureDataDirectories();
        await writeJsonAtomic(paths.plans, plans);
        return true;
    });
    ipcMain.handle('session:start', (_event, metadata) => startRecording(metadata));
    ipcMain.handle('session:append-samples', (_event, id, samples) => appendRecordingSamples(id, samples));
    ipcMain.handle('session:event', (_event, id, record) => appendRecordingEvent(id, record));
    ipcMain.handle('session:stop', (_event, id, status, reason) => stopRecording(id, status, reason));
    ipcMain.handle('sessions:list', () => listSessions());
    ipcMain.handle('analysis-window:open', (_event, sessionId) => openAnalysisWindow(sessionId));
    ipcMain.handle('analysis-window:close', event => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window && window !== mainWindow && !window.isDestroyed()) window.close();
        return true;
    });
    ipcMain.handle('analysis:open', (event, sessionId) => openAnalysis(sessionId, event.sender.id));
    ipcMain.handle('analysis:viewport', (_event, request) => analysisRequest(requireAnalysis(request.analysisId), 'viewport', request));
    ipcMain.handle('analysis:spectrogram', (_event, request) => analysisRequest(requireAnalysis(request.analysisId), 'spectrogram', request));
    ipcMain.handle('analysis:segments', (_event, analysisId, segments) => analysisRequest(requireAnalysis(analysisId), 'segments', { segments, includeEpochs: false }));
    ipcMain.handle('analysis:export', (_event, analysisId) => exportAnalysisReport(analysisId));
    ipcMain.handle('analysis:yasa', (_event, sessionId) => runYasaStaging(sessionId));
    ipcMain.handle('analysis:close', (_event, analysisId) => closeAnalysis(analysisId));
    ipcMain.handle('sleep:model-info', () => sleepRequest('info'));
    ipcMain.handle('sleep:infer', (_event, payload) => sleepRequest('infer', payload));
    ipcMain.handle('app:event', (_event, record) => appendEventLog(record));
    ipcMain.handle('path:reveal', async (_event, targetPath) => {
        if (!targetPath) return false;
        shell.showItemInFolder(targetPath);
        return true;
    });
    ipcMain.handle('screenshot:save', (event, pageTitle) => {
        const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        return saveScreenshotForWindow(window, pageTitle);
    });
    ipcMain.handle('diagnostic:complete', async (_event, report) => {
        const directory = path.join(__dirname, 'artifacts');
        await fsp.mkdir(directory, { recursive: true });
        const filePath = path.join(directory, 'device-diagnostic.json');
        await writeJsonAtomic(filePath, report);
        setTimeout(() => app.quit(), 250);
        return filePath;
    });
    ipcMain.handle('debug:result', async (_event, result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        setTimeout(() => app.quit(), 50);
        return true;
    });
}

app.whenReady().then(async () => {
    await ensureDataDirectories();
    if (app.dock) app.dock.setIcon(APP_ICON_PATH);
    session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'bluetooth');
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'bluetooth'));
    session.defaultSession.setDevicePermissionHandler(details => details.deviceType === 'bluetooth');
    configureApplicationMenu();
    registerIpc();
    if (debugCliMode) createDebugWindow(); else createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', async event => {
    if (activeRecordings.size === 0 && activeAnalyses.size === 0) return;
    event.preventDefault();
    for (const id of Array.from(activeRecordings.keys())) {
        try { await stopRecording(id, 'interrupted', 'application_exit'); } catch { /* preserve partial file */ }
    }
    for (const id of Array.from(activeAnalyses.keys())) await closeAnalysis(id);
    app.exit(0);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    if (sleepWorkerEntry) sleepWorkerEntry.worker.terminate();
    sleepWorkerEntry = null;
});
