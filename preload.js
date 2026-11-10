'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
    hasLocalUpdate: () => ipcRenderer.sendSync('local-update:available'),
    checkLocalUpdate: () => ipcRenderer.invoke('local-update:check'),
    restartForLocalUpdate: () => ipcRenderer.invoke('local-update:restart'),
    getLaunchMode: () => ipcRenderer.sendSync('launch:get-mode'),
    getDebugRequest: () => ipcRenderer.sendSync('debug:get-request'),
    sendDebugResult: result => ipcRenderer.invoke('debug:result', result),
    getPaths: () => ipcRenderer.invoke('paths:get'),
    loadPlans: () => ipcRenderer.invoke('plans:load'),
    savePlans: plans => ipcRenderer.invoke('plans:save', plans),
    startSession: metadata => ipcRenderer.invoke('session:start', metadata),
    appendSessionSamples: (id, samples, gapEvents) => ipcRenderer.invoke('session:append-samples', id, samples, gapEvents),
    appendSessionEvent: (id, record) => ipcRenderer.invoke('session:event', id, record),
    stopSession: (id, status, reason) => ipcRenderer.invoke('session:stop', id, status, reason),
    listSessions: () => ipcRenderer.invoke('sessions:list'),
    getHistoryReplayStatus: () => ipcRenderer.invoke('history-replay:status'),
    startHistoryReplay: protocol => ipcRenderer.invoke('history-replay:start', protocol),
    cancelHistoryReplay: () => ipcRenderer.invoke('history-replay:cancel'),
    openHistoryReplayReport: () => ipcRenderer.invoke('history-replay:open'),
    onHistoryReplayProgress: callback => {
        const listener = (_event, status) => callback(status);
        ipcRenderer.on('history-replay:progress', listener);
        return () => ipcRenderer.removeListener('history-replay:progress', listener);
    },
    loadSessionStagingHistory: sessionId => ipcRenderer.invoke('session:staging-history', sessionId),
    openAnalysisWindow: sessionId => ipcRenderer.invoke('analysis-window:open', sessionId),
    closeAnalysisWindow: () => ipcRenderer.invoke('analysis-window:close'),
    openAnalysis: sessionId => ipcRenderer.invoke('analysis:open', sessionId),
    requestAnalysisViewport: request => ipcRenderer.invoke('analysis:viewport', request),
    requestAnalysisSpectrogram: request => ipcRenderer.invoke('analysis:spectrogram', request),
    updateAnalysisSegments: (analysisId, segments) => ipcRenderer.invoke('analysis:segments', analysisId, segments),
    exportAnalysisReport: analysisId => ipcRenderer.invoke('analysis:export', analysisId),
    runYasaStaging: sessionId => ipcRenderer.invoke('analysis:yasa', sessionId),
    closeAnalysis: analysisId => ipcRenderer.invoke('analysis:close', analysisId),
    getSleepModelInfo: () => ipcRenderer.invoke('sleep:model-info'),
    inferSleepStage: payload => ipcRenderer.invoke('sleep:infer', payload),
    getGithubSyncConfig: () => ipcRenderer.invoke('github-sync:get-config'),
    saveGithubSyncConfig: input => ipcRenderer.invoke('github-sync:save-config', input),
    testGithubSync: () => ipcRenderer.invoke('github-sync:test'),
    getGithubHistoryCandidates: () => ipcRenderer.invoke('github-sync:history-candidates'),
    uploadGithubHistory: input => ipcRenderer.invoke('github-sync:upload-history', input),
    retryGithubUploads: () => ipcRenderer.invoke('github-sync:retry'),
    uploadSessionToGithub: sessionId => ipcRenderer.invoke('github-sync:upload-session', sessionId),
    onGithubSyncStatus: callback => {
        const listener = (_event, status) => callback(status);
        ipcRenderer.on('github-sync:status', listener);
        return () => ipcRenderer.removeListener('github-sync:status', listener);
    },
    onAnalysisProgress: callback => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('analysis:progress', listener);
        return () => ipcRenderer.removeListener('analysis:progress', listener);
    },
    appendAppEvent: record => ipcRenderer.invoke('app:event', record),
    revealPath: targetPath => ipcRenderer.invoke('path:reveal', targetPath),
    saveScreenshot: pageTitle => ipcRenderer.invoke('screenshot:save', pageTitle),
    completeDiagnostic: report => ipcRenderer.invoke('diagnostic:complete', report),
    selectBleDevice: id => ipcRenderer.send('ble:select-device', id),
    onBleCandidates: callback => {
        const listener = (_event, devices) => callback(devices);
        ipcRenderer.on('ble:candidates', listener);
        return () => ipcRenderer.removeListener('ble:candidates', listener);
    },
});
