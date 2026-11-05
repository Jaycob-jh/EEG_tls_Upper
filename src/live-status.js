(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CaoCaoLiveStatus = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function project(s, now = Date.now()) {
        const p = s.protocol || {};
        const stages = ['W', 'N1', 'N2', 'N3', 'REM'];
        const targets = p.targetStages || ['N3'];
        const age = s.lastSampleAt ? Math.max(0, (now - s.lastSampleAt) / 1000) : null;
        const interrupted = s.eegRunning && (age == null ? now - s.startedAt > 3000 : age > 3);
        const q = s.quality;
        const reasons = { raw_saturation: '信号超出范围', amplitude: '幅度异常', flatline: '信号过平', sample_gap: '存在丢帧' };
        const prediction = s.prediction;
        const probabilityTargets = s.manualMode
            ? stages.filter(stage => stage === (prediction?.candidateStage || prediction?.stage)) : targets;
        const predictionAge = prediction?.receivedAt ? Math.max(0, Math.floor((now - prediction.receivedAt) / 1000)) : null;
        const validPrediction = s.connected && s.eegRunning && s.modelReady && !interrupted && predictionAge != null && predictionAge < 65;
        const countdown = seconds => { const n = Math.ceil(Math.max(0, seconds)); return `${Math.floor(n / 60)}分${n % 60}秒`; };
        let signal = !s.connected ? '设备未连接' : !s.eegRunning ? '尚未采集' : interrupted ? '数据中断，请检查连接'
            : age == null ? '等待脑电数据' : !q ? '等待首个 30 秒片段' : q.ok ? '最近一段信号正常' : (reasons[q.reason] || '信号质量异常');
        let stage = !s.eegRunning ? '尚未采集' : !s.modelReady ? '模型尚未准备好'
            : !prediction ? '等待分期结果' : !validPrediction ? '暂无最新有效结果'
            : prediction.quality?.ok !== true ? '无法判断（信号异常）'
            : prediction.stage === 'UNKNOWN' ? `暂不确定 · 可能是 ${prediction.candidateStage || '--'}` : `${prediction.stage}（模型估计）`;
        let light = !s.connected ? '状态未知 · 设备未连接' : s.lightPending ? '正在确认设备光照…' : !s.lightVerified ? '设备光照待确认'
            : s.lightRunning ? (s.manualLight ? '正在手动光照' : '正在光照') : '设备光照已关闭';
        if (s.connected && s.lightRunning && s.lightVerified && s.activeUntil > now) light += ` · 剩余 ${countdown((s.activeUntil - now) / 1000)}`;
        let automation = !p.enabled ? '自动触发未开启' : p.shadowMode ? '试运行 · 不发光'
            : !s.connected ? '等待设备连接' : !s.eegRunning ? '等待开始采集' : s.lightRunning ? '自动光照执行中' : interrupted ? '已暂停判断 · 数据中断'
            : s.lastTriggeredAt != null && now < s.lastTriggeredAt + p.cooldownMinutes * 60000 && !s.lightRunning
                ? `等待下次允许开灯 · 剩余 ${countdown((s.lastTriggeredAt + p.cooldownMinutes * 60000 - now) / 1000)}`
            : q && !q.ok ? '暂不触发 · 信号质量异常'
            : prediction && prediction.stimulusControlEligible !== true && !s.lightRunning ? '等待连续、清晰的脑电数据'
            : `连续满足 ${s.matchedCount || 0} / ${p.consecutiveEpochs} · 等待 ${targets.join(' / ')}`;
        return { connection: s.connected ? '已连接' : s.connecting ? '连接中…' : '未连接',
            acquisition: s.recordingWriteError ? '保存失败，请检查磁盘' : s.eegStopping ? '正在等待设备停止，仍在保存' : s.eegStopError ? '停止未确认，仍在保存' : s.eegRunning ? '正在采集并保存' : '未开始', signal, stage, light, automation,
            probability: validPrediction && probabilityTargets.length ? probabilityTargets.map(target => `${probabilityTargets.length > 1 ? `${target} ` : ''}${(Number(prediction.probabilities?.[stages.indexOf(target)] || 0) * 100).toFixed(1)}%`).join(' · ') : '--',
            probabilityLabel: s.manualMode ? '当前分期概率' : targets.length === 1 ? `${targets[0]} 估计概率` : '目标分期概率',
            freshness: predictionAge == null || !s.eegRunning || !s.connected ? '分期约每 30 秒更新' : `分期更新于 ${predictionAge} 秒前`,
            live: s.connected && s.eegRunning && age != null && !interrupted };
    }
    return { project };
}));
