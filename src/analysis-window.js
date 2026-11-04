(function () {
    'use strict';

    const sessionId = new URLSearchParams(window.location.search).get('sessionId') || '';
    const empty = document.getElementById('analysis-empty');

    async function boot() {
        const ui = window.BrainLumeAnalysisUi;
        if (!ui) throw new Error('记录分析页面未能打开');
        ui.init();
        const sessions = await window.desktopAPI.listSessions();
        ui.setSessions(sessions);
        if (sessionId) await ui.openForSession(sessionId);
    }

    boot().catch(error => {
        if (empty) empty.textContent = `分析窗口初始化失败：${error.message}`;
        console.error(error);
    });
}());
