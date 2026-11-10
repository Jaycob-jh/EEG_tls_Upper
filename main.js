'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell, session, Menu, net, powerSaveBlocker, safeStorage } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const Core = require('./src/core');
const AnalysisReport = require('./src/analysis-report');
const { readSavedYasaResult } = require('./src/saved-yasa');
const { registerResearchReview } = require('./src/n3-research-review');
const { parseSessionStagingHistory } = require('./src/session-history');
const { EdfWriter } = require('./src/edf');
const { encodeRawRecords } = require('./src/raw-recording');
const GithubSync = require('./src/github-sync');
const Storage = require('./src/storage-paths');
const APP_VERSION = require('./package.json').version;
const BLE_DEVICE_NAME = 'BrainLume2.0C';
const APP_ICON_PATH = path.join(__dirname, 'assets', 'cao-cao-icon-original.png');

app.setName('曹操');
const profileDirectory = Storage.profilePath(app.getPath('appData'), APP_VERSION);
fs.mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
app.setPath('userData', profileDirectory);
app.setPath('sessionData', profileDirectory);

let mainWindow = null;
let splashWindow = null;
let analysisWindow = null;
let pendingBluetoothSelection = null;
let bluetoothCandidates = new Map();
let bluetoothSelectionTimer = null;
const activeRecordings = new Map();
let recordingPowerBlocker = null;
const activeAnalyses = new Map();
let githubSyncState = null;
let githubSyncStatePromise = null;
let githubUploadProcessPromise = null;
let sleepWorkerEntry = null;
let historyReplay = { running: false };
let historyReplayWorker = null;

function sendHistoryReplayStatus() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('history-replay:progress', historyReplay);
}

async function historyReplayStatus() {
    if (!historyReplay.output) {
        const paths = await ensureDataDirectories();
        const latest = await readJson(path.join(paths.root, 'analysis/history-replay/latest.json'), null).catch(() => null);
        if (latest) historyReplay.output = latest.output;
    }
    return historyReplay;
}

async function startHistoryReplay(protocol) {
    if (historyReplay.running) return historyReplay;
    if (activeRecordings.size) throw new Error('请先停止采集，再回放历史数据');
    const Sleep = require('./src/realtime-sleep');
    protocol = Sleep.normalizeStimulusProtocol({ ...protocol, enabled: true, shadowMode: true });
    const errors = Sleep.validateStimulusProtocol(protocol);
    if (errors.length) throw new Error(errors.join('；'));
    historyReplay = { running: true, phase: 'read', index: 0, output: historyReplay.output };
    try {
    const paths = await ensureDataDirectories();
    const root = path.join(paths.root, 'analysis/history-replay');
    const output = path.join(root, new Date().toISOString().replace(/[:.]/g, '-'));
    const watchComparison = await readJson(path.join(root, 'watch-comparison.json'), null).catch(() => null);
    const worker = new Worker(path.join(__dirname, 'history-replay-worker.js'), { workerData: {
        rootDir: __dirname, sessionsRoot: paths.sessions, output, protocol, watchComparison,
    } });
    historyReplayWorker = worker;
    historyReplay = { running: true, phase: 'read', index: 0, output: historyReplay.output };
    sendHistoryReplayStatus();
    worker.on('message', message => {
        if (message.type === 'progress') historyReplay = { ...historyReplay, epochs: message.progress.phase === 'read' ? undefined : historyReplay.epochs, ...message.progress };
        else if (message.type === 'done') historyReplay = { ...message, running: false, phase: message.cancelled ? 'cancelled' : 'done' };
        else if (message.type === 'error') historyReplay = { ...historyReplay, running: false, phase: 'error', error: message.error };
        sendHistoryReplayStatus();
    });
    worker.on('error', error => { historyReplay = { ...historyReplay, running: false, phase: 'error', error: error.message }; sendHistoryReplayStatus(); });
    worker.on('exit', () => {
        if (historyReplayWorker !== worker) return;
        historyReplayWorker = null;
        if (historyReplay.running) { historyReplay = { ...historyReplay, running: false, phase: 'error', error: '回放意外结束，请重试' }; sendHistoryReplayStatus(); }
    });
    return historyReplay;
    } catch (error) {
        historyReplay = { ...historyReplay, running: false, phase: 'error', error: error.message };
        sendHistoryReplayStatus(); throw error;
    }
}

async function openHistoryReplayReport() {
    const status = await historyReplayStatus(), paths = await ensureDataDirectories();
    if (!status.output) throw new Error('请先完成一次回放');
    const root = path.resolve(paths.root, 'analysis/history-replay');
    const file = path.resolve(status.output, 'report.html');
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) throw new Error('回放报告不存在，请重新回放');
    const error = await shell.openPath(file); if (error) throw new Error(error);
    return true;
}
const deviceDiagnosticMode = process.argv.includes('--device-diagnostic-long') ? 'device-diagnostic-long'
    : process.argv.includes('--device-diagnostic') ? 'device-diagnostic' : null;
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
                {
                    label: '隐藏当前窗口', accelerator: 'Command+H',
                    click: () => { const window = getFocusedAppWindow(); if (window) window.hide(); },
                },
                {
                    label: '显示全部窗口', accelerator: 'Command+Option+H',
                    click: () => {
                        for (const window of [mainWindow, analysisWindow]) {
                            if (window && !window.isDestroyed()) window.show();
                        }
                    },
                },
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
            { label: '离线分期对照…', click: () => {
                void openAnalysisWindow('').catch(error => dialog.showErrorBox('无法打开记录分析', error.message));
            } },
            { label: '导出当前分析报告', click: () => { void exportCurrentAnalysisFromMenu(); } },
            { label: '保存当前页面截图', click: () => { void saveFocusedScreenshotFromMenu(); } },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
        ],
    });
    if (process.platform === 'darwin') template.push({ role: 'windowMenu' });
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
    return { ...Storage.dataPaths(app.getPath('documents'), APP_VERSION), userData: app.getPath('userData') };
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

function githubSyncStatePath() {
    return path.join(app.getPath('userData'), 'github-sync-state.json');
}

let githubEncryptionStatus = null;
function githubEncryptionAvailable() {
    try {
        githubEncryptionStatus = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
        githubEncryptionStatus = false;
    }
    return githubEncryptionStatus;
}

function encryptGithubToken(token) {
    const value = String(token || '').trim();
    if (!value) return null;
    if (!githubEncryptionAvailable()) throw new Error('当前系统的安全存储不可用，无法安全保存 GitHub 令牌');
    return safeStorage.encryptString(value).toString('base64');
}

function decryptGithubToken(ciphertext) {
    if (!ciphertext || !githubEncryptionAvailable()) return '';
    try {
        return safeStorage.decryptString(Buffer.from(String(ciphertext), 'base64')).trim();
    } catch {
        return '';
    }
}

function readGithubCliToken() {
    return new Promise(resolve => {
        const childEnv = { ...process.env };
        delete childEnv.ALL_PROXY;
        delete childEnv.HTTP_PROXY;
        delete childEnv.HTTPS_PROXY;
        const child = spawn('gh', ['auth', 'token', '--hostname', 'github.com'], {
            cwd: __dirname,
            env: childEnv,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let output = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            resolve('');
        }, 5000);
        child.stdout.on('data', chunk => {
            if (output.length < 1000) output += chunk.toString();
        });
        child.once('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve('');
        });
        child.once('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(code === 0 ? output.trim() : '');
        });
    });
}

async function adoptGithubCliToken() {
    const state = await getGithubSyncState();
    if (decryptGithubToken(state.tokenCiphertext)) return false;
    const token = await readGithubCliToken();
    if (!token || !githubEncryptionAvailable()) return false;
    state.tokenCiphertext = encryptGithubToken(token);
    await persistGithubSyncState();
    return true;
}

function normalizeGithubQueueFile(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        kind: source.kind === 'events' ? 'events' : 'edf',
        localPath: String(source.localPath || source.filePath || '').slice(0, 2000),
        archivePath: String(source.archivePath || source.path || '').slice(0, 500),
    };
}

function normalizeGithubQueueItem(value) {
    const source = value && typeof value === 'object' ? value : {};
    const config = GithubSync.normalizeGithubConfig(source.config);
    const session = {
        id: String(source.session?.id || source.sessionId || '').slice(0, 120),
        startedAt: source.session?.startedAt || null,
    };
    const fallbackFiles = source.filePath ? [{
        kind: 'edf',
        localPath: source.filePath,
        archivePath: source.archivePath || GithubSync.buildEdfArchivePath(session, config),
    }] : [];
    const files = (Array.isArray(source.files) ? source.files : fallbackFiles)
        .map(normalizeGithubQueueFile)
        .filter(file => file.localPath && file.archivePath);
    const edfFile = files.find(file => file.kind === 'edf') || files[0] || { localPath: '', archivePath: '' };
    return {
        sessionId: String(source.sessionId || '').slice(0, 120),
        sessionJsonPath: String(source.sessionJsonPath || '').slice(0, 2000),
        filePath: String(source.filePath || edfFile.localPath || '').slice(0, 2000),
        eventsPath: String(source.eventsPath || files.find(file => file.kind === 'events')?.localPath || '').slice(0, 2000),
        files,
        session,
        config,
        archivePath: String(source.archivePath || edfFile.archivePath || GithubSync.buildEdfArchivePath(session, config)).slice(0, 500),
        eventsExpected: source.eventsExpected === true,
        eventsMissing: source.eventsMissing === true,
        reason: source.reason === 'manual' ? 'manual' : 'automatic',
        status: ['queued', 'uploading', 'failed', 'not_configured'].includes(source.status) ? source.status : 'queued',
        attempts: Number.isFinite(Number(source.attempts)) ? Math.max(0, Number(source.attempts)) : 0,
        queuedAt: source.queuedAt || null,
        lastAttemptAt: source.lastAttemptAt || null,
        error: source.error ? String(source.error).slice(0, 300) : null,
    };
}

async function getGithubSyncState() {
    if (githubSyncState) return githubSyncState;
    if (!githubSyncStatePromise) {
        githubSyncStatePromise = (async () => {
            const stored = await readJson(githubSyncStatePath(), null);
            const queue = Array.isArray(stored?.queue)
                ? stored.queue.map(normalizeGithubQueueItem).filter(item => item.sessionId && item.files.some(file => file.kind === 'edf'))
                : [];
            githubSyncState = {
                version: 1,
                config: GithubSync.normalizeGithubConfig(stored?.config),
                tokenCiphertext: typeof stored?.tokenCiphertext === 'string' ? stored.tokenCiphertext : null,
                queue,
            };
            return githubSyncState;
        })().finally(() => { githubSyncStatePromise = null; });
    }
    return githubSyncStatePromise;
}

async function persistGithubSyncState() {
    const state = await getGithubSyncState();
    await writeJsonAtomic(githubSyncStatePath(), {
        version: 1,
        config: GithubSync.redactGithubConfig(state.config),
        tokenCiphertext: state.tokenCiphertext || null,
        queue: state.queue.map(normalizeGithubQueueItem),
    });
}

function publicGithubSyncState(state) {
    return {
        config: GithubSync.redactGithubConfig(state.config),
        tokenStored: Boolean(state.tokenCiphertext),
        encryptionAvailable: githubEncryptionStatus,
        queue: state.queue.map(item => ({
            sessionId: item.sessionId,
            repository: item.config.repository,
            path: item.archivePath,
            files: item.files.map(file => ({ kind: file.kind, path: file.archivePath })),
            eventsExpected: item.eventsExpected,
            eventsMissing: item.eventsMissing,
            status: item.status,
            reason: item.reason,
            attempts: item.attempts,
            queuedAt: item.queuedAt,
            lastAttemptAt: item.lastAttemptAt,
            error: item.error,
        })),
    };
}

async function emitGithubSyncStatus(extra = {}) {
    const state = await getGithubSyncState();
    const payload = { ...publicGithubSyncState(state), ...extra };
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('github-sync:status', payload);
    }
    return payload;
}

function githubApiRequest(pathname, { method = 'GET', token = '', body = null } = {}) {
    return new Promise((resolve, reject) => {
        if (!net?.request) {
            reject(new Error('当前运行环境不支持 GitHub 网络请求'));
            return;
        }
        const request = net.request({
            method,
            url: `https://api.github.com${pathname}`,
            session: session.defaultSession,
        });
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            request.abort();
            reject(new Error('GitHub 请求超时，请检查网络或代理连通性'));
        }, 30000);
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };
        request.setHeader('Accept', 'application/vnd.github+json');
        request.setHeader('User-Agent', 'CaoCao-EEG-Desktop/0.6.1');
        request.setHeader('X-GitHub-Api-Version', '2022-11-28');
        if (token) request.setHeader('Authorization', `Bearer ${token}`);
        if (body !== null) request.setHeader('Content-Type', 'application/json');
        request.on('response', response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let payload = null;
                try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text.slice(0, 300) }; }
                if (response.statusCode >= 400) {
                    const error = new Error(`GitHub 请求失败（${response.statusCode}）：${payload?.message || '未知错误'}`);
                    error.statusCode = response.statusCode;
                    finish(reject, error);
                    return;
                }
                finish(resolve, payload);
            });
            response.on('error', error => finish(reject, error));
        });
        request.on('error', error => finish(reject, error));
        if (body !== null) request.write(JSON.stringify(body));
        request.end();
    });
}

async function githubRepositoryInfo(config, token) {
    if (!token) throw new Error('尚未配置 GitHub 令牌，请在“记录”页面保存令牌后再测试');
    const { owner, name } = GithubSync.parseRepository(config.repository);
    const repository = await githubApiRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { token });
    if (repository.private !== true) {
        throw new Error('为避免原始 EEG 外泄，自动 EDF 归档只允许私有 GitHub 仓库');
    }
    return repository;
}

function sessionsRootPath() {
    return `${path.resolve(appDataPaths().sessions)}${path.sep}`;
}

function isSessionPath(targetPath) {
    const resolved = path.resolve(String(targetPath || ''));
    return resolved.startsWith(sessionsRootPath());
}

async function updateSessionGithubUpload(sessionJsonPath, patch) {
    if (!isSessionPath(sessionJsonPath)) throw new Error('GitHub 同步目标不在受控会话目录中');
    const metadata = await readJson(sessionJsonPath, null);
    if (!metadata) return null;
    metadata.githubUpload = GithubSync.normalizeUploadStatus({ ...metadata.githubUpload, ...patch });
    await writeJsonAtomic(sessionJsonPath, metadata);
    return metadata.githubUpload;
}

async function uploadGithubFile(item, file, token, repository, branch) {
    if (!isSessionPath(file.localPath)) throw new Error(`${file.kind === 'events' ? 'events' : 'EDF'} 路径不在受控会话目录中`);
    const stat = await fsp.stat(file.localPath);
    if (!stat.isFile()) throw new Error(`${file.kind === 'events' ? 'events' : 'EDF'} 目标不是文件`);
    if (stat.size <= 0) throw new Error(`${file.kind === 'events' ? 'events' : 'EDF'} 文件为空，暂不上传`);
    if (stat.size > GithubSync.MAX_CONTENT_API_BYTES) {
        throw new Error(`${file.kind === 'events' ? 'events' : 'EDF'} 文件超过 GitHub Contents API 安全上限（${Math.round(GithubSync.MAX_CONTENT_API_BYTES / 1024 / 1024)} MB）`);
    }
    const contentPath = GithubSync.contentApiPath(item.config.repository, file.archivePath);
    let existing = null;
    try {
        existing = await githubApiRequest(`${contentPath}?ref=${encodeURIComponent(branch)}`, { token });
    } catch (error) {
        if (error.statusCode !== 404) throw error;
    }
    const content = (await fsp.readFile(file.localPath)).toString('base64');
    const response = await githubApiRequest(contentPath, {
        method: 'PUT',
        token,
        body: {
            message: `archive: EEG ${file.kind === 'events' ? 'events' : 'EDF'} ${item.sessionId}`,
            content,
            branch,
            ...(existing?.sha ? { sha: existing.sha } : {}),
        },
    });
    return {
        repository: item.config.repository,
        branch,
        kind: file.kind,
        path: file.archivePath,
        fileUrl: response?.content?.html_url || null,
        commitUrl: response?.commit?.html_url || null,
        commitSha: response?.commit?.sha || null,
        bytes: stat.size,
    };
}

async function processGithubUploadQueue() {
    if (githubUploadProcessPromise) return githubUploadProcessPromise;
    githubUploadProcessPromise = (async () => {
        const state = await getGithubSyncState();
        for (const item of [...state.queue]) {
            const token = decryptGithubToken(state.tokenCiphertext);
            if (!token) {
                item.status = 'not_configured';
                item.error = '未配置可用的 GitHub 令牌';
                await persistGithubSyncState();
                await updateSessionGithubUpload(item.sessionJsonPath, {
                    status: 'not_configured', attempts: item.attempts, error: item.error,
                    repository: item.config.repository, path: item.archivePath, branch: item.config.branch,
                    files: item.files.map(file => ({ kind: file.kind, path: file.archivePath })),
                    eventsExpected: item.eventsExpected, eventsMissing: item.eventsMissing,
                }).catch(() => {});
                await emitGithubSyncStatus();
                continue;
            }
            item.status = 'uploading';
            item.attempts += 1;
            item.lastAttemptAt = nowIso();
            item.error = null;
            await persistGithubSyncState();
            await updateSessionGithubUpload(item.sessionJsonPath, {
                status: 'uploading', attempts: item.attempts, startedAt: item.lastAttemptAt,
                repository: item.config.repository, path: item.archivePath, branch: item.config.branch,
                files: item.files.map(file => ({ kind: file.kind, path: file.archivePath })),
                eventsExpected: item.eventsExpected, eventsMissing: item.eventsMissing,
            }).catch(() => {});
            await emitGithubSyncStatus();
            try {
                const repository = await githubRepositoryInfo(item.config, token);
                const branch = item.config.branch || repository.default_branch || 'main';
                const uploadedFiles = [];
                for (const file of item.files) {
                    uploadedFiles.push(await uploadGithubFile(item, file, token, repository, branch));
                }
                const uploaded = uploadedFiles.find(file => file.kind === 'edf') || uploadedFiles[0];
                await updateSessionGithubUpload(item.sessionJsonPath, {
                    status: 'uploaded', attempts: item.attempts, completedAt: nowIso(),
                    repository: uploaded.repository, path: uploaded.path, branch: uploaded.branch,
                    fileUrl: uploaded.fileUrl, commitUrl: uploaded.commitUrl, error: null,
                    files: uploadedFiles,
                    eventsExpected: item.eventsExpected,
                    eventsMissing: item.eventsMissing,
                });
                state.queue = state.queue.filter(candidate => candidate !== item);
                await persistGithubSyncState();
                await emitGithubSyncStatus({ lastUploadedSessionId: item.sessionId });
            } catch (error) {
                item.status = 'failed';
                item.error = String(error.message || error).slice(0, 300);
                await persistGithubSyncState();
                await updateSessionGithubUpload(item.sessionJsonPath, {
                    status: 'failed', attempts: item.attempts, error: item.error,
                    repository: item.config.repository, path: item.archivePath, branch: item.config.branch,
                    files: item.files.map(file => ({ kind: file.kind, path: file.archivePath })),
                    eventsExpected: item.eventsExpected, eventsMissing: item.eventsMissing,
                }).catch(() => {});
                await emitGithubSyncStatus({ lastError: item.error });
            }
        }
        return publicGithubSyncState(state);
    })().finally(() => { githubUploadProcessPromise = null; });
    return githubUploadProcessPromise;
}

async function resolveGithubUploadFiles(session, { filePath, eventsPath, files = null } = {}, config) {
    if (Array.isArray(files) && files.length) {
        return files.map(normalizeGithubQueueFile).filter(file => file.localPath && file.archivePath);
    }
    const archivePaths = GithubSync.buildSessionArchivePaths(session, config);
    const result = [{ kind: 'edf', localPath: filePath, archivePath: archivePaths.edf }];
    const candidateEventsPath = eventsPath || (filePath ? path.join(path.dirname(filePath), 'events.jsonl') : '');
    if (candidateEventsPath && isSessionPath(candidateEventsPath)) {
        try {
            const stat = await fsp.stat(candidateEventsPath);
            if (stat.isFile() && stat.size > 0 && stat.size <= GithubSync.MAX_CONTENT_API_BYTES) {
                result.push({ kind: 'events', localPath: candidateEventsPath, archivePath: archivePaths.events });
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return result;
}

async function enqueueGithubUpload(session, { filePath, eventsPath, files = null, sessionJsonPath, reason = 'automatic', force = false } = {}) {
    const state = await getGithubSyncState();
    const config = GithubSync.normalizeGithubConfig(state.config);
    if (!force && config.autoUploadStimulated !== true) {
        return GithubSync.normalizeUploadStatus({ status: 'disabled', repository: config.repository });
    }
    if (!filePath || !sessionJsonPath || !isSessionPath(filePath) || !isSessionPath(sessionJsonPath)) {
        throw new Error('EDF 或会话元数据路径不在受控目录中');
    }
    if (path.extname(filePath).toLowerCase() !== '.edf') {
        throw new Error('GitHub 自动归档只接受已经封存的 EDF，旧版 CSV 不能伪装成 EDF 上传');
    }
    const uploadFiles = await resolveGithubUploadFiles(session, { filePath, eventsPath, files }, config);
    if (!uploadFiles.some(file => file.kind === 'edf')) throw new Error('未找到可上传的 EDF 文件');
    const archivePath = uploadFiles.find(file => file.kind === 'edf').archivePath;
    const eventsExpected = Boolean(eventsPath || uploadFiles.some(file => file.kind === 'events'));
    const eventsMissing = eventsExpected && !uploadFiles.some(file => file.kind === 'events');
    const token = decryptGithubToken(state.tokenCiphertext);
    const initialStatus = token ? 'queued' : 'not_configured';
    let item = state.queue.find(candidate => candidate.sessionId === String(session.id));
    if (!item) {
        item = normalizeGithubQueueItem({
            sessionId: session.id, sessionJsonPath, filePath, eventsPath,
            files: uploadFiles,
            session: { id: session.id, startedAt: session.startedAt },
            config, archivePath, reason, status: initialStatus, queuedAt: nowIso(),
            eventsExpected, eventsMissing,
        });
        state.queue.push(item);
    } else {
        item.status = initialStatus;
        item.error = token ? null : '请先保存 GitHub 令牌并测试私有仓库连接';
        item.filePath = filePath;
        item.eventsPath = eventsPath || item.eventsPath;
        item.files = uploadFiles;
        item.sessionJsonPath = sessionJsonPath;
        item.reason = reason;
        item.config = config;
        item.archivePath = archivePath;
        item.eventsExpected = eventsExpected;
        item.eventsMissing = eventsMissing;
        item.queuedAt = item.queuedAt || nowIso();
    }
    if (!token) item.error = '请先保存 GitHub 令牌并测试私有仓库连接';
    await persistGithubSyncState();
    return GithubSync.normalizeUploadStatus({
        status: initialStatus, repository: config.repository, path: archivePath,
        files: uploadFiles.map(file => ({ kind: file.kind, path: file.archivePath })),
        eventsExpected, eventsMissing, branch: config.branch, queuedAt: item.queuedAt,
        attempts: item.attempts, error: item.error,
    });
}

async function prepareAutomaticGithubUpload(finalSession, filePath, sessionJsonPath, hasStimulation, eventsPath) {
    if (!hasStimulation) return GithubSync.normalizeUploadStatus({ status: 'not_applicable' });
    try {
        return await enqueueGithubUpload(finalSession, { filePath, eventsPath, sessionJsonPath });
    } catch (error) {
        return GithubSync.normalizeUploadStatus({ status: 'failed', error: error.message });
    }
}

async function saveGithubSyncConfig(input = {}) {
    const state = await getGithubSyncState();
    const source = input.config || input;
    const errors = GithubSync.validateGithubConfig(source);
    if (errors.length) throw new Error(errors.join('；'));
    const config = GithubSync.normalizeGithubConfig(source);
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (input.clearToken === true) state.tokenCiphertext = null;
    if (token) state.tokenCiphertext = encryptGithubToken(token);
    state.config = config;
    await persistGithubSyncState();
    const result = await emitGithubSyncStatus();
    if (token || state.tokenCiphertext) void processGithubUploadQueue();
    return result;
}

async function testGithubSyncConnection() {
    const state = await getGithubSyncState();
    const token = decryptGithubToken(state.tokenCiphertext);
    const repository = await githubRepositoryInfo(state.config, token);
    return {
        ...publicGithubSyncState(state),
        repository: state.config.repository,
        private: repository.private === true,
        defaultBranch: repository.default_branch || state.config.branch,
        permissions: repository.permissions ? {
            push: repository.permissions.push === true,
            maintain: repository.permissions.maintain === true,
        } : null,
        message: 'GitHub 私有仓库连接正常，可自动归档 EDF',
    };
}

async function retryGithubUploads() {
    const state = await getGithubSyncState();
    for (const item of state.queue) {
        if (item.status === 'failed' || item.status === 'not_configured') {
            item.status = 'queued';
            item.error = null;
        }
    }
    await persistGithubSyncState();
    return processGithubUploadQueue();
}

async function uploadSessionToGithub(sessionId) {
    const sessions = await listSessions();
    const selected = sessions.find(item => item.id === sessionId);
    if (!selected) throw new Error('未找到指定采集会话');
    const directory = path.resolve(selected.directory);
    const filePath = path.resolve(path.join(directory, selected.dataFile || 'eeg_raw.edf'));
    const sessionJsonPath = path.join(directory, 'session.json');
    const eventsPath = path.join(directory, 'events.jsonl');
    if (!isSessionPath(filePath) || !isSessionPath(sessionJsonPath) || !isSessionPath(eventsPath)) throw new Error('会话路径不在受控记录目录中');
    const status = await enqueueGithubUpload(selected, { filePath, eventsPath, sessionJsonPath, reason: 'manual', force: true });
    await updateSessionGithubUpload(sessionJsonPath, status);
    if (status.status === 'queued') void processGithubUploadQueue();
    return status;
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
        if (analysisWindow && !analysisWindow.isDestroyed()) analysisWindow.close();
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
        modal: false,
        show: false,
        width: 1380,
        height: 900,
        minWidth: 960,
        minHeight: 680,
        backgroundColor: '#edf2f6',
        title: '曹操 · 记录分析',
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
        ...(metadata.rawStorageVersion === 1 ? {
            rawDataFile: 'raw_adc.bin', rawRecordBytes: 16,
            rawEncoding: 'int32le-code,uint16le-seq,uint16-reserved,float64le-elapsed-ms',
            adcScale: { vrefVolts: 4.5, gain: 24 },
        } : {}),
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
        hadStimulation: false,
        stimulationCount: 0,
    };
    if (session.rawDataFile) {
        recording.rawPartial = path.join(directory, 'raw_adc.bin.partial');
        await fsp.writeFile(recording.rawPartial, Buffer.alloc(0), { flag: 'wx' });
    }
    await fsp.appendFile(recording.eventsPath, `${JSON.stringify({ ts: nowIso(), level: 'info', action: 'session_started', sessionId: id })}\n`, 'utf8');
    if (recordingPowerBlocker == null) recordingPowerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    activeRecordings.set(id, recording);
    return { ...session, edfPath: edfPartial };
}

async function appendRecordingSamples(id, samples, gapEvents = []) {
    const recording = activeRecordings.get(id);
    if (!recording || recording.stopPromise || recording.finalizedEdf) throw new Error(`Recording ${id} is not accepting samples`);
    if (!Array.isArray(samples) || samples.length === 0) return { rows: recording.rows };
    recording.appendPromise = recording.appendPromise.then(async () => {
        if (!recording.rawPartial) return recording.edfWriter.appendSamples(samples);
        const raw = encodeRawRecords(samples);
        const values = samples.map(s => s.rawCode * 4.5e6 / (24 * 8388608));
        await fsp.appendFile(recording.rawPartial, raw);
        const result = await recording.edfWriter.appendSamples(values);
        if (Array.isArray(gapEvents) && gapEvents.length) {
            const lines = gapEvents.map(event => JSON.stringify({ ...event, sessionId: id })).join('\n') + '\n';
            try { await fsp.appendFile(recording.eventsPath, lines, 'utf8'); }
            catch (error) { console.error('Failed to write EEG gap diagnostics:', error.message); }
        }
        return result;
    });
    const result = await recording.appendPromise;
    recording.rows = result.rows;
    return { rows: recording.rows, records: result.records };
}

async function appendRecordingEvent(id, event) {
    const recording = activeRecordings.get(id);
    if (!recording) return appendEventLog(event);
    const record = { ts: nowIso(), sessionId: id, ...event };
    if (record.action === 'light_started') {
        recording.hadStimulation = true;
        recording.stimulationCount += 1;
    }
    await fsp.appendFile(recording.eventsPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
}

async function stopRecording(id, status = 'completed', reason = null) {
    const recording = activeRecordings.get(id);
    if (!recording) return null;
    if (recording.stopPromise) return recording.stopPromise;
    recording.stopPromise = (async () => {
        // An append failure must not prevent closing the writer and preserving
        // whatever was saved. Keep the entry available if finalization itself
        // fails, so a retry can complete after disk space is restored.
        try { await recording.appendPromise; }
        catch (error) { recording.writeError = error.message; }
        const edf = recording.finalizedEdf || await recording.edfWriter.finalize();
        recording.finalizedEdf = edf;
        if (recording.writeError) { status = 'failed'; reason = 'recording_write_failed'; }
        const endedAt = nowIso();
        const finalSession = {
            ...recording.session,
            status,
            reason,
            endedAt,
            rows: edf.receivedSamples,
            edfRecords: edf.records,
            edfPaddedSamples: edf.paddedSamples,
            hasStimulation: recording.hadStimulation,
            stimulationCount: recording.stimulationCount,
            ...(recording.writeError ? { writeError: recording.writeError } : {}),
        };
        await fsp.appendFile(recording.eventsPath, `${JSON.stringify({ ts: endedAt, level: 'info', action: 'session_stopped', status, reason, rows: edf.receivedSamples })}\n`, 'utf8');
        if (!recording.edfRenamed) {
            await fsp.rename(recording.edfPartial, recording.edfFinal);
            recording.edfRenamed = true;
        }
        if (recording.rawPartial && !recording.rawRenamed) {
            await fsp.rename(recording.rawPartial, path.join(recording.session.directory, 'raw_adc.bin'));
            recording.rawRenamed = true;
        }
        const sessionJsonPath = path.join(recording.session.directory, 'session.json');
        finalSession.githubUpload = await prepareAutomaticGithubUpload(
            finalSession, recording.edfFinal, sessionJsonPath, recording.hadStimulation, recording.eventsPath,
        );
        await writeJsonAtomic(sessionJsonPath, finalSession);
        activeRecordings.delete(id);
        if (activeRecordings.size === 0 && recordingPowerBlocker != null) {
            powerSaveBlocker.stop(recordingPowerBlocker);
            recordingPowerBlocker = null;
        }
        if (finalSession.githubUpload.status === 'queued') void processGithubUploadQueue();
        return { ...finalSession, edfPath: recording.edfFinal };
    })().finally(() => { recording.stopPromise = null; });
    return recording.stopPromise;
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

function githubUploadHasFile(upload, kind, archivePath) {
    if (!upload || upload.status !== 'uploaded') return false;
    if (kind === 'edf' && upload.path === archivePath) return true;
    return Array.isArray(upload.files) && upload.files.some(file => (
        (file.kind === kind || (kind === 'edf' && !file.kind)) && file.path === archivePath
    ));
}

async function buildGithubHistoryCandidate(session, config, today = localDateKey()) {
    if (!session?.id || session.status === 'recording') return null;
    const started = new Date(session.startedAt || '');
    if (!Number.isFinite(started.getTime())) return null;
    const date = localDateKey(started);
    if (date >= today) return null;
    const directory = path.resolve(String(session.directory || ''));
    const sessionJsonPath = path.join(directory, 'session.json');
    const filePath = path.resolve(path.join(directory, session.dataFile || 'eeg_raw.edf'));
    const eventsPath = path.join(directory, 'events.jsonl');
    if (!isSessionPath(directory) || !isSessionPath(sessionJsonPath) || !isSessionPath(filePath) || !isSessionPath(eventsPath)) return null;
    let edfStat;
    try {
        edfStat = await fsp.stat(filePath);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (!edfStat.isFile() || edfStat.size <= 0) return null;
    let eventsStat = null;
    try {
        eventsStat = await fsp.stat(eventsPath);
        if (!eventsStat.isFile() || eventsStat.size > GithubSync.MAX_CONTENT_API_BYTES) eventsStat = null;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    const archivePaths = GithubSync.buildSessionArchivePaths(session, config);
    const hasEvents = Boolean(eventsStat && eventsStat.size > 0);
    const upload = GithubSync.normalizeUploadStatus(session.githubUpload || {});
    const alreadyUploaded = githubUploadHasFile(upload, 'edf', archivePaths.edf)
        && (!hasEvents || githubUploadHasFile(upload, 'events', archivePaths.events));
    return {
        id: session.id,
        startedAt: session.startedAt || null,
        endedAt: session.endedAt || null,
        date,
        status: session.status || 'unknown',
        rows: Number(session.rows || 0),
        edfBytes: edfStat.size,
        eventsBytes: eventsStat ? eventsStat.size : null,
        hasEvents,
        alreadyUploaded,
        archivePaths,
    };
}

async function getGithubHistoryCandidates() {
    const state = await getGithubSyncState();
    const sessions = await listSessions();
    const today = localDateKey();
    const candidates = [];
    for (const session of sessions) {
        const candidate = await buildGithubHistoryCandidate(session, state.config, today);
        if (candidate) candidates.push(candidate);
    }
    return candidates.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

async function uploadGithubHistory(input = {}) {
    const request = input && typeof input === 'object' ? input : {};
    const candidates = await getGithubHistoryCandidates();
    const requestedIds = Array.isArray(request.sessionIds)
        ? new Set(request.sessionIds.map(value => String(value)))
        : null;
    const selected = requestedIds
        ? candidates.filter(candidate => requestedIds.has(String(candidate.id)))
        : candidates.filter(candidate => !candidate.alreadyUploaded);
    const sessions = await listSessions();
    const statuses = [];
    for (const candidate of selected) {
        const session = sessions.find(item => item.id === candidate.id);
        if (!session) continue;
        const directory = path.resolve(session.directory);
        const filePath = path.resolve(path.join(directory, session.dataFile || 'eeg_raw.edf'));
        const eventsPath = path.join(directory, 'events.jsonl');
        const sessionJsonPath = path.join(directory, 'session.json');
        const status = await enqueueGithubUpload(session, {
            filePath, eventsPath, sessionJsonPath, reason: 'manual', force: true,
        });
        await updateSessionGithubUpload(sessionJsonPath, status);
        statuses.push({ sessionId: session.id, status });
    }
    if (statuses.some(item => item.status.status === 'queued')) void processGithubUploadQueue();
    const state = await getGithubSyncState();
    return {
        ...publicGithubSyncState(state),
        selectedCount: statuses.length,
        statuses,
        candidates: await getGithubHistoryCandidates(),
    };
}

async function readSessionStagingHistory(sessionId) {
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
    let content = '';
    try {
        content = await fsp.readFile(path.join(directory, 'events.jsonl'), 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return {
        sessionId: selected.id,
        startedAt: selected.startedAt || null,
        endedAt: selected.endedAt || null,
        ...parseSessionStagingHistory(content),
    };
}

function runChildProcess(command, args) {
    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawn(command, args, {
            cwd: __dirname,
            env: { ...process.env, NUMBA_CACHE_DIR: path.join(app.getPath('userData'), 'cache', 'numba') },
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
    if (selected.status !== 'recording' && Number.isFinite(Number(selected.rows))
        && Number(selected.rows) < Number(selected.sampleRateHz || 250) * 30) {
        throw new Error('记录不足 30 秒，无法重新分期。');
    }
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
        const result = await runChildProcess(command, [...prefix, '-B', scriptPath, ...scriptArgs]);
        if (result.error) {
            failures.push(`${command}：${result.error.message}`);
            if (explicitPython || result.error.code !== 'ENOENT') break;
            continue;
        }
        const payload = parseLastJsonLine(result.stdout);
        if (result.code === 0 && payload?.ok) {
            return { ...payload, pythonCommand: command, outputDir };
        }
        if (payload?.errorType && !['ModuleNotFoundError', 'ImportError'].includes(payload.errorType)) {
            throw new Error(`YASA 分期失败：${payload.error}`);
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

let anySleepRunning = false;

async function runAnySleepComparison(sender, sessionId) {
    if (!analysisWindow || analysisWindow.isDestroyed() || analysisWindow.webContents.id !== sender.id) {
        throw new Error('请在记录分析窗口运行离线对照');
    }
    if (anySleepRunning) throw new Error('已有一个离线分期对照正在运行');
    anySleepRunning = true;
    try {
        const options = { rootDir: __dirname };
        if (sessionId) {
            const selected = (await listSessions()).find(item => item.id === sessionId);
            if (!selected || selected.status === 'recording') throw new Error('请选择已结束的采集记录');
            options.edfPath = path.join(selected.directory, 'eeg_raw.edf');
            options.eventsPath = path.join(selected.directory, 'events.jsonl');
            if (!isSessionPath(options.edfPath) || !isSessionPath(options.eventsPath)) {
                throw new Error('记录路径不在会话目录中');
            }
            if (Number.isSafeInteger(selected.rows) && selected.rows > 0) options.rows = selected.rows;
        } else {
            const selected = await dialog.showOpenDialog(analysisWindow, {
                title: '选择 CH2 EDF 进行离线分期对照',
                properties: ['openFile'],
                filters: [{ name: 'EEG EDF', extensions: ['edf'] }],
            });
            if (selected.canceled || !selected.filePaths.length) return null;
            options.edfPath = selected.filePaths[0];
        }
        const local = await readJson(path.join(__dirname, 'python', 'anysleep.local.json'), {});
        options.python = local.python || process.env.BRAINLUME_ANYSLEEP_PYTHON;
        options.outputRoot = local.outputRoot || path.join(appDataPaths().root, 'analysis', 'anysleep');
        return await new Promise((resolve, reject) => {
            const worker = new Worker(path.join(__dirname, 'src', 'anysleep-comparison.js'), { workerData: options });
            worker.on('message', message => {
                if (message.progress) {
                    if (!sender.isDestroyed()) sender.send('analysis:anysleep-progress', message.progress);
                } else if (message.result) resolve(message.result);
                else if (message.error) reject(new Error(message.error));
            });
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error('离线分期进程已退出（' + code + '）')));
        });
    } finally {
        anySleepRunning = false;
    }
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
        const summary = await analysisRequest(entry, 'open', {
            directory, sessionId, includeEpochs: false, includeSpectra: false,
        });
        const savedYasa = await readSavedYasaResult(directory, selected);
        return { analysisId, ...summary, savedYasa };
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
    data.savedYasa = await readSavedYasaResult(entry.directory, data.metadata);
    data.generatedAt = nowIso();
    const ownerWindow = BrowserWindow.getAllWindows().find(window => window.webContents.id === entry.webContentsId) || mainWindow;
    const result = await dialog.showSaveDialog(ownerWindow, {
        title: '导出记录分析报告',
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

// Only the local development bundle carries this marker. The renderer
// can request a check or restart, but cannot choose what executable runs.
function registerLocalUpdate() {
    if (process.platform !== 'darwin' || !app.isPackaged || debugCliMode || deviceDiagnosticMode) return false;
    let launcher;
    try {
        const marker = path.join(process.resourcesPath, 'caocao-local-update.json');
        launcher = JSON.parse(fs.readFileSync(marker, 'utf8')).launcher;
        if (typeof launcher !== 'string' || !path.isAbsolute(launcher)) return false;
    } catch { return false; }

    let pending = false;
    let restarting = false;
    const canUpdate = event => event.sender === mainWindow?.webContents
        && !analysisWindow && !activeAnalyses.size && !activeRecordings.size
        && !historyReplay.running && !githubUploadProcessPromise;

    ipcMain.handle('local-update:check', event => {
        if (!canUpdate(event) || restarting) return false;
        return new Promise(resolve => {
            execFile(launcher, ['--check-only'], { timeout: 10_000 }, (error, output) => {
                pending = !error && output.trim() === 'pending';
                resolve(pending && canUpdate(event));
            });
        });
    });
    ipcMain.handle('local-update:restart', async event => {
        if (!pending || restarting || !canUpdate(event)) return false;
        restarting = true;
        try {
            await new Promise((resolve, reject) => {
                const child = spawn(launcher, ['--wait-for-pid', String(process.pid)], {
                    detached: true, stdio: 'ignore',
                });
                child.once('error', reject);
                child.once('spawn', () => { child.unref(); resolve(); });
            });
        } catch (error) {
            restarting = false;
            console.error('无法启动本机更新程序', error.message);
            return false;
        }
        if (!canUpdate(event)) {
            restarting = false;
            return false;
        }
        setTimeout(() => app.quit(), 100);
        return true;
    });
    return true;
}

function registerIpc() {
    const localUpdateAvailable = registerLocalUpdate();
    ipcMain.on('local-update:available', event => { event.returnValue = localUpdateAvailable; });
    ipcMain.on('ble:select-device', (_event, id) => {
        completeBluetoothSelection(id);
    });
    ipcMain.on('launch:get-mode', event => { event.returnValue = deviceDiagnosticMode || 'normal'; });
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
    ipcMain.handle('session:append-samples', (_event, id, samples, gapEvents) => appendRecordingSamples(id, samples, gapEvents));
    ipcMain.handle('session:event', (_event, id, record) => appendRecordingEvent(id, record));
    ipcMain.handle('session:stop', (_event, id, status, reason) => stopRecording(id, status, reason));
    ipcMain.handle('sessions:list', () => listSessions());
    ipcMain.handle('history-replay:status', historyReplayStatus);
    ipcMain.handle('history-replay:start', (_event, protocol) => startHistoryReplay(protocol));
    ipcMain.handle('history-replay:cancel', () => { historyReplayWorker?.postMessage('cancel'); return true; });
    ipcMain.handle('history-replay:open', openHistoryReplayReport);
    ipcMain.handle('session:staging-history', (_event, sessionId) => readSessionStagingHistory(sessionId));
    ipcMain.handle('analysis-window:open', (_event, sessionId) => openAnalysisWindow(sessionId));
    ipcMain.handle('analysis-window:close', event => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window && window !== mainWindow && !window.isDestroyed()) window.close();
        return true;
    });
    ipcMain.handle('analysis:open', (event, sessionId) => openAnalysis(sessionId, event.sender.id));
    ipcMain.handle('analysis:viewport', (_event, request) => analysisRequest(requireAnalysis(request.analysisId), 'viewport', request));
    ipcMain.handle('analysis:spectrogram', (_event, request) => analysisRequest(requireAnalysis(request.analysisId), 'spectrogram', request));
    ipcMain.handle('analysis:segments', (_event, analysisId, segments) => analysisRequest(
        requireAnalysis(analysisId), 'segments', { segments, includeEpochs: false, includeSpectra: false },
    ));
    ipcMain.handle('analysis:export', (_event, analysisId) => exportAnalysisReport(analysisId));
    ipcMain.handle('analysis:yasa', (_event, sessionId) => runYasaStaging(sessionId));
    ipcMain.handle('analysis:anysleep', (event, sessionId) => runAnySleepComparison(event.sender, sessionId));
    registerResearchReview(ipcMain, path.join(__dirname, 'n3-research.local.json'),
        () => analysisWindow && !analysisWindow.isDestroyed() ? analysisWindow.webContents : null);
    ipcMain.handle('analysis:close', (_event, analysisId) => closeAnalysis(analysisId));
    ipcMain.handle('sleep:model-info', () => sleepRequest('info'));
    ipcMain.handle('sleep:infer', (_event, payload) => sleepRequest('infer', payload));
    ipcMain.handle('app:event', (_event, record) => appendEventLog(record));
    ipcMain.handle('github-sync:get-config', async () => publicGithubSyncState(await getGithubSyncState()));
    ipcMain.handle('github-sync:save-config', (_event, input) => saveGithubSyncConfig(input));
    ipcMain.handle('github-sync:test', () => testGithubSyncConnection());
    ipcMain.handle('github-sync:history-candidates', () => getGithubHistoryCandidates());
    ipcMain.handle('github-sync:upload-history', (_event, input) => uploadGithubHistory(input));
    ipcMain.handle('github-sync:retry', () => retryGithubUploads());
    ipcMain.handle('github-sync:upload-session', (_event, sessionId) => uploadSessionToGithub(sessionId));
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
        const { logs } = await ensureDataDirectories();
        const filePath = path.join(logs, `device-diagnostic-${localFileStamp()}.json`);
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
    // Do not decrypt the GitHub token during normal startup. On macOS,
    // safeStorage.decryptString opens the login keychain and can show an
    // authorization prompt for a locally/ad-hoc signed packaged app.
    // Token access remains lazy: explicit GitHub test/upload/retry actions
    // decrypt it only when the user actually requests synchronization.
    void getGithubSyncState().catch(error => {
        console.error(`GitHub EDF 同步队列初始化失败：${error.message}`);
    });
    if (debugCliMode) createDebugWindow(); else createWindow();
    app.on('activate', () => {
        const windows = [mainWindow, analysisWindow].filter(window => window && !window.isDestroyed());
        if (!windows.length) {
            createWindow();
            return;
        }
        for (const window of windows) window.show();
        (mainWindow && !mainWindow.isDestroyed() ? mainWindow : windows[0]).focus();
    });
});

app.on('before-quit', async event => {
    if (historyReplayWorker) {
        event.preventDefault();
        const worker = historyReplayWorker;
        worker.postMessage('cancel');
        await Promise.race([new Promise(resolve => worker.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
        if (historyReplayWorker === worker) { historyReplayWorker = null; await worker.terminate(); }
        app.quit(); return;
    }
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
