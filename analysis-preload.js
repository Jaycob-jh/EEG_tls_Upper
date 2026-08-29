'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
    listSessions: () => ipcRenderer.invoke('sessions:list'),
    openAnalysis: sessionId => ipcRenderer.invoke('analysis:open', sessionId),
    requestAnalysisViewport: request => ipcRenderer.invoke('analysis:viewport', request),
    requestAnalysisSpectrogram: request => ipcRenderer.invoke('analysis:spectrogram', request),
    updateAnalysisSegments: (analysisId, segments) => ipcRenderer.invoke('analysis:segments', analysisId, segments),
    exportAnalysisReport: analysisId => ipcRenderer.invoke('analysis:export', analysisId),
    runYasaStaging: sessionId => ipcRenderer.invoke('analysis:yasa', sessionId),
    closeAnalysis: analysisId => ipcRenderer.invoke('analysis:close', analysisId),
    closeAnalysisWindow: () => ipcRenderer.invoke('analysis-window:close'),
    onAnalysisProgress: callback => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('analysis:progress', listener);
        return () => ipcRenderer.removeListener('analysis:progress', listener);
    },
});
