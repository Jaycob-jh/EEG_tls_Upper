(function (root) {
    'use strict';

    // The desktop renderer and Android WebView use the same page/controller
    // code. Only the transport and persistence boundary changes here.
    const native = root.AndroidNative;
    const candidateListeners = new Set();
    const githubStatusListeners = new Set();
    const analysisProgressListeners = new Set();
    let activeTransport = null;

    function requireNative(method) {
        if (!native || typeof native[method] !== 'function') {
            throw new Error(`Android 原生桥接不可用：${method}`);
        }
        return native[method].bind(native);
    }

    function parseNative(value, fallback = null) {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return value; }
    }

    function nativeJson(method, ...args) {
        const result = parseNative(requireNative(method)(...args));
        if (result && result.ok === false) throw new Error(result.error || 'Android 原生操作失败');
        return result;
    }

    function bytesToBase64(bytes) {
        const values = Uint8Array.from(bytes || []);
        let text = '';
        for (let index = 0; index < values.length; index += 0x8000) {
            text += String.fromCharCode(...values.subarray(index, Math.min(values.length, index + 0x8000)));
        }
        return btoa(text);
    }

    function base64ToBytes(value) {
        const text = atob(String(value || ''));
        const bytes = new Uint8Array(text.length);
        for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
        return bytes;
    }

    class AndroidBleTransport {
        constructor(options = {}) {
            this.connectAttempts = Math.max(1, Number(options.connectAttempts) || 6);
            this.connectRetryDelayMs = Math.max(250, Number(options.connectRetryDelayMs) || 1000);
            this.listeners = new Set();
            this.disconnectListeners = new Set();
            this.statusListeners = new Set();
            this.name = '';
            this.id = '';
            this.connected = false;
            this._pending = null;
            this._writeQueue = Promise.resolve();
            activeTransport = this;
        }

        _status(detail) {
            for (const listener of this.statusListeners) listener(detail);
        }

        connect() {
            if (this.connected) return Promise.resolve(this);
            if (this._pending) return this._pending.promise;
            this._pending = {};
            this._pending.promise = new Promise((resolve, reject) => {
                this._pending.resolve = resolve;
                this._pending.reject = reject;
            });
            this._status({ phase: 'scan_started', stage: 'device_scan', attempt: 1, maxAttempts: this.connectAttempts });
            try { requireNative('startScan')(); }
            catch (error) { this._pending.reject(error); this._pending = null; }
            return this._pending?.promise || Promise.reject(new Error('Android BLE 扫描未启动'));
        }

        selectDevice(id) {
            try { requireNative('selectBleDevice')(String(id || '')); }
            catch (error) { this._fail(error); }
        }

        _connected(name, id) {
            this.name = name || 'BrainLume2.0C';
            this.id = id || '';
            this.connected = true;
            this._status({ phase: 'connected', stage: 'notification_subscription', attempt: 1, maxAttempts: this.connectAttempts });
            if (this._pending) {
                this._pending.resolve(this);
                this._pending = null;
            }
        }

        _fail(error) {
            const value = error instanceof Error ? error : new Error(String(error || 'BLE 连接失败'));
            this._status({ phase: 'failed', stage: value.bleStage || 'gatt_connect', error: value.message });
            if (this._pending) {
                this._pending.reject(value);
                this._pending = null;
            }
        }

        _data(bytes) {
            for (const listener of this.listeners) listener(Uint8Array.from(bytes || []));
        }

        _disconnected(detail = {}) {
            const wasConnected = this.connected;
            this.connected = false;
            for (const listener of this.disconnectListeners) listener(detail);
            if (wasConnected) this._status({ phase: 'disconnected', ...detail });
        }

        async disconnect() {
            this._pending = null;
            try { requireNative('disconnect')(); } finally { this._disconnected({ reason: 'user' }); }
        }

        isConnected() { return this.connected; }

        onData(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
        onDisconnect(callback) { this.disconnectListeners.add(callback); return () => this.disconnectListeners.delete(callback); }
        onStatus(callback) { this.statusListeners.add(callback); return () => this.statusListeners.delete(callback); }

        write(bytes) {
            const payload = Uint8Array.from(bytes || []);
            const execute = async () => {
                if (!this.connected) throw new Error('BLE 未连接');
                nativeJson('writeBase64', bytesToBase64(payload));
            };
            const result = this._writeQueue.then(execute, execute);
            this._writeQueue = result.catch(() => {});
            return result;
        }
    }

    root.__androidBleCandidates = value => {
        const candidates = parseNative(value, []);
        for (const listener of candidateListeners) listener(Array.isArray(candidates) ? candidates : []);
    };
    root.__androidBleConnected = (name, id) => activeTransport?._connected(name, id);
    root.__androidBleConnectFailed = message => activeTransport?._fail(new Error(String(message || 'BLE 连接失败')));
    root.__androidBleData = value => activeTransport?._data(base64ToBytes(value));
    root.__androidBleDisconnected = value => activeTransport?._disconnected(parseNative(value, {}));
    root.__androidBleStatus = value => activeTransport?._status(parseNative(value, {}));
    root.__androidAnalysisProgress = value => {
        const progress = parseNative(value, {});
        for (const listener of analysisProgressListeners) listener(progress);
    };
    root.__androidGithubStatus = value => {
        const status = parseNative(value, {});
        for (const listener of githubStatusListeners) listener(status);
    };

    root.BrainLumeBle = Object.freeze({
        UUID: Object.freeze({
            service: '0000abf0-0000-1000-8000-00805f9b34fb',
            write: '0000abf1-0000-1000-8000-00805f9b34fb',
            notify: '0000abf2-0000-1000-8000-00805f9b34fb',
        }),
        DEVICE_NAME: 'BrainLume2.0C',
        BleTransport: AndroidBleTransport,
    });

    root.desktopAPI = Object.freeze({
        getLaunchMode: () => nativeJson('getLaunchMode') || 'normal',
        getDebugRequest: () => nativeJson('getDebugRequest'),
        sendDebugResult: result => Promise.resolve(nativeJson('sendDebugResult', JSON.stringify(result || {}))),
        getPaths: () => Promise.resolve(nativeJson('getPaths')),
        loadPlans: () => Promise.resolve(nativeJson('loadPlans') || []),
        savePlans: plans => Promise.resolve(nativeJson('savePlans', JSON.stringify(plans || []))),
        startSession: metadata => Promise.resolve(nativeJson('startSession', JSON.stringify(metadata || {}))),
        appendSessionSamples: (id, samples) => Promise.resolve(nativeJson('appendSessionSamples', String(id || ''), JSON.stringify(samples || []))),
        appendSessionEvent: (id, record) => Promise.resolve(nativeJson('appendSessionEvent', String(id || ''), JSON.stringify(record || {}))),
        stopSession: (id, status, reason) => Promise.resolve(nativeJson('stopSession', String(id || ''), String(status || 'completed'), String(reason || ''))),
        listSessions: () => Promise.resolve(nativeJson('listSessions') || []),
        loadSessionStagingHistory: sessionId => Promise.resolve(nativeJson('loadSessionStagingHistory', String(sessionId || ''))),
        openAnalysisWindow: sessionId => Promise.resolve(nativeJson('openAnalysisWindow', String(sessionId || ''))),
        closeAnalysisWindow: () => Promise.resolve(nativeJson('closeAnalysisWindow')),
        openAnalysis: sessionId => Promise.resolve(nativeJson('openAnalysis', String(sessionId || ''))),
        requestAnalysisViewport: request => Promise.resolve(nativeJson('requestAnalysisViewport', JSON.stringify(request || {}))),
        requestAnalysisSpectrogram: request => Promise.resolve(nativeJson('requestAnalysisSpectrogram', JSON.stringify(request || {}))),
        updateAnalysisSegments: (analysisId, segments) => Promise.resolve(nativeJson('updateAnalysisSegments', String(analysisId || ''), JSON.stringify(segments || []))),
        exportAnalysisReport: analysisId => Promise.resolve(nativeJson('exportAnalysisReport', String(analysisId || ''))),
        runYasaStaging: sessionId => Promise.resolve(nativeJson('runYasaStaging', String(sessionId || ''))),
        closeAnalysis: analysisId => Promise.resolve(nativeJson('closeAnalysis', String(analysisId || ''))),
        getSleepModelInfo: () => Promise.resolve(nativeJson('getSleepModelInfo')),
        inferSleepStage: payload => Promise.resolve(nativeJson('inferSleepStage', JSON.stringify(payload || {}))),
        getGithubSyncConfig: () => Promise.resolve(nativeJson('getGithubSyncConfig')),
        saveGithubSyncConfig: input => Promise.resolve(nativeJson('saveGithubSyncConfig', JSON.stringify(input || {}))),
        testGithubSync: () => Promise.resolve(nativeJson('testGithubSync')),
        getGithubHistoryCandidates: () => Promise.resolve(nativeJson('getGithubHistoryCandidates') || []),
        uploadGithubHistory: input => Promise.resolve(nativeJson('uploadGithubHistory', JSON.stringify(input || {}))),
        retryGithubUploads: () => Promise.resolve(nativeJson('retryGithubUploads')),
        uploadSessionToGithub: sessionId => Promise.resolve(nativeJson('uploadSessionToGithub', String(sessionId || ''))),
        onGithubSyncStatus: callback => { githubStatusListeners.add(callback); return () => githubStatusListeners.delete(callback); },
        onAnalysisProgress: callback => { analysisProgressListeners.add(callback); return () => analysisProgressListeners.delete(callback); },
        appendAppEvent: record => Promise.resolve(nativeJson('appendAppEvent', JSON.stringify(record || {}))),
        revealPath: targetPath => Promise.resolve(nativeJson('revealPath', String(targetPath || ''))),
        saveScreenshot: pageTitle => Promise.resolve(nativeJson('saveScreenshot', String(pageTitle || '当前页面'))),
        completeDiagnostic: report => Promise.resolve(nativeJson('completeDiagnostic', JSON.stringify(report || {}))),
        selectBleDevice: id => { if (activeTransport) activeTransport.selectDevice(id); else requireNative('selectBleDevice')(String(id || '')); },
        onBleCandidates: callback => { candidateListeners.add(callback); return () => candidateListeners.delete(callback); },
    });
}(window));
