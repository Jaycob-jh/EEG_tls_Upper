'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
    listSessions: () => ipcRenderer.invoke('sessions:list'),
    loadSessionStagingHistory: sessionId => ipcRenderer.invoke('session:staging-history', sessionId),
    openAnalysis: sessionId => ipcRenderer.invoke('analysis:open', sessionId),
    requestAnalysisViewport: request => ipcRenderer.invoke('analysis:viewport', request),
    requestAnalysisSpectrogram: request => ipcRenderer.invoke('analysis:spectrogram', request),
    updateAnalysisSegments: (analysisId, segments) => ipcRenderer.invoke('analysis:segments', analysisId, segments),
    exportAnalysisReport: analysisId => ipcRenderer.invoke('analysis:export', analysisId),
    runYasaStaging: sessionId => ipcRenderer.invoke('analysis:yasa', sessionId),
    runAnySleepComparison: sessionId => ipcRenderer.invoke('analysis:anysleep', sessionId),
    loadN3ResearchReview: () => ipcRenderer.invoke('analysis:n3-research-list'),
    loadN3ResearchContext: rank => ipcRenderer.invoke('analysis:n3-research-context', rank),
    loadN3ManualAnnotations: () => ipcRenderer.invoke('analysis:n3-manual-list'),
    saveN3ManualAnnotation: (rank, label, note) => ipcRenderer.invoke('analysis:n3-manual-save', rank, label, note),
    exportN3ManualAnnotations: () => ipcRenderer.invoke('analysis:n3-manual-export'),
    onAnySleepProgress: callback => { ipcRenderer.on('analysis:anysleep-progress', (_event, text) => callback(text)); },
    closeAnalysis: analysisId => ipcRenderer.invoke('analysis:close', analysisId),
    closeAnalysisWindow: () => ipcRenderer.invoke('analysis-window:close'),
    onAnalysisProgress: callback => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('analysis:progress', listener);
        return () => ipcRenderer.removeListener('analysis:progress', listener);
    },
});
