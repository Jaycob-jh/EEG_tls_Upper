'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
    getLaunchMode: () => ipcRenderer.sendSync('launch:get-mode'),
    getDebugRequest: () => ipcRenderer.sendSync('debug:get-request'),
    sendDebugResult: result => ipcRenderer.invoke('debug:result', result),
    getPaths: () => ipcRenderer.invoke('paths:get'),
    loadPlans: () => ipcRenderer.invoke('plans:load'),
    savePlans: plans => ipcRenderer.invoke('plans:save', plans),
    startSession: metadata => ipcRenderer.invoke('session:start', metadata),
    appendSessionSamples: (id, samples) => ipcRenderer.invoke('session:append-samples', id, samples),
    appendSessionEvent: (id, record) => ipcRenderer.invoke('session:event', id, record),
    stopSession: (id, status, reason) => ipcRenderer.invoke('session:stop', id, status, reason),
    listSessions: () => ipcRenderer.invoke('sessions:list'),
    openAnalysis: sessionId => ipcRenderer.invoke('analysis:open', sessionId),
    requestAnalysisViewport: request => ipcRenderer.invoke('analysis:viewport', request),
    requestAnalysisSpectrogram: request => ipcRenderer.invoke('analysis:spectrogram', request),
    updateAnalysisSegments: (analysisId, segments) => ipcRenderer.invoke('analysis:segments', analysisId, segments),
    exportAnalysisReport: analysisId => ipcRenderer.invoke('analysis:export', analysisId),
    runYasaStaging: sessionId => ipcRenderer.invoke('analysis:yasa', sessionId),
    closeAnalysis: analysisId => ipcRenderer.invoke('analysis:close', analysisId),
    getSleepModelInfo: () => ipcRenderer.invoke('sleep:model-info'),
    inferSleepStage: payload => ipcRenderer.invoke('sleep:infer', payload),
    onAnalysisProgress: callback => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('analysis:progress', listener);
        return () => ipcRenderer.removeListener('analysis:progress', listener);
    },
    appendAppEvent: record => ipcRenderer.invoke('app:event', record),
    revealPath: targetPath => ipcRenderer.invoke('path:reveal', targetPath),
    saveScreenshot: () => ipcRenderer.invoke('screenshot:save'),
    completeDiagnostic: report => ipcRenderer.invoke('diagnostic:complete', report),
    selectBleDevice: id => ipcRenderer.send('ble:select-device', id),
    onBleCandidates: callback => {
        const listener = (_event, devices) => callback(devices);
        ipcRenderer.on('ble:candidates', listener);
        return () => ipcRenderer.removeListener('ble:candidates', listener);
    },
});
