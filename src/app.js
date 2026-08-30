(function () {
    'use strict';

    const SDK = window.BrainLume;
    const Core = window.BrainLumeDesktopCore;
    const Sleep = window.BrainLumeRealtimeSleep;
    const { BleTransport } = window.BrainLumeBle;
    const $ = id => document.getElementById(id);
    const BLE_CONNECT_ATTEMPTS = 6;
    const BLE_CONNECT_RETRY_DELAY_MS = 1000;
    const ACTION_LABELS = Object.freeze({
        impedance_check: '检测阻抗', eeg_start: '启动 EEG', eeg_stop: '停止 EEG',
        light_start: '启动光刺激', light_stop: '停止光刺激', status_query: '查询状态',
    });

    function loadSleepStimulusProtocol() {
        try {
            const stored = JSON.parse(localStorage.getItem('sleepStimulusProtocol') || '{}');
            const protocol = { ...Sleep.normalizeStimulusProtocol(stored), enabled: false };
            if (Sleep.validateStimulusProtocol(protocol).length) throw new Error('invalid stored protocol');
            return protocol;
        } catch {
            return { ...Sleep.DEFAULT_STIMULUS_PROTOCOL, targetStages: [...Sleep.DEFAULT_STIMULUS_PROTOCOL.targetStages] };
        }
    }

    const waveformDisplay = Core.normalizeWaveformDisplay({
        xRangeSeconds: Number(localStorage.getItem('waveformXRangeSeconds')),
        refreshFps: Number(localStorage.getItem('waveformRefreshFps')),
    });

    const state = {
        transport: null,
        client: null,
        processor: null,
        connected: false,
        connecting: false,
        deviceInfo: null,
        selectedChannel: Number(localStorage.getItem('selectedChannel') || 2),
        eegRunning: false,
        indicatorRunning: false,
        indicatorPending: false,
        lightRunning: { 1: false, 2: false },
        lightStateChannelVerified: { 1: false, 2: false },
        lightStateVerified: false,
        lightStateCheckedAt: null,
        lightStatePending: null,
        lightStateError: null,
        plans: [],
        sessions: [],
        activeSession: null,
        sessionStartedAt: 0,
        edfQueue: [],
        edfFlushPromise: Promise.resolve(),
        sessionEventPromise: Promise.resolve(),
        sampleIndex: 0,
        streamStats: Core.createEegStreamStats(),
        streamMetricsTimer: null,
        waveform: [],
        waveformMax: 250 * 60,
        waveformWindowSeconds: waveformDisplay.xRangeSeconds,
        waveformRefreshFps: waveformDisplay.refreshFps,
        lastEeg: null,
        lastUiUpdate: 0,
        activities: [],
        planEditingActions: [],
        planEditingMode: 'clock',
        relativePlanRefreshTimer: null,
        impedanceWaiter: null,
        impedanceMode: false,
        drawDirty: true,
        safeStopPromise: null,
        realtimeEnabled: localStorage.getItem('realtimeSleepEnabled') !== 'false',
        sleepPipeline: null,
        sleepModelFilter: null,
        sleepModelReady: false,
        sleepInferencePromise: Promise.resolve(),
        sleepInferenceGeneration: 0,
        sleepProbabilitySmoothers: { center: null, causal: null },
        sleepHistory: [],
        sleepStimulusProtocol: loadSleepStimulusProtocol(),
        sleepStimulusGate: null,
        sleepStimulusStopTimer: null,
        sleepStimulusActiveChannel: null,
        sleepEpochLightChannels: new Set(),
    };

    const planEngine = new Core.PlanEngine({
        execute: executePlanAction,
        onEvent: handlePlanEngineEvent,
    });

    function toast(message, type = 'info') {
        const node = document.createElement('div');
        node.className = `toast ${type === 'error' ? 'error' : ''}`;
        node.textContent = message;
        $('toast-stack').append(node);
        setTimeout(() => node.remove(), 4200);
    }

    function formatTime(date = new Date()) {
        return date.toLocaleTimeString('zh-CN', { hour12: false });
    }

    function formatDateTime(value) {
        if (!value) return '--';
        return new Date(value).toLocaleString('zh-CN', { hour12: false });
    }

    function recordingSampleRate(session = state.activeSession) {
        const rate = Number(session?.sampleRateHz);
        return rate > 0 ? rate : 250;
    }

    function sessionDurationSeconds(session) {
        const rows = Number(session?.rows);
        if (Number.isFinite(rows) && rows >= 0) return Core.sampleCountToSeconds(rows, recordingSampleRate(session));
        const started = Date.parse(session?.startedAt);
        const ended = Date.parse(session?.endedAt);
        return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? (ended - started) / 1000 : 0;
    }

    function currentRecordingDurationSeconds() {
        if (!state.activeSession) return 0;
        return Core.sampleCountToSeconds(state.sampleIndex, recordingSampleRate());
    }

    function timelineLabel(seconds, live = false) {
        const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        if (!live) return safeSeconds === 0 ? '0 s' : `-${safeSeconds} s`;
        return `T+${Core.formatDuration(safeSeconds)}`;
    }

    function logProtocol(direction, text, level = 'normal') {
        const line = document.createElement('div');
        line.className = 'log-line';
        const directionClass = level === 'error' ? 'err' : direction.toLowerCase();
        line.innerHTML = `<time>${formatTime()}</time><strong class="${directionClass}">${direction}</strong><span></span>`;
        line.lastElementChild.textContent = text;
        const log = $('protocol-log');
        log.append(line);
        while (log.children.length > 500) log.firstElementChild.remove();
        log.scrollTop = log.scrollHeight;
    }

    function addActivity(message, level = 'info') {
        state.activities.unshift({ time: formatTime(), message, level });
        state.activities.length = Math.min(state.activities.length, 12);
        $('activity-list').innerHTML = state.activities.map(item =>
            `<div class="activity-item"><time>${item.time}</time><span>${escapeHtml(item.message)}</span></div>`).join('');
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
        })[character]);
    }

    function protocolErrorContext(error) {
        if (!error?.frame) return {};
        const frame = error.frame;
        return {
            addr: frame.addr, func: frame.func, stat: frame.stat, len: frame.len,
            dataHex: Core.bytesToHex(frame.data),
            request: error.request ? {
                addr: error.request.addr, func: error.request.func, stat: error.request.stat,
                len: error.request.len, dataHex: Core.bytesToHex(error.request.data),
                frameHex: Core.bytesToHex(error.request.frame),
            } : null,
            errorCode: error.code,
        };
    }

    function formatProtocolError(error) {
        const context = protocolErrorContext(error);
        if (!error?.frame) return error?.message || String(error);
        return `${error.message} | Addr=0x${context.addr.toString(16).padStart(2, '0')} Func=0x${context.func.toString(16).padStart(2, '0')} Stat=0x${context.stat.toString(16).padStart(2, '0')} Len=${context.len} Data=${context.dataHex}`;
    }

    function requireClient() {
        if (!state.connected || !state.client) throw new Error('请先连接 BrainLume 设备');
        return state.client;
    }

    async function audit(action, detail = {}, level = 'info') {
        const record = { level, action, ...detail };
        try {
            if (state.activeSession) await window.desktopAPI.appendSessionEvent(state.activeSession.id, record);
            else await window.desktopAPI.appendAppEvent(record);
        } catch (error) {
            logProtocol('ERR', `日志写入失败：${error.message}`, 'error');
        }
    }

    function updateConnectionUi() {
        const online = state.connected;
        $('sidebar-dot').classList.toggle('online', online);
        $('header-status').parentElement.classList.toggle('online', online);
        $('header-status').textContent = state.connecting ? 'CONNECTING' : (online ? 'CONNECTED' : 'DISCONNECTED');
        $('sidebar-connection').textContent = online ? '已连接' : (state.connecting ? '连接中' : '未连接');
        $('sidebar-device').textContent = online ? (state.transport?.name || 'BrainLume') : '等待设备';
        $('connect-button').textContent = online ? '断开设备' : (state.connecting ? '正在连接…' : '连接 BLE');
        $('connect-button').disabled = state.connecting;
        $('metric-device').textContent = online ? (state.transport?.name || 'BrainLume') : '--';
        if (!online) {
            $('metric-battery').textContent = '--%';
            $('metric-battery-update').textContent = '设备未连接';
        }
        updateIndicatorUi();
        renderLightStimulusState();
        renderNextAction();
    }

    function updateIndicatorUi() {
        const button = $('indicator-toggle-button');
        if (!button) return;
        const online = state.connected;
        button.disabled = !online || state.indicatorPending;
        button.className = `button ${state.indicatorRunning ? 'danger' : 'secondary'}`;
        button.innerHTML = `<span class="indicator-dot${state.indicatorRunning ? ' active' : ''}" aria-hidden="true"></span>${state.indicatorPending ? '处理中…' : (state.indicatorRunning ? '关闭指示灯' : '开启指示灯')}`;
        button.setAttribute('aria-pressed', String(state.indicatorRunning));
        button.title = state.indicatorRunning ? '发送功能码 02，关闭设备指示灯' : '发送功能码 02，开启设备指示灯';
    }

    function updateStreamMetricsUi(nowMs = performance.now()) {
        const stats = state.streamStats;
        const frameRate = state.eegRunning ? Core.eegStreamFrameRate(stats, nowMs) : 0;
        const lossRate = Core.eegStreamLossRate(stats);
        $('metric-frame-rate').textContent = `${frameRate.toFixed(1)} FPS`;
        $('metric-gap-events').textContent = stats.gapEvents.toLocaleString();
        $('metric-lost-frames').textContent = stats.lostFrames.toLocaleString();
        $('metric-loss-rate').textContent = `${(lossRate * 100).toFixed(2)}%`;
    }

    function updateEegUi() {
        $('metric-channel').textContent = `CH${state.selectedChannel}`;
        $('metric-eeg').textContent = state.eegRunning ? 'RUNNING' : 'STOPPED';
        $('metric-eeg').style.color = state.eegRunning ? 'var(--green)' : '';
        $('eeg-toggle-button').textContent = state.eegRunning ? '停止 EEG' : '开始 EEG';
        $('eeg-toggle-button').className = `button ${state.eegRunning ? 'danger' : 'success'}`;
        $('channel-select').value = String(state.selectedChannel);
        $('debug-channel').value = String(state.selectedChannel);
        $('wave-x-range').value = String(state.waveformWindowSeconds);
        $('wave-refresh-rate').value = String(state.waveformRefreshFps);
        $('wave-title').innerHTML = `CH${state.selectedChannel} 预处理实时波形 <small class="wave-sync-note">显示 0.5–45 Hz + 50 Hz 陷波 · Y 轴自动刻度 · 分期输入训练一致 0.4–18 Hz</small>`;
        const sampleCount = state.activeSession ? state.sampleIndex : 0;
        const sampleRate = recordingSampleRate();
        $('metric-recording').textContent = Core.formatDuration(currentRecordingDurationSeconds());
        $('metric-recording-detail').textContent = `${sampleCount.toLocaleString()} 原始样本 · ${sampleRate} Hz`;
        $('metric-seq').textContent = state.streamStats.lastSeq == null ? 'Seq --' : `Seq ${state.streamStats.lastSeq} · 丢 ${state.streamStats.lostFrames}`;
        updateStreamMetricsUi();
        const windowPoints = waveformWindowPoints();
        const visiblePoints = Math.min(state.waveform.length, windowPoints);
        const elapsedSeconds = currentRecordingDurationSeconds();
        const windowSeconds = Math.min(state.waveformWindowSeconds, Core.sampleCountToSeconds(visiblePoints, 250));
        const liveWindow = state.activeSession && visiblePoints > 0
            ? `${timelineLabel(Math.max(0, elapsedSeconds - windowSeconds), true)} → ${timelineLabel(elapsedSeconds, true)}`
            : `窗口 ${state.waveformWindowSeconds} 秒`;
        $('wave-range').textContent = state.activeSession
            ? `已采集 ${Core.formatDuration(elapsedSeconds)} · ${liveWindow} · ${visiblePoints.toLocaleString()} / ${windowPoints.toLocaleString()} 点`
            : `窗口 ${state.waveformWindowSeconds} 秒 · ${visiblePoints.toLocaleString()} / ${windowPoints.toLocaleString()} 点`;
        if (state.lastEeg) {
            const index = state.selectedChannel - 1;
            $('wave-value').textContent = `${state.lastEeg.filteredMicrovolts[index].toFixed(2)} µV`;
        }
    }

    function waveformWindowPoints() {
        return state.waveformWindowSeconds * 250;
    }

    function renderSleepProbabilities(probabilities = [0, 0, 0, 0, 0]) {
        $('realtime-probabilities').innerHTML = Sleep.STAGES.map((stage, index) => {
            const value = Math.max(0, Math.min(1, Number(probabilities[index] || 0)));
            return `<div class="stage-probability"><span>${stage}</span><div><i style="width:${(value * 100).toFixed(1)}%"></i></div><strong>${(value * 100).toFixed(1)}%</strong></div>`;
        }).join('');
    }

    function resetRealtimeSleep(clearHistory = true) {
        state.sleepInferenceGeneration += 1;
        state.sleepInferencePromise = Promise.resolve();
        state.sleepPipeline?.reset();
        state.sleepModelFilter?.reset();
        state.sleepStimulusGate?.reset();
        Object.values(state.sleepProbabilitySmoothers).forEach(smoother => smoother?.reset());
        state.sleepEpochLightChannels.clear();
        if (clearHistory) state.sleepHistory = [];
        $('realtime-epoch').textContent = '0 epoch';
        $('realtime-progress').textContent = '当前窗口 0%';
        $('realtime-stage').textContent = state.realtimeEnabled ? '等待数据' : '已停用';
        $('realtime-stage-time').textContent = '尚无结果';
        $('realtime-quality').textContent = '--';
        $('realtime-quality-detail').textContent = '等待 30 秒 epoch';
        $('realtime-inference-state').textContent = state.realtimeEnabled ? '等待 EEG' : '实时分析已停用';
        renderSleepProbabilities();
        $('realtime-history').innerHTML = '<tr><td colspan="11">尚无分期结果</td></tr>';
    }

    function renderSleepHistory() {
        $('realtime-history').innerHTML = state.sleepHistory.length ? state.sleepHistory.map(item => `<tr>
            <td>${escapeHtml(item.outputTime)}</td><td>${item.epochIndex + 1}</td><td title="${item.inferenceMode === 'causal' ? '当前因果输出，用于实验性闭环候选' : '训练一致中心输出，用于回顾性验证'}"><span class="state-badge ${item.quality.ok ? '' : 'off'}">${escapeHtml(item.stage)}</span><small class="stage-source">${item.inferenceMode === 'causal' ? '当前候选' : '中心验证'}</small></td>
            <td>${(item.confidence * 100).toFixed(1)}%</td><td>${item.quality.ok ? '通过' : escapeHtml(item.quality.reason)}</td>
            <td>${item.stimulusShadow ? '验证命中（未发光）' : (item.lightChannels?.length ? `CH${item.lightChannels.join('、CH')} 开启` : '关闭')}</td>
            ${item.probabilities.map(value => `<td>${(value * 100).toFixed(1)}%</td>`).join('')}
        </tr>`).join('') : '<tr><td colspan="11">尚无分期结果</td></tr>';
    }

    function sleepStimulusProtocolFromForm(enabled = state.sleepStimulusProtocol.enabled) {
        return Sleep.normalizeStimulusProtocol({
            enabled,
            shadowMode: $('sleep-stimulus-shadow-mode').checked,
            targetStages: [...document.querySelectorAll('input[name="sleep-stimulus-stage"]:checked')].map(input => input.value),
            minConfidence: Number($('sleep-stimulus-confidence').value) / 100,
            minN3DeltaRatio: Number($('sleep-stimulus-delta').value) / 100,
            consecutiveEpochs: Number($('sleep-stimulus-consecutive').value),
            lightChannel: Number($('sleep-stimulus-channel').value),
            frequencyHz: Number($('sleep-stimulus-frequency').value),
            powerPercent: Number($('sleep-stimulus-power').value),
            durationSeconds: Number($('sleep-stimulus-duration').value),
            cooldownMinutes: Number($('sleep-stimulus-cooldown').value),
        });
    }

    function setSleepStimulusStatus(message) {
        $('sleep-stimulus-status').textContent = message;
        $('realtime-closed-loop-state').textContent = message;
    }

    function renderLightStimulusState() {
        const runningChannels = [1, 2].filter(channel => state.lightRunning[channel]);
        const presentation = Sleep.lightStimulusPresentation({
            connected: state.connected,
            verified: state.lightStateVerified,
            runningChannels,
            pending: state.lightStatePending,
            checkedAt: state.lightStateCheckedAt,
            error: state.lightStateError,
        });
        $('realtime-light-state').textContent = presentation.label;
        $('realtime-light-detail').textContent = presentation.detail;
        $('realtime-light-state').closest('.light-state-card').dataset.lightState = presentation.tone;
        $('sleep-stimulus-device-state').textContent = presentation.label;
        $('sleep-stimulus-device-detail').textContent = presentation.detail;
        $('sleep-stimulus-device-state').closest('.light-device-status').dataset.lightState = presentation.tone;
    }

    function renderSleepStimulusProtocol() {
        const protocol = state.sleepStimulusProtocol;
        $('sleep-stimulus-enabled').checked = protocol.enabled;
        for (const input of document.querySelectorAll('input[name="sleep-stimulus-stage"]')) {
            input.checked = protocol.targetStages.includes(input.value);
        }
        $('sleep-stimulus-confidence').value = String(Math.round(protocol.minConfidence * 100));
        $('sleep-stimulus-delta').value = String(Math.round(protocol.minN3DeltaRatio * 100));
        $('sleep-stimulus-consecutive').value = String(protocol.consecutiveEpochs);
        $('sleep-stimulus-channel').value = String(protocol.lightChannel);
        $('sleep-stimulus-frequency').value = String(protocol.frequencyHz);
        $('sleep-stimulus-power').value = String(protocol.powerPercent);
        $('sleep-stimulus-duration').value = String(protocol.durationSeconds);
        $('sleep-stimulus-cooldown').value = String(protocol.cooldownMinutes);
        $('sleep-stimulus-shadow-mode').checked = protocol.shadowMode;
        $('sleep-stimulus-mode').textContent = protocol.shadowMode ? '默认验证模式：仅记录命中，不发光' : '主动模式：允许向设备发送发光命令';
        if (!protocol.enabled) setSleepStimulusStatus('未启用');
    }

    function saveSleepStimulusProtocol(protocol) {
        localStorage.setItem('sleepStimulusProtocol', JSON.stringify({ ...protocol, enabled: false }));
    }

    function applySleepStimulusProtocol(protocol) {
        const errors = Sleep.validateStimulusProtocol(protocol);
        if (errors.length) throw new Error(errors.join('；'));
        state.sleepStimulusProtocol = Sleep.normalizeStimulusProtocol(protocol);
        state.sleepStimulusGate.updateProtocol(state.sleepStimulusProtocol);
        saveSleepStimulusProtocol(state.sleepStimulusProtocol);
        renderSleepStimulusProtocol();
        return state.sleepStimulusProtocol;
    }

    async function disableSleepStimulus(reason, stopActive = true) {
        const wasEnabled = state.sleepStimulusProtocol.enabled;
        const activeChannel = state.sleepStimulusActiveChannel;
        if (state.sleepStimulusStopTimer) clearTimeout(state.sleepStimulusStopTimer);
        state.sleepStimulusStopTimer = null;
        state.sleepStimulusActiveChannel = null;
        state.sleepStimulusProtocol = { ...state.sleepStimulusProtocol, enabled: false };
        state.sleepStimulusGate?.updateProtocol(state.sleepStimulusProtocol);
        if ($('sleep-stimulus-enabled')) $('sleep-stimulus-enabled').checked = false;
        setSleepStimulusStatus(`未启用${reason ? ` · ${reason}` : ''}`);
        if (stopActive && activeChannel && state.connected) {
            await stopLight(activeChannel, { source: 'sleep_stage', reason, quiet: true });
        }
        if (wasEnabled || activeChannel) await audit('sleep_stimulus_disabled', { reason, activeChannel });
    }

    async function executeSleepStimulus(trigger) {
        if (trigger.shadowMode) {
            await audit('sleep_stimulus_shadow_triggered', { ...trigger, deviceCommandSent: false });
            setSleepStimulusStatus(`${trigger.stage} 验证命中 · ${(trigger.confidence * 100).toFixed(1)}% · 未发光`);
            addActivity(`睡眠分期 ${trigger.stage} 验证命中（shadow mode，未发光）`);
            return;
        }
        const channel = trigger.lightChannel;
        const context = { source: 'sleep_stage', actionId: `epoch_${trigger.epochIndex}` };
        try {
            await configureLight(channel, {
                frequencyHz: trigger.frequencyHz,
                durationMs: trigger.durationMs,
                powerPercent: trigger.powerPercent,
            }, context);
            await startLight(channel, context);
        } catch (error) {
            state.sleepStimulusGate.cancelTrigger();
            setSleepStimulusStatus(`触发失败 · ${error.message}`);
            await audit('sleep_stimulus_trigger_failed', { ...trigger, error: error.message }, 'error');
            throw error;
        }

        state.sleepStimulusActiveChannel = channel;
        setSleepStimulusStatus(`${trigger.stage} 已触发 CH${channel} · ${(trigger.confidence * 100).toFixed(1)}% · ${trigger.durationMs / 1000} 秒`);
        addActivity(`睡眠分期 ${trigger.stage} 触发光刺激 CH${channel}`);
        await audit('sleep_stimulus_triggered', { ...trigger, modelDelayEpochs: 0, decisionCadenceSeconds: 30 });
        if (state.sleepStimulusStopTimer) clearTimeout(state.sleepStimulusStopTimer);
        state.sleepStimulusStopTimer = setTimeout(() => {
            state.sleepStimulusStopTimer = null;
            if (state.sleepStimulusActiveChannel !== channel) return;
            state.sleepStimulusActiveChannel = null;
            void runUiTask(async () => {
                if (state.connected) await stopLight(channel, { source: 'sleep_stage', reason: 'duration_elapsed', quiet: true });
                else await audit('sleep_stimulus_stop_unconfirmed', { channel, reason: 'ble_disconnected' }, 'error');
                setSleepStimulusStatus(`冷却中 · ${trigger.cooldownMinutes} 分钟`);
                await audit('sleep_stimulus_completed', { channel, epochIndex: trigger.epochIndex, stage: trigger.stage });
            });
        }, trigger.durationMs);
    }

    async function handleSleepStimulusResult(item) {
        if (!state.sleepStimulusGate || !state.sleepStimulusProtocol.enabled) return;
        if (!state.connected || !state.eegRunning) {
            setSleepStimulusStatus('已启用 · 等待设备连接并启动 EEG');
            return;
        }
        if (item.inferenceMode !== 'causal') {
            setSleepStimulusStatus('已启用 · 中心输出仅作回顾性验证，等待当前因果候选');
            return;
        }
        if (item.controlEligible !== true) {
            const reason = item.controlEligibilityReason === 'insufficient_context'
                ? '尚未收满 21 个 epoch'
                : (item.controlEligibilityReason === 'context_quality' ? '21 个 epoch 中存在质量警告' : '当前因果时序未满足');
            setSleepStimulusStatus(`当前因果候选暂不触发 · ${reason}`);
            await audit('sleep_stimulus_control_blocked', {
                epochIndex: item.epochIndex,
                stage: item.stage,
                inferenceMode: item.inferenceMode,
                modelDelaySeconds: item.modelDelaySeconds,
                controlEligibilityReason: item.controlEligibilityReason,
                reason: 'model_output_not_control_eligible',
            });
            return;
        }
        if (!state.lightStateVerified) {
            setSleepStimulusStatus('已启用 · 等待设备状态回读确认');
            await audit('sleep_stimulus_control_blocked', {
                epochIndex: item.epochIndex,
                stage: item.stage,
                inferenceMode: item.inferenceMode,
                reason: 'device_state_not_verified',
            });
            return;
        }
        if (planEngine.getRelativeStatus()) {
            setSleepStimulusStatus('已启用 · 相对时间方案运行中，暂停触发');
            return;
        }
        if (state.lightRunning[1] || state.lightRunning[2]) {
            setSleepStimulusStatus('已启用 · 已有光刺激运行，暂停触发');
            return;
        }
        const decision = state.sleepStimulusGate.evaluate({
            epochIndex: item.epochIndex,
            stage: item.stage,
            confidence: item.confidence,
            quality: item.quality,
        });
        if (decision.triggered) {
            item.stimulusShadow = state.sleepStimulusProtocol.shadowMode;
            renderSleepHistory();
            await executeSleepStimulus(decision);
            return;
        }
        const statusLabels = {
            n3_delta_missing: 'N3 慢波证据缺失，连续计数已清零',
            n3_delta_weak: 'N3 慢波证据不足，连续计数已清零',
            poor_quality: '质量未通过，连续计数已清零',
            stage_not_selected: `等待目标分期 · 当前 ${item.stage}`,
            low_confidence: `置信度不足 · ${(item.confidence * 100).toFixed(1)}%`,
            stimulus_active: '刺激进行中',
            cooldown: '冷却中',
            duplicate_epoch: '已忽略重复 epoch',
            context_quality: '上下文质量未通过',
        };
        if (decision.reason === 'awaiting_consecutive') {
            setSleepStimulusStatus(`${decision.stage} 连续命中 ${decision.matchedCount} / ${decision.requiredCount}`);
        } else if (statusLabels[decision.reason]) {
            setSleepStimulusStatus(statusLabels[decision.reason]);
        }
    }

    async function inferSleepEpoch(input, generation = state.sleepInferenceGeneration) {
        if (!state.sleepModelReady) return;
        $('realtime-inference-state').textContent = `正在推理 epoch ${input.classifiedEpochIndex + 1}…`;
        try {
            const result = await window.desktopAPI.inferSleepStage(input);
            if (generation !== state.sleepInferenceGeneration) return;
            const inferenceMode = input.inferenceMode || 'unknown';
            const smoother = state.sleepProbabilitySmoothers[inferenceMode];
            const smoothed = smoother ? smoother.update(result.probabilities) : {
                probabilities: result.probabilities,
                stageIndex: result.stage,
                confidence: Math.max(...result.probabilities),
                margin: null,
                rawProbabilities: result.probabilities,
            };
            const confidence = smoothed.confidence;
            const stage = Sleep.STAGES[smoothed.stageIndex] || `Stage ${smoothed.stageIndex}`;
            const targetQuality = input.targetQuality || input.centerQuality || { ok: false, reason: 'missing_quality' };
            const delaySeconds = Number(input.modelDelaySeconds) || 0;
            const item = {
                outputTime: formatTime(), epochIndex: input.classifiedEpochIndex, stage, confidence,
                probabilities: smoothed.probabilities, rawProbabilities: Array.from(result.probabilities, Number),
                rawStage: Sleep.STAGES[result.stage] || `Stage ${result.stage}`,
                probabilityMargin: smoothed.margin, quality: targetQuality,
                inferenceMode, modelDelaySeconds: delaySeconds,
                controlEligible: input.controlEligible === true,
                controlEligibilityReason: input.controlEligibilityReason,
                lightChannels: Array.from(input.lightChannels || []),
            };
            state.sleepHistory.unshift(item);
            state.sleepHistory.length = Math.min(state.sleepHistory.length, 120);
            $('realtime-stage').textContent = targetQuality.ok ? stage : `${stage}（质量警告）`;
            $('realtime-stage-time').textContent = inferenceMode === 'center'
                ? `目标 epoch ${input.classifiedEpochIndex + 1} · 中心输出 · 约 ${Math.round(delaySeconds / 60)} 分钟延迟`
                : `目标 epoch ${input.classifiedEpochIndex + 1} · 当前因果输出 · 每 30 秒更新`;
            $('realtime-inference-state').textContent = inferenceMode === 'center'
                ? `完成 · 中心输出 ${result.selectedOutputIndex + 1}/${input.temporalContext} · 回顾性验证`
                : `完成 · 当前输出 ${result.selectedOutputIndex + 1}/${input.temporalContext} · 实验性闭环候选`;
            renderSleepProbabilities(smoothed.probabilities);
            renderSleepHistory();
            await audit('sleep_stage_inferred', {
                epochIndex: input.classifiedEpochIndex, stage, confidence,
                probabilities: smoothed.probabilities, rawProbabilities: item.rawProbabilities,
                rawStage: item.rawStage, probabilityMargin: smoothed.margin, quality: targetQuality,
                outputIndex: result.selectedOutputIndex, historyEpochs: input.historyEpochs,
                lightChannels: item.lightChannels, inferenceMode,
                modelDelaySeconds: delaySeconds, controlEligible: item.controlEligible,
                controlEligibilityReason: item.controlEligibilityReason,
            });
            await handleSleepStimulusResult(item);
        } catch (error) {
            if (generation !== state.sleepInferenceGeneration) return;
            $('realtime-model').textContent = '模型错误';
            $('realtime-model-detail').textContent = error.message;
            $('realtime-inference-state').textContent = '推理失败';
            await audit('sleep_stage_inference_failed', { error: error.message }, 'error');
        }
    }

    function handleRealtimeSleepSample(sample, options = {}) {
        if (!state.realtimeEnabled || !state.sleepPipeline || state.impedanceMode) return;
        if (state.lightStateVerified) {
            for (const channel of [1, 2]) {
                if (state.lightRunning[channel]) state.sleepEpochLightChannels.add(channel);
            }
        }
        const epoch = state.sleepPipeline.push(sample, options);
        if (!epoch) {
            if (state.sleepPipeline.current.length % 25 === 0) {
                $('realtime-progress').textContent = `当前窗口 ${(state.sleepPipeline.progress * 100).toFixed(0)}%`;
            }
            return;
        }
        const buffered = Math.min(epoch.totalEpochs, state.sleepPipeline.temporalContext);
        $('realtime-epoch').textContent = `${epoch.totalEpochs} epoch`;
        $('realtime-progress').textContent = `中心窗口 ${buffered} / ${state.sleepPipeline.temporalContext}`;
        $('realtime-quality').textContent = epoch.quality.ok ? '通过' : '警告';
        const gapDetail = epoch.gapSamples ? ` · 序列缺口 ${epoch.gapSamples} 点` : '';
        const deltaDetail = Number.isFinite(epoch.quality.deltaRatio) ? ` · δ ${(epoch.quality.deltaRatio * 100).toFixed(1)}%` : '';
        $('realtime-quality-detail').textContent = `SD ${epoch.quality.stdUv.toFixed(2)} µV · P-P ${epoch.quality.peakToPeakUv.toFixed(1)} µV${deltaDetail}${gapDetail}`;
        if (epoch.gapSamples) {
            state.sleepEpochLightChannels.clear();
            $('realtime-inference-state').textContent = `检测到序列缺口，跳过第 ${epoch.totalEpochs} 个 epoch`;
            return;
        }
        $('realtime-inference-state').textContent = '等待中心验证与当前因果候选';
        // 中心输出对应约 5 分钟前的目标 epoch，当前 epoch 的光刺激状态不能
        // 反写到历史目标 epoch；只有当前因果候选在完整、质量通过的 21 epoch
        // 上才具备实验性闭环资格。
        const lightChannels = Array.from(state.sleepEpochLightChannels);
        state.sleepEpochLightChannels.clear();
        const generation = state.sleepInferenceGeneration;
        const centerInput = state.sleepPipeline.inferenceInput();
        const causalInput = state.sleepPipeline.onlineInferenceInput();
        if (centerInput) {
            centerInput.lightChannels = [];
            state.sleepInferencePromise = state.sleepInferencePromise
                .then(() => inferSleepEpoch(centerInput, generation));
        }
        if (causalInput) {
            causalInput.lightChannels = lightChannels;
            state.sleepInferencePromise = state.sleepInferencePromise
                .then(() => inferSleepEpoch(causalInput, generation));
        }
    }

    async function setupRealtimeSleep() {
        if (!Sleep) throw new Error('实时睡眠分析模块加载失败');
        state.sleepPipeline = new Sleep.RealtimeSleepPipeline({ inputRateHz: 250, modelRateHz: 100, epochSeconds: 30, temporalContext: 21 });
        state.sleepProbabilitySmoothers = {
            center: new Sleep.SleepStageSmoother({ alpha: 0.5 }),
            causal: new Sleep.SleepStageSmoother({ alpha: 0.5 }),
        };
        state.sleepStimulusGate = new Sleep.SleepStageStimulusGate(state.sleepStimulusProtocol);
        renderSleepStimulusProtocol();
        $('realtime-enabled').checked = state.realtimeEnabled;
        $('realtime-enabled').addEventListener('change', event => {
            state.realtimeEnabled = event.target.checked;
            localStorage.setItem('realtimeSleepEnabled', String(state.realtimeEnabled));
            resetRealtimeSleep(true);
            if (!state.realtimeEnabled) void runUiTask(() => disableSleepStimulus('实时分析已停用'));
        });
        $('sleep-stimulus-save').addEventListener('click', () => runUiTask(async () => {
            const protocol = applySleepStimulusProtocol(sleepStimulusProtocolFromForm());
            setSleepStimulusStatus(protocol.enabled ? '参数已保存 · 等待目标分期' : '参数已保存 · 未启用');
            await audit('sleep_stimulus_protocol_saved', { ...protocol, enabled: undefined });
        }));
        $('sleep-stimulus-enabled').addEventListener('change', event => {
            const shouldEnable = event.target.checked;
            event.target.checked = state.sleepStimulusProtocol.enabled;
            void runUiTask(async () => {
                if (!shouldEnable) return disableSleepStimulus('手动关闭');
                if (!state.realtimeEnabled) throw new Error('请先启用实时分析');
                if (!state.sleepModelReady) throw new Error('睡眠分期模型尚未就绪');
                if (!state.connected || !state.eegRunning) throw new Error('请先连接设备并启动 EEG，再启用刺激协议');
                const protocol = applySleepStimulusProtocol(sleepStimulusProtocolFromForm(true));
                setSleepStimulusStatus(`已启用 · 等待 ${protocol.targetStages.join('/')} · 连续 ${protocol.consecutiveEpochs} 次`);
                await audit('sleep_stimulus_enabled', protocol);
            });
        });
        renderSleepProbabilities();
        try {
            const info = await window.desktopAPI.getSleepModelInfo();
            state.sleepModelReady = true;
            $('realtime-model').textContent = '已就绪';
            $('realtime-model-detail').textContent = `Stage-1 ONNX · 中心验证 + 当前因果候选 · 概率平滑`;
        } catch (error) {
            state.sleepModelReady = false;
            $('realtime-model').textContent = '不可用';
            $('realtime-model-detail').textContent = error.message;
        }
        resetRealtimeSleep(true);
    }

    function populateChannelSelects() {
        const options = Array.from({ length: 8 }, (_, index) => `<option value="${index + 1}">CH${index + 1}</option>`).join('');
        for (const id of ['channel-select', 'debug-channel']) $(id).innerHTML = options;
        $('channel-select').value = String(state.selectedChannel);
        $('debug-channel').value = String(state.selectedChannel);
        $('plan-channel').value = 'CH2 · 双极差分（两枚互为参考电极）';
    }

    async function connectBle() {
        if (state.connected) return disconnectBle();
        state.connecting = true;
        updateConnectionUi();
        $('ble-device-list').innerHTML = '<div class="empty-state">正在扫描附近设备…</div>';
        $('ble-dialog').showModal();
        try {
            const transport = new BleTransport({
                reuseGrantedDevice: false,
                connectAttempts: BLE_CONNECT_ATTEMPTS,
                connectRetryDelayMs: BLE_CONNECT_RETRY_DELAY_MS,
            });
            transport.onDisconnect(() => handleTransportDisconnected());
            transport.onStatus(detail => {
                const attempt = `${detail.attempt}/${detail.maxAttempts}`;
                if (detail.phase === 'attempt_started') {
                    $('ble-device-list').innerHTML = `<div class="empty-state">正在建立 BLE 连接（${attempt}）…</div>`;
                    logProtocol('BLE', `连接尝试 ${attempt} · ${detail.stage}`);
                } else if (detail.phase === 'attempt_failed') {
                    $('ble-device-list').innerHTML = `<div class="empty-state">Windows GATT 建链失败，正在自动恢复（${attempt}）…</div>`;
                    logProtocol('BLE', `连接尝试 ${attempt} 失败 · ${detail.stage} · ${detail.error}`, 'error');
                    audit('ble_gatt_attempt_failed', detail, 'error');
                } else if (detail.phase === 'connected') {
                    logProtocol('BLE', `连接成功 · 尝试 ${attempt}`);
                }
            });
            const originalWrite = transport.write.bind(transport);
            transport.write = bytes => {
                logProtocol('TX', Core.bytesToHex(bytes));
                return originalWrite(bytes);
            };
            const processor = new SDK.EegProcessor({
                sampleRateHz: 250,
                historyPoints: state.waveformMax,
                filter: { enabled: true, preset: 'eeg-display-0p5-45' },
                fft: { enabled: true, size: 256, updateEvery: 25, maxHz: 60, log10: true },
                impedance: { preset: 'brainlume-24na-v1' },
            });
            const sleepModelFilter = new SDK.filters.EegFilterBank(250, 8, SDK.filters.MODEL_TRAINING_PRESET, {
                initialization: 'zero',
                implementation: 'direct2t',
            });
            if (!sleepModelFilter.supported) throw new Error('睡眠模型训练滤波器初始化失败');
            const client = new SDK.BrainLumeClient({ transport, address: 0x01, timeoutMs: 2000, eegProcessor: processor });
            client.on('frame', frame => {
                if (frame.func !== SDK.FUNC.EEG_RAW) logProtocol('RX', Core.bytesToHex(frame.raw));
            });
            client.on('eeg', handleEegFrame);
            client.on('error', error => {
                logProtocol('ERR', formatProtocolError(error), 'error');
                audit('protocol_error', { error: error.message, ...protocolErrorContext(error) }, 'error');
            });
            client.on('warning', warning => logProtocol('WARN', warning.message, 'error'));
            await client.connect();
            state.transport = transport;
            state.processor = processor;
            state.sleepModelFilter = sleepModelFilter;
            state.client = client;
            state.connected = true;
            state.connecting = false;
            state.indicatorRunning = false;
            state.indicatorPending = false;
            state.lightRunning = { 1: false, 2: false };
            state.lightStateChannelVerified = { 1: false, 2: false };
            state.lightStateVerified = false;
            state.lightStateCheckedAt = null;
            state.lightStatePending = null;
            state.lightStateError = null;
            if ($('ble-dialog').open) $('ble-dialog').close();
            updateConnectionUi();
            addActivity(`已连接 ${transport.name}`);
            await audit('ble_connected', { deviceName: transport.name, deviceId: transport.id });
            try {
                state.deviceInfo = await client.discover();
                const version = state.deviceInfo.protocolVersion;
                $('metric-protocol').textContent = `ActionBus ${version.major}.${version.minor} · ${state.deviceInfo.actionCount} Actions`;
                addActivity(`能力发现完成：${state.deviceInfo.actionCount} Actions`);
            } catch (error) {
                toast(`BLE 已连接，但能力发现失败：${error.message}`, 'error');
                logProtocol('ERR', `发现失败：${error.message}`, 'error');
            }
            await queryStatus().catch(() => {});
            return true;
        } catch (error) {
            const errorMessage = String(error?.message || error || '未知错误');
            const chooserCancelled = error?.name === 'NotFoundError'
                || /User cancelled the requestDevice\(\) chooser/i.test(errorMessage);
            const gattRecoveryExhausted = error?.code === 'BLE_CONNECT_RETRIES_EXHAUSTED'
                && error?.bleStage === 'gatt_connect';
            state.connecting = false;
            state.connected = false;
            state.sleepModelFilter = null;
            state.lightStateVerified = false;
            state.lightStateChannelVerified = { 1: false, 2: false };
            state.lightStatePending = null;
            state.lightStateError = chooserCancelled ? null : errorMessage;
            if ($('ble-dialog').open) $('ble-dialog').close();
            updateConnectionUi();
            if (chooserCancelled) {
                addActivity('已取消 BLE 设备选择，未建立连接');
                toast('未选择 BLE 设备：请保持设备处于广播状态并点击设备名称；列表为空时请重新扫描。');
                await audit('ble_device_selection_cancelled', { error: errorMessage });
            } else if (gattRecoveryExhausted) {
                addActivity(`设备已发现，但 Windows GATT 建链连续 ${error.attempts || BLE_CONNECT_ATTEMPTS} 次失败`, 'error');
                toast('已扫描到设备，但 Windows GATT 建链失败。请将设备断电 10 秒后重新开启再连接；无需修改 PowerShell。', 'error');
                await audit('ble_connect_failed', {
                    error: errorMessage, errorCode: error.code, stage: error.bleStage,
                    attempts: error.attempts || BLE_CONNECT_ATTEMPTS,
                }, 'error');
            } else {
                toast(`连接失败：${errorMessage}`, 'error');
                await audit('ble_connect_failed', { error: errorMessage }, 'error');
            }
            return false;
        }
    }

    async function disconnectBle() {
        if (!state.client && !state.transport) return;
        await safeStop('manual_disconnect');
        try { await state.client?.disconnect(); } catch (error) { logProtocol('ERR', error.message, 'error'); }
        state.connected = false;
        state.client = null;
        state.transport = null;
        state.processor = null;
        state.sleepModelFilter = null;
        state.indicatorRunning = false;
        state.indicatorPending = false;
        state.lightStateVerified = false;
        state.lightStateChannelVerified = { 1: false, 2: false };
        state.lightStatePending = null;
        state.lightStateError = null;
        updateConnectionUi();
        addActivity('设备已断开');
        await audit('ble_disconnected');
    }

    async function handleTransportDisconnected() {
        if (!state.connected) return;
        planEngine.stopRelative('ble_disconnected');
        state.connected = false;
        state.eegRunning = false;
        state.sleepModelFilter = null;
        state.indicatorRunning = false;
        state.indicatorPending = false;
        state.lightRunning = { 1: false, 2: false };
        state.lightStateChannelVerified = { 1: false, 2: false };
        state.lightStateVerified = false;
        state.lightStateCheckedAt = null;
        state.lightStatePending = null;
        state.lightStateError = 'BLE 已断开，无法确认设备状态';
        await disableSleepStimulus('BLE 已断开', false);
        if (state.activeSession) await finishSession('interrupted', 'ble_disconnected');
        updateConnectionUi();
        updateEegUi();
        toast('BLE 连接已断开，方案已终止', 'error');
        addActivity('BLE 意外断开，无法确认硬件最终状态', 'error');
        await audit('ble_disconnected_unexpectedly', {}, 'error');
    }

    async function queryStatus() {
        const status = await requireClient().getStatus();
        if (!state.impedanceMode) state.eegRunning = Boolean(status.eegRunning);
        state.lightRunning[1] = Boolean(status.light1Running);
        state.lightRunning[2] = Boolean(status.light2Running);
        state.lightStateChannelVerified = { 1: true, 2: true };
        state.lightStateVerified = true;
        state.lightStateCheckedAt = formatTime();
        state.lightStatePending = null;
        state.lightStateError = null;
        renderLightStimulusState();
        updateEegUi();
        renderNextAction();
        $('metric-battery').textContent = `${status.batteryLevel}%`;
        $('metric-battery-update').textContent = `更新 ${formatTime()} · ${status.charging ? '充电中' : '未充电'}`;
        $('metric-battery-update').removeAttribute('title');
        addActivity(`状态：电量 ${status.batteryLevel}% · EEG ${status.eegRunning ? '运行' : '停止'}`);
        await audit('status_received', status);
        return status;
    }

    async function toggleIndicator() {
        const client = requireClient();
        if (state.indicatorPending) return;
        const enable = !state.indicatorRunning;
        state.indicatorPending = true;
        updateIndicatorUi();
        try {
            const response = enable ? await client.startIndicator() : await client.stopIndicator();
            const actualRunning = Boolean(response.stat & SDK.STAT.DEVICE_RUNNING);
            if (actualRunning !== enable) throw new Error(`指示灯状态校验失败：期望 ${enable ? '开启' : '关闭'}，设备返回 ${actualRunning ? '开启' : '关闭'}`);
            state.indicatorRunning = actualRunning;
            await audit(enable ? 'indicator_started' : 'indicator_stopped', {
                func: SDK.FUNC.INDICATOR_CONTROL, stat: response.stat, responseHex: Core.bytesToHex(response.raw),
            });
            addActivity(`设备指示灯已${enable ? '开启' : '关闭'}`);
            return response;
        } finally {
            state.indicatorPending = false;
            updateIndicatorUi();
        }
    }

    function buildEegConfig(channel, impedance) {
        return SDK.ads1299.createRecommendedConfig({ impedance, channels: [channel] });
    }

    async function configureEegVerified(channel, impedance) {
        const client = requireClient();
        const expected = buildEegConfig(channel, impedance);
        const before = await client.readAds1299Registers();
        const beforeMismatches = SDK.ads1299.compareAdsConfig(expected, before.values);
        const matches = beforeMismatches.length === 0;
        if (matches) {
            await audit('eeg_config_already_applied', { channel, impedance, registersHex: Core.bytesToHex(before.values) });
            return { config: expected, readback: before.values, skippedWrite: true };
        }
        const status = await client.getStatus();
        if (status.eegRunning || state.eegRunning) {
            await client.stopEeg();
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        await client.configureEeg(expected);
        await new Promise(resolve => setTimeout(resolve, 2));
        const after = await client.readAds1299Registers();
        const mismatches = SDK.ads1299.compareAdsConfig(expected, after.values);
        if (mismatches.length) {
            const first = mismatches[0];
            throw new Error(`ADS1299 配置回读不一致: 0x${first.address.toString(16).padStart(2, '0')} expected=0x${first.expected.toString(16).padStart(2, '0')} actual=0x${first.actual.toString(16).padStart(2, '0')}`);
        }
        await audit('eeg_config_verified', { channel, impedance, registersHex: Core.bytesToHex(after.values) });
        return { config: expected, readback: after.values, skippedWrite: false };
    }

    async function applyChannel(channel, impedance = false) {
        if (state.eegRunning && !state.impedanceMode) throw new Error('请先停止 EEG 再切换通道');
        const result = await configureEegVerified(channel, impedance);
        const config = result.config;
        state.selectedChannel = channel;
        localStorage.setItem('selectedChannel', String(channel));
        state.processor?.reset();
        state.waveform.length = 0;
        resetRealtimeSleep(true);
        state.drawDirty = true;
        updateEegUi();
        addActivity(`已配置 CH${channel}${impedance ? ' 阻抗模式' : ''}`);
        await audit('eeg_configured', { channel, impedance, registersHex: Core.bytesToHex(config) });
        return config;
    }

    async function startEeg(options = {}) {
        if (state.eegRunning) return;
        const channel = options.channel || state.selectedChannel;
        await applyChannel(channel, false);
        await beginSession(options.plan || null);
        try {
            await requireClient().startEeg();
            state.eegRunning = true;
            state.impedanceMode = false;
            updateEegUi();
            renderNextAction();
            addActivity(`CH${channel} EEG 已启动`);
            await audit('eeg_started', { channel });
        } catch (error) {
            await finishSession('failed', error.message);
            throw error;
        }
    }

    async function stopEeg(reason = 'manual') {
        if (!state.eegRunning && !state.impedanceMode) return;
        try { await disableSleepStimulus('EEG 已停止'); }
        catch (error) {
            logProtocol('ERR', `解除分期刺激协议：${error.message}`, 'error');
            await audit('sleep_stimulus_disable_failed', { reason, error: error.message }, 'error');
        }
        try { await requireClient().stopEeg(); } finally {
            state.eegRunning = false;
            state.impedanceMode = false;
            updateEegUi();
            renderNextAction();
            addActivity('EEG 已停止');
            await audit('eeg_stopped', { reason });
            if (state.activeSession) await finishSession('completed', reason);
        }
    }

    async function measureImpedance(channel = state.selectedChannel) {
        if (state.eegRunning) throw new Error('阻抗检测前必须停止普通 EEG');
        const client = requireClient();
        state.impedanceMode = true;
        renderNextAction();
        $('impedance-button').disabled = true;
        $('metric-impedance-state').textContent = '正在采集 1024 点…';
        try {
            const expectedConfig = await applyChannel(channel, true);
            const registerReadback = await client.readAds1299Registers();
            const mismatches = [];
            mismatches.push(...SDK.ads1299.compareAdsConfig(expectedConfig, registerReadback.values));
            if (mismatches.length) {
                const first = mismatches[0];
                await audit('impedance_config_readback_failed', {
                    channel, expectedHex: Core.bytesToHex(expectedConfig), actualHex: Core.bytesToHex(registerReadback.values), mismatches,
                }, 'error');
                throw new Error(`阻抗配置回读不一致: 0x${first.address.toString(16).padStart(2, '0')} expected=0x${first.expected.toString(16).padStart(2, '0')} actual=0x${first.actual.toString(16).padStart(2, '0')}`);
            }
            await audit('impedance_config_verified', { channel, registersHex: Core.bytesToHex(registerReadback.values) });
            state.processor.reset();
            await client.startEeg();
            const value = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    state.impedanceWaiter = null;
                    reject(new Error('阻抗窗口采集超时'));
                }, 8000);
                state.impedanceWaiter = impedanceValues => {
                    clearTimeout(timer);
                    state.impedanceWaiter = null;
                    resolve(impedanceValues[channel - 1]);
                };
            });
            $('metric-impedance').textContent = `${value.toFixed(2)} kΩ`;
            $('metric-impedance-state').textContent = `CH${channel} · 已校准预设`;
            addActivity(`CH${channel} 阻抗 ${value.toFixed(2)} kΩ`);
            await audit('impedance_measured', { channel, kohm: value });
            return value;
        } finally {
            try { await client.stopEeg(); } catch { /* continue restoration */ }
            state.eegRunning = false;
            state.impedanceMode = false;
            state.processor.reset();
            await applyChannel(channel, false).catch(() => {});
            $('impedance-button').disabled = false;
            updateEegUi();
            renderNextAction();
        }
    }

    const LIGHT_MAX_ATTEMPTS = 3;
    const LIGHT_RETRY_DELAY_MS = 150;

    function delay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    function lightContext(context = {}) {
        return {
            source: context.source || 'manual',
            planId: context.planId || undefined,
            actionId: context.actionId || undefined,
        };
    }

    function lightStatusValue(status, channel) {
        return Boolean(status[channel === 1 ? 'light1Running' : 'light2Running']);
    }

    function retryableLightError(error) {
        if (error?.retryable === true || error?.name === 'TimeoutError') return true;
        if (error?.name === 'DeviceError') return [0x05, 0x06, 0x08, 0x09].includes(Number(error.code));
        return !(error instanceof RangeError || error instanceof TypeError) && state.connected;
    }

    async function runLightOperation(operation, channel, command, options = {}) {
        const context = lightContext(options.context);
        const expectedRunning = options.expectedRunning;
        const verifiesLightState = typeof expectedRunning === 'boolean';
        if (verifiesLightState) {
            state.lightStatePending = { operation, channel };
            state.lightStateError = null;
            renderLightStimulusState();
            renderNextAction();
        }
        let lastError = null;
        for (let attempt = 1; attempt <= LIGHT_MAX_ATTEMPTS; attempt++) {
            const detail = { channel, operation, attempt, maxAttempts: LIGHT_MAX_ATTEMPTS, ...context, ...(options.detail || {}) };
            await audit(`light_${operation}_attempt`, detail);
            try {
                await command();
                let status = null;
                if (typeof expectedRunning === 'boolean') {
                    status = await requireClient().getStatus();
                    const actualRunning = lightStatusValue(status, channel);
                    if (actualRunning !== expectedRunning) {
                        const error = new Error(`光刺激 CH${channel} 状态校验失败：期望 ${expectedRunning ? '运行' : '停止'}，实际 ${actualRunning ? '运行' : '停止'}`);
                        error.name = 'LightStateMismatchError';
                        error.retryable = true;
                        throw error;
                    }
                    state.lightRunning[channel] = actualRunning;
                    state.lightStateChannelVerified[channel] = true;
                    state.lightStateVerified = state.lightStateChannelVerified[1] && state.lightStateChannelVerified[2];
                    state.lightStateCheckedAt = formatTime();
                    state.lightStatePending = null;
                    state.lightStateError = null;
                    renderLightStimulusState();
                    renderNextAction();
                }
                await audit(`light_${operation}_attempt_succeeded`, {
                    ...detail,
                    verifiedRunning: typeof expectedRunning === 'boolean' ? expectedRunning : undefined,
                });
                return status;
            } catch (error) {
                lastError = error;
                const willRetry = attempt < LIGHT_MAX_ATTEMPTS && retryableLightError(error);
                await audit(`light_${operation}_attempt_failed`, {
                    ...detail, error: error.message, errorName: error.name, errorCode: error.code,
                    willRetry, ...protocolErrorContext(error),
                }, 'error');
                if (!willRetry) break;
                await delay(LIGHT_RETRY_DELAY_MS);
            }
        }
        await audit(`light_${operation}_failed`, {
            channel, operation, ...context, error: lastError?.message,
            errorName: lastError?.name, errorCode: lastError?.code, ...protocolErrorContext(lastError),
        }, 'error');
        if (verifiesLightState) {
            state.lightStateChannelVerified[channel] = false;
            state.lightStateVerified = state.lightStateChannelVerified[1] && state.lightStateChannelVerified[2];
            state.lightStatePending = null;
            state.lightStateError = `操作失败，状态未确认：${lastError?.message || '未知错误'}`;
            renderLightStimulusState();
            renderNextAction();
        }
        throw lastError || new Error(`光刺激 CH${channel} ${operation}失败`);
    }

    async function configureLight(channel, config, context = {}) {
        await runLightOperation('configure', channel, () => requireClient().setLightConfig(channel, config), {
            context, detail: { frequencyHz: config.frequencyHz, durationMs: config.durationMs, powerPercent: config.powerPercent },
        });
        await audit('light_configured', { channel, ...config, ...lightContext(context) });
        addActivity(`光刺激 CH${channel}：${config.frequencyHz}Hz / ${config.powerPercent}%`);
    }

    async function startLight(channel, context = {}) {
        await runLightOperation('start', channel, () => requireClient().startLight(channel), {
            context, expectedRunning: true,
        });
        await audit('light_started', { channel, verified: true, ...lightContext(context) });
        addActivity(`光刺激 CH${channel} 已启动`);
    }

    async function stopLight(channel, context = {}) {
        if (!state.connected) {
            const error = new Error(`设备未连接，无法停止光刺激 CH${channel}`);
            await audit('light_stop_failed', { channel, ...lightContext(context), error: error.message }, 'error');
            throw error;
        }
        await runLightOperation('stop', channel, () => requireClient().stopLight(channel), {
            context, expectedRunning: false,
        });
        await audit('light_stopped', { channel, verified: true, ...lightContext(context) });
        if (!context.quiet) addActivity(`光刺激 CH${channel} 已停止`);
    }

    async function performSafeStop(reason = 'manual') {
        planEngine.stopRelative(reason);
        await disableSleepStimulus(reason, false);
        if (!state.connected) {
            for (const channel of [1, 2]) await audit('light_stop_failed', { channel, source: 'safe_stop', reason, error: '设备未连接，无法发送停止命令' }, 'error');
            if (state.activeSession) await finishSession('interrupted', reason);
            await audit('safe_stop_incomplete', { reason, error: '设备未连接，无法确认硬件最终状态' }, 'error');
            return;
        }
        const failures = [];
        for (const channel of [1, 2]) {
            try { await stopLight(channel, { source: 'safe_stop', reason, quiet: true }); }
            catch (error) { failures.push({ channel, error: error.message }); logProtocol('ERR', `停止光刺激 CH${channel}：${error.message}`, 'error'); }
        }
        try { await requireClient().stopEeg(); } catch (error) { logProtocol('ERR', `停止 EEG：${error.message}`, 'error'); }
        state.eegRunning = false;
        state.impedanceMode = false;
        if (state.activeSession) await finishSession('interrupted', reason);
        updateEegUi();
        addActivity('已执行全部安全停止');
        if (failures.length) await audit('safe_stop_incomplete', { reason, failures }, 'error');
        else await audit('safe_stop_completed', { reason });
    }

    function safeStop(reason = 'manual') {
        if (state.safeStopPromise) return state.safeStopPromise;
        state.safeStopPromise = performSafeStop(reason).finally(() => { state.safeStopPromise = null; });
        return state.safeStopPromise;
    }

    async function beginSession(plan) {
        if (state.activeSession) return state.activeSession;
        const id = Core.makeId('session');
        state.sampleIndex = 0;
        state.streamStats = Core.createEegStreamStats();
        state.edfQueue.length = 0;
        state.edfFlushPromise = Promise.resolve();
        state.sessionEventPromise = Promise.resolve();
        state.sessionStartedAt = performance.now();
        state.activeSession = await window.desktopAPI.startSession({
            id,
            planId: plan?.id || '',
            planName: plan?.name || '手动采集',
            planSnapshot: plan || null,
            deviceId: state.deviceInfo?.deviceId ? Core.bytesToHex(state.deviceInfo.deviceId) : (state.transport?.id || ''),
            selectedChannel: state.selectedChannel,
            sampleRateHz: 250,
            appVersion: '0.3.1',
        });
        updateEegUi();
        return state.activeSession;
    }

    function handleEegFrame(result, frame) {
        const channelIndex = state.selectedChannel - 1;
        const previousSeq = Number(state.lastEeg?.seq);
        const currentSeq = Number(result.seq);
        const delta = Number.isInteger(previousSeq) && Number.isInteger(currentSeq)
            ? (currentSeq - previousSeq + 65536) % 65536 : 0;
        const estimatedSeqGap = delta > 0 && delta < 32768 ? delta - 1 : 0;
        state.lastEeg = result;
        let streamFrame = null;
        if (state.activeSession && !state.impedanceMode) {
            streamFrame = Core.trackEegStreamFrame(state.streamStats, result.seq, performance.now());
        }
        const seqGap = streamFrame?.seqGap ?? estimatedSeqGap;
        const rawCode = result.rawCodes[channelIndex];
        const modelFilterCode = state.sleepModelFilter?.supported
            ? state.sleepModelFilter.process(channelIndex, rawCode)
            : result.filteredCodes[channelIndex];
        const modelFilteredMicrovolts = SDK.data.codeToMicrovolts(modelFilterCode, {
            vrefVolts: state.processor?.options?.vrefVolts || 4.5,
            gain: state.processor?.options?.gains?.[channelIndex] || 24,
        });
        state.waveform.push(result.filteredMicrovolts[channelIndex]);
        if (state.eegRunning && !state.impedanceMode) handleRealtimeSleepSample(modelFilteredMicrovolts, { seqGap });
        if (state.waveform.length > state.waveformMax) state.waveform.splice(0, state.waveform.length - state.waveformMax);
        state.drawDirty = true;
        if (state.activeSession && !state.impedanceMode) {
            state.edfQueue.push(result.rawMicrovolts[channelIndex]);
            if (seqGap > 0) {
                const sessionId = state.activeSession.id;
                state.sessionEventPromise = state.sessionEventPromise
                    .then(() => window.desktopAPI.appendSessionEvent(sessionId, {
                        action: 'eeg_seq_gap', seq: result.seq, gapSamples: seqGap,
                    }))
                    .catch(error => logProtocol('ERR', `记录 EEG 序列缺口失败：${error.message}`, 'error'));
            }
            state.sampleIndex++;
            if (state.edfQueue.length >= 512) flushEdfQueue();
        }
        if (result.impedanceKohm && state.impedanceWaiter) state.impedanceWaiter(result.impedanceKohm);
        const now = performance.now();
        if (now - state.lastUiUpdate > 150) {
            state.lastUiUpdate = now;
            updateEegUi();
            $('wave-empty').style.display = 'none';
        }
    }

    function flushEdfQueue() {
        if (!state.activeSession || state.edfQueue.length === 0) return state.edfFlushPromise;
        const sessionId = state.activeSession.id;
        const samples = state.edfQueue.splice(0);
        state.edfFlushPromise = state.edfFlushPromise
            .then(() => window.desktopAPI.appendSessionSamples(sessionId, samples))
            .catch(async error => {
                logProtocol('ERR', `EDF 写入失败：${error.message}`, 'error');
                await safeStop('edf_write_failed');
            });
        return state.edfFlushPromise;
    }

    async function finishSession(status, reason) {
        if (!state.activeSession) return;
        const session = state.activeSession;
        await flushEdfQueue();
        await state.edfFlushPromise;
        await state.sessionEventPromise;
        const result = await window.desktopAPI.stopSession(session.id, status, reason);
        state.activeSession = null;
        updateEegUi();
        await loadSessions();
        if (result) addActivity(`记录已保存：${result.rows} 样本 · EDF`);
    }

    async function executePlanAction(plan, action) {
        if (!state.connected) throw new Error('设备未连接，方案动作未执行');
        const channel = Core.FIXED_PLAN_EEG_CHANNEL;
        if (plan.eegChannel !== channel) throw new Error('方案 EEG 导联必须为 CH2（双极差分）');
        const context = { source: 'plan', planId: plan.id, actionId: action.id };
        switch (action.type) {
        case 'impedance_check': await measureImpedance(channel); break;
        case 'eeg_start': await startEeg({ channel, plan }); break;
        case 'eeg_stop': await stopEeg(`plan:${plan.id}`); break;
        case 'light_start':
            await disableSleepStimulus('时间方案刺激开始');
            await configureLight(action.lightChannel || 1, action.light, context);
            await startLight(action.lightChannel || 1, context);
            break;
        case 'light_stop': await stopLight(action.lightChannel || 1, context); break;
        case 'status_query': await queryStatus(); break;
        default: throw new Error(`未知方案动作：${action.type}`);
        }
    }

    function formatRelativeElapsed(seconds) {
        const total = Math.max(0, Math.floor(seconds));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const rest = total % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    }

    function planActionLabel(plan, action) {
        const label = ACTION_LABELS[action?.type] || action?.type || '方案';
        if (plan?.mode === 'relative') return `${label} · 第 ${(Number(action.offsetSeconds || 0) / 60).toFixed(1)} 分钟`;
        return `${label} · ${action.time}`;
    }

    function handlePlanEngineEvent(event) {
        if (event.phase === 'run-started') {
            addActivity(`相对方案开始：${event.plan.name}`);
            void audit('relative_plan_started', { planId: event.plan.id, startedAt: event.startedAt });
            renderNextAction();
            return;
        }
        if (event.phase === 'run-stopped') {
            addActivity(`相对方案已停止：${event.plan.name}`);
            void audit('relative_plan_stopped', { planId: event.plan.id, reason: event.reason, elapsedSeconds: event.elapsedSeconds });
            renderNextAction();
            return;
        }
        if (event.phase === 'run-completed' || event.phase === 'run-failed') {
            const reason = event.phase === 'run-completed' ? 'relative_plan_completed' : event.reason;
            addActivity(event.phase === 'run-completed' ? `相对方案完成：${event.plan.name}` : `相对方案失败：${event.plan.name}`, event.phase === 'run-failed' ? 'error' : 'info');
            void audit(`relative_plan_${event.phase === 'run-completed' ? 'completed' : 'failed'}`, { planId: event.plan.id, reason, elapsedSeconds: event.elapsedSeconds });
            renderNextAction();
            void runUiTask(() => safeStop(reason));
            return;
        }
        if (event.phase === 'skipped') {
            addActivity(`方案动作已跳过：${planActionLabel(event.plan, event.action)}`, 'error');
            void audit('plan_action_skipped', { planId: event.plan.id, actionId: event.action.id, type: event.action.type, delaySeconds: event.delaySeconds, reason: event.reason }, 'error');
            if (event.plan.mode !== 'relative' && event.reason === 'clock_action_overdue') {
                void runUiTask(() => safeStop('clock_action_overdue'));
            }
            return;
        }
        const message = `${event.plan.name} · ${planActionLabel(event.plan, event.action)}`;
        if (event.phase === 'started') addActivity(`方案开始：${message}`);
        if (event.phase === 'completed') addActivity(`方案完成：${message}`);
        if (event.phase === 'failed') {
            addActivity(`方案失败：${message}`, 'error');
            toast(`${message}：${event.error.message}`, 'error');
            if (event.plan.mode !== 'relative') void runUiTask(() => safeStop('clock_plan_action_failed'));
        }
        renderNextAction();
        audit(`plan_action_${event.phase}`, {
            planId: event.plan.id,
            eventId: event.action.id,
            type: event.action.type,
            plannedTime: event.action.time,
            offsetSeconds: event.action.offsetSeconds,
            delaySeconds: event.delaySeconds,
            error: event.error?.message,
        }, event.phase === 'failed' ? 'error' : 'info');
    }

    async function loadPlans() {
        const loaded = await window.desktopAPI.loadPlans();
        let migrated = false;
        state.plans = (Array.isArray(loaded) ? loaded : []).map(plan => {
            migrated ||= plan.eegChannel !== Core.FIXED_PLAN_EEG_CHANNEL
                || (plan.actions || []).some(action => (action.type === 'light_start' || action.type === 'light_stop')
                    && action.lightChannel !== Core.FIXED_PLAN_LIGHT_CHANNEL);
            return Core.normalizePlan({ ...plan, mode: plan.mode === 'relative' ? 'relative' : 'clock' });
        });
        if (migrated) {
            await window.desktopAPI.savePlans(state.plans);
            await audit('plans_migrated_to_ch2', {
                count: state.plans.length,
                eegChannel: Core.FIXED_PLAN_EEG_CHANNEL,
                lightChannel: Core.FIXED_PLAN_LIGHT_CHANNEL,
            });
        }
        planEngine.setPlans(state.plans);
        renderPlans();
        renderNextAction();
    }

    async function persistPlans() {
        state.plans = state.plans.map(plan => Core.normalizePlan(plan));
        await window.desktopAPI.savePlans(state.plans);
        planEngine.setPlans(state.plans);
        renderPlans();
        renderNextAction();
    }

    function nextDateForTime(time) {
        const [hour, minute, second = 0] = time.split(':').map(Number);
        const date = new Date();
        date.setHours(hour, minute, second, 0);
        if (date <= new Date()) date.setDate(date.getDate() + 1);
        return date;
    }

    function renderNextAction() {
        const selectablePlans = state.plans.filter(plan => plan.enabled);
        const relativeSelect = $('relative-plan-select');
        const previousSelection = relativeSelect.value;
        relativeSelect.innerHTML = selectablePlans.length
            ? selectablePlans.map(plan => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)} · ${plan.mode === 'relative' ? '相对' : '每日/立即'} · CH${plan.eegChannel}</option>`).join('')
            : '<option value="">暂无可用方案</option>';
        const relativeRun = planEngine.getRelativeStatus();
        if (relativeRun) relativeSelect.value = relativeRun.planId;
        else if (selectablePlans.some(plan => plan.id === previousSelection)) relativeSelect.value = previousSelection;
        relativeSelect.disabled = Boolean(relativeRun) || selectablePlans.length === 0;
        $('relative-plan-toggle').disabled = relativeRun ? false : (!state.connected || selectablePlans.length === 0);
        $('relative-plan-toggle').textContent = relativeRun ? '停止方案' : '立即运行';
        $('relative-plan-toggle').className = `button ${relativeRun ? 'danger' : 'success'}`;
        updateHomePlanControls();

        const operation = Core.deviceOperationPresentation({
            connected: state.connected,
            verified: state.lightStateVerified,
            channel: state.selectedChannel,
            impedanceMode: state.impedanceMode,
            eegRunning: state.eegRunning,
            lightRunning: state.lightRunning,
            pending: state.lightStatePending,
        });
        const currentAction = planEngine.getCurrentAction();
        const actionLabel = action => ACTION_LABELS[action?.type] || action?.type || '方案动作';

        if (relativeRun) {
            const next = relativeRun.nextAction;
            if (currentAction || (operation.operation !== 'idle' && operation.operation !== 'unknown')) {
                const active = currentAction ? actionLabel(currentAction.action) : operation.label;
                const detail = currentAction ? `${currentAction.plan.name} · 当前动作` : operation.detail;
                $('next-action').innerHTML = `<span class="time">正在执行 · +${formatRelativeElapsed(relativeRun.elapsedSeconds)}</span><strong>${escapeHtml(active)}</strong><small>${escapeHtml(detail)}${next ? ` · 下一动作：${escapeHtml(actionLabel(next))} · 第 ${(next.offsetSeconds / 60).toFixed(1)} 分钟` : ''}</small>`;
            } else {
                $('next-action').innerHTML = `<span class="time">下一动作 · +${formatRelativeElapsed(relativeRun.elapsedSeconds)}</span><strong>${escapeHtml(next ? actionLabel(next) : '正在结束')}</strong><small>${escapeHtml(relativeRun.plan.name)}${next ? ` · 第 ${(next.offsetSeconds / 60).toFixed(1)} 分钟` : ''} · 当前设备：${escapeHtml(operation.label)}</small>`;
            }
            return;
        }

        const candidates = state.plans.filter(plan => plan.enabled && plan.mode !== 'relative').flatMap(plan =>
            (plan.actions || []).map(action => ({ plan, action, date: nextDateForTime(action.time) })));
        candidates.sort((a, b) => a.date - b.date);
        const next = candidates[0];
        if (currentAction || (operation.operation !== 'idle' && operation.operation !== 'unknown')) {
            const active = currentAction ? actionLabel(currentAction.action) : operation.label;
            const detail = currentAction ? `${currentAction.plan.name} · 当前动作` : operation.detail;
            $('next-action').innerHTML = `<span class="time">正在执行</span><strong>${escapeHtml(active)}</strong><small>${escapeHtml(detail)}${next ? ` · 下一动作：${escapeHtml(actionLabel(next))} · ${escapeHtml(next.action.time.slice(0, 5))}` : ''}</small>`;
        } else {
            $('next-action').innerHTML = next
                ? `<span class="time">下一动作 · ${escapeHtml(next.action.time.slice(0, 5))}</span><strong>${escapeHtml(actionLabel(next.action))}</strong><small>${escapeHtml(next.plan.name)} · CH${next.plan.eegChannel} · 当前设备：${escapeHtml(operation.label)}</small>`
                : '<span class="time">--:--</span><strong>暂无启用方案</strong><small>可在设备首页新建，或进入方案管理</small>';
        }
    }

    function updateHomePlanControls() {
        const editButton = $('edit-plan-button-home');
        const select = $('relative-plan-select');
        if (!editButton || !select) return;
        const selectedPlan = state.plans.find(plan => plan.id === select.value);
        const running = planEngine.getRelativeStatus();
        editButton.disabled = !selectedPlan || Boolean(running);
        editButton.title = selectedPlan ? `编辑 ${selectedPlan.name}` : '请先选择方案';
    }

    function renderPlans() {
        const list = $('plan-list');
        if (!state.plans.length) {
            list.innerHTML = '<div class="empty-state">尚未创建方案。新建一个包含阻抗、EEG 和光刺激动作的时间轴。</div>';
            return;
        }
        list.innerHTML = state.plans.map(plan => {
            const relative = plan.mode === 'relative';
            const actions = [...(plan.actions || [])].sort((a, b) => relative ? Number(a.offsetSeconds) - Number(b.offsetSeconds) : Core.parseTimeOfDay(a.time) - Core.parseTimeOfDay(b.time));
            const next = relative ? `+${((actions[0]?.offsetSeconds || 0) / 60).toFixed(1)} min` : (actions[0]?.time || '--:--').slice(0, 5);
            return `<article class="plan-card" data-plan-id="${escapeHtml(plan.id)}">
                <div><h3>${escapeHtml(plan.name)}</h3><p>CH2 · 双极差分 · ${actions.length} 个动作 · ${relative ? '手动相对' : '每日'}</p></div>
                <div><small>首次动作</small><div class="next-time">${escapeHtml(next)}</div></div>
                <span class="state-badge ${plan.enabled ? '' : 'off'}">${plan.enabled ? '已启用' : '已停用'}</span>
                <div class="plan-actions"><button class="button secondary edit-plan">编辑</button><button class="button secondary toggle-plan">${plan.enabled ? '停用' : '启用'}</button><button class="button text delete-plan">删除</button></div>
            </article>`;
        }).join('');
    }

    function defaultPlanActions(mode = 'clock') {
        if (mode === 'relative') return [
            { id: Core.makeId('action'), offsetSeconds: 0, type: 'impedance_check' },
            { id: Core.makeId('action'), offsetSeconds: 60, type: 'eeg_start' },
            { id: Core.makeId('action'), offsetSeconds: 120, type: 'light_start', lightChannel: Core.FIXED_PLAN_LIGHT_CHANNEL, light: { frequencyHz: 10, durationMs: 0, powerPercent: 5 } },
            { id: Core.makeId('action'), offsetSeconds: 180, type: 'light_stop', lightChannel: Core.FIXED_PLAN_LIGHT_CHANNEL },
            { id: Core.makeId('action'), offsetSeconds: 240, type: 'eeg_stop' },
        ];
        const base = new Date(Date.now() + 5 * 60 * 1000);
        const at = minutes => {
            const value = new Date(base.getTime() + minutes * 60000);
            return value.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        };
        return [
            { id: Core.makeId('action'), time: at(0), type: 'impedance_check' },
            { id: Core.makeId('action'), time: at(1), type: 'eeg_start' },
            { id: Core.makeId('action'), time: at(2), type: 'light_start', lightChannel: Core.FIXED_PLAN_LIGHT_CHANNEL, light: { frequencyHz: 10, durationMs: 0, powerPercent: 5 } },
            { id: Core.makeId('action'), time: at(3), type: 'light_stop', lightChannel: Core.FIXED_PLAN_LIGHT_CHANNEL },
            { id: Core.makeId('action'), time: at(4), type: 'eeg_stop' },
        ];
    }

    function openPlanDialog(plan = null) {
        state.planEditingMode = plan?.mode === 'relative' ? 'relative' : 'clock';
        $('plan-id').value = plan?.id || '';
        $('plan-name').value = plan?.name || '';
        $('plan-channel').value = 'CH2 · 双极差分（两枚互为参考电极）';
        $('plan-enabled').checked = plan?.enabled ?? true;
        $('plan-mode').value = state.planEditingMode;
        $('plan-enabled-label').textContent = state.planEditingMode === 'relative' ? '允许手动启动' : '启用每日计划';
        $('plan-dialog-title').textContent = plan ? '编辑方案' : '新建方案';
        const initialActions = plan?.actions || defaultPlanActions(state.planEditingMode);
        state.planEditingActions = structuredClone(Core.normalizePlan({ actions: initialActions }).actions || []);
        renderActionEditor();
        $('plan-validation').textContent = '';
        $('plan-dialog').showModal();
    }

    function closePlanDialog() {
        if ($('plan-dialog').open) $('plan-dialog').close('cancel');
    }

    function resetPlanDialogState() {
        $('plan-validation').textContent = '';
        state.planEditingActions = [];
        state.planEditingMode = 'clock';
    }

    async function toggleRelativePlan() {
        const running = planEngine.getRelativeStatus();
        if (running) {
            planEngine.stopRelative('manual');
            await safeStop('relative_plan_manual_stop');
            renderNextAction();
            return;
        }
        requireClient();
        const planId = $('relative-plan-select').value;
        if (!planId) throw new Error('请选择一个已启用的方案');
        planEngine.startManual(planId);
        renderNextAction();
    }

    function renderActionEditor() {
        $('action-editor').innerHTML = state.planEditingActions.map((action, index) => {
            const isLight = action.type === 'light_start' || action.type === 'light_stop';
            const extra = action.type === 'light_start'
                ? `<div class="action-extra">
                    <label class="action-parameter"><span>频率 (Hz)</span><input class="action-frequency" type="number" min="1" max="100" value="${action.light?.frequencyHz ?? 10}" aria-label="光刺激频率 Hz"></label>
                    <label class="action-parameter fixed"><span>时间 (ms，固定)</span><input class="action-duration" type="number" value="0" readonly aria-readonly="true" aria-label="光刺激时间固定为 0 ms"></label>
                    <label class="action-parameter"><span>功率/占空比 (%)</span><input class="action-power" type="number" min="0" max="100" value="${action.light?.powerPercent ?? 5}" aria-label="光刺激功率或占空比百分比"></label>
                </div>`
                : '<span></span>';
            const scheduleInput = state.planEditingMode === 'relative'
                ? `<input class="action-offset-minutes" type="number" min="0" step="0.1" value="${Number(action.offsetSeconds || 0) / 60}" title="方案开始后的分钟数">`
                : `<input class="action-time" type="time" step="1" value="${escapeHtml(action.time || '12:00:00')}" title="本机时间">`;
            return `<div class="action-row" data-index="${index}">
                ${scheduleInput}
                <select class="action-type">${Core.ACTION_TYPES.map(type => `<option value="${type}" ${type === action.type ? 'selected' : ''}>${ACTION_LABELS[type]}</option>`).join('')}</select>
                <select class="action-light-channel" disabled aria-readonly="true" aria-label="光刺激通道固定为 CH2" title="方案光刺激通道固定为 CH2"><option value="2" selected>光 CH2（固定）</option></select>
                ${extra}
                <button type="button" class="icon-button remove-action" title="删除动作">×</button>
            </div>`;
        }).join('');
    }

    function syncActionRows() {
        state.planEditingActions = Array.from(document.querySelectorAll('.action-row')).map(row => {
            const type = row.querySelector('.action-type').value;
            const action = {
                id: state.planEditingActions[Number(row.dataset.index)]?.id || Core.makeId('action'),
                type,
            };
            if (state.planEditingMode === 'relative') action.offsetSeconds = Math.round(Number(row.querySelector('.action-offset-minutes').value) * 60);
            else action.time = row.querySelector('.action-time').value.length === 5 ? `${row.querySelector('.action-time').value}:00` : row.querySelector('.action-time').value;
            if (type === 'light_start' || type === 'light_stop') action.lightChannel = Core.FIXED_PLAN_LIGHT_CHANNEL;
            if (type === 'light_start') action.light = {
                frequencyHz: Number(row.querySelector('.action-frequency')?.value),
                durationMs: 0,
                powerPercent: Number(row.querySelector('.action-power')?.value),
            };
            return action;
        });
    }

    async function savePlanFromDialog() {
        syncActionRows();
        const plan = Core.normalizePlan({
            id: $('plan-id').value || Core.makeId('plan'),
            name: $('plan-name').value.trim(),
            enabled: $('plan-enabled').checked,
            mode: state.planEditingMode,
            eegChannel: Core.FIXED_PLAN_EEG_CHANNEL,
            actions: [...state.planEditingActions].sort((a, b) => state.planEditingMode === 'relative' ? a.offsetSeconds - b.offsetSeconds : Core.parseTimeOfDay(a.time) - Core.parseTimeOfDay(b.time)),
            updatedAt: Core.formatLocalIso(),
        });
        const errors = Core.validatePlan(plan);
        if (errors.length) {
            $('plan-validation').textContent = errors.join('；');
            return;
        }
        const index = state.plans.findIndex(item => item.id === plan.id);
        if (index >= 0) state.plans[index] = plan;
        else state.plans.push(plan);
        await persistPlans();
        $('plan-dialog').close();
        toast('方案已保存');
        await audit('plan_saved', { planId: plan.id, name: plan.name });
    }

    async function loadSessions() {
        state.sessions = await window.desktopAPI.listSessions();
        const body = $('record-list');
        if (!state.sessions.length) {
            body.innerHTML = '<tr><td colspan="8"><div class="empty-state">暂无采集记录</div></td></tr>';
            return;
        }
        body.innerHTML = state.sessions.map(session => `<tr>
            <td>${escapeHtml(formatDateTime(session.startedAt))}</td><td>CH${session.selectedChannel}</td><td>${escapeHtml(session.planName || '手动采集')}</td>
            <td>${Number(session.rows || 0).toLocaleString()}</td><td title="${recordingSampleRate(session)} Hz 有效数据">${Core.formatDuration(sessionDurationSeconds(session))}</td><td>${session.storageFormat === 'EDF' ? 'EDF' : 'CSV（旧版）'}</td><td><span class="state-badge ${session.status === 'completed' ? '' : 'off'}">${escapeHtml(session.status)}</span></td>
            <td><button class="button text analyze-session" data-session-id="${escapeHtml(session.id)}">分析</button><button class="button text reveal-session" data-directory="${escapeHtml(session.directory)}">打开目录</button></td>
        </tr>`).join('');
    }

    async function readRegisters() {
        const result = await requireClient().readAds1299Registers();
        $('register-view').textContent = SDK.ads1299.REGISTER_NAMES.map((name, address) =>
            `0x${address.toString(16).padStart(2, '0').toUpperCase()} ${String(name).padEnd(12)} = 0x${result.values[address].toString(16).padStart(2, '0').toUpperCase()}`).join('\n');
        await audit('ads1299_registers_read', { valuesHex: Core.bytesToHex(result.values) });
        return result;
    }

    function setupNavigation() {
        const titles = {
            device: ['DEVICE WORKSPACE', '设备总览'],
            records: ['RAW DATA ARCHIVE', '采集记录'],
            realtime: ['REALTIME SLEEP STAGING', '实时预处理与睡眠分期'],
            debug: ['ENGINEERING TOOLS', '设备调试'],
        };
        document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
            document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === button));
            document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === `page-${button.dataset.page}`));
            [$('page-eyebrow').textContent, $('page-title').textContent] = titles[button.dataset.page];
            if (button.dataset.page === 'records') loadSessions();
        }));
    }

    function setupBleChooser() {
        window.desktopAPI.onBleCandidates(devices => {
            devices = devices.filter(device => device.name.startsWith('BrainLume'));
            if (!$('ble-dialog').open) $('ble-dialog').showModal();
            $('ble-device-list').innerHTML = devices.length ? devices.map(device =>
                `<button type="button" class="device-choice" data-device-id="${escapeHtml(device.id)}"><strong>${escapeHtml(device.name)}</strong><small>${escapeHtml(device.id)}</small></button>`).join('')
                : '<div class="empty-state">正在扫描附近设备…</div>';
        });
        $('ble-device-list').addEventListener('click', event => {
            const button = event.target.closest('.device-choice');
            if (button) window.desktopAPI.selectBleDevice(button.dataset.deviceId);
        });
        $('ble-dialog').addEventListener('close', () => {
            if (!state.connected && state.connecting) window.desktopAPI.selectBleDevice('');
        });
    }

    function setupEvents() {
        $('connect-button').addEventListener('click', () => runUiTask(connectBle));
        $('indicator-toggle-button').addEventListener('click', () => runUiTask(toggleIndicator));
        $('wave-x-range').addEventListener('change', event => {
            const display = Core.normalizeWaveformDisplay({
                xRangeSeconds: Number(event.target.value),
                refreshFps: state.waveformRefreshFps,
            });
            state.waveformWindowSeconds = display.xRangeSeconds;
            localStorage.setItem('waveformXRangeSeconds', String(display.xRangeSeconds));
            state.drawDirty = true;
            updateEegUi();
        });
        $('wave-refresh-rate').addEventListener('change', event => {
            const display = Core.normalizeWaveformDisplay({
                xRangeSeconds: state.waveformWindowSeconds,
                refreshFps: Number(event.target.value),
            });
            state.waveformRefreshFps = display.refreshFps;
            localStorage.setItem('waveformRefreshFps', String(display.refreshFps));
            state.drawDirty = true;
            updateEegUi();
        });
        $('channel-select').addEventListener('change', () => runUiTask(async () => {
            const previousChannel = state.selectedChannel;
            try {
                await applyChannel(Number($('channel-select').value), false);
            } catch (error) {
                $('channel-select').value = String(previousChannel);
                throw error;
            }
        }));
        $('eeg-toggle-button').addEventListener('click', () => runUiTask(() => state.eegRunning ? stopEeg('manual') : startEeg()));
        $('impedance-button').addEventListener('click', () => runUiTask(() => measureImpedance()));
        $('status-button').addEventListener('click', () => runUiTask(queryStatus));
        $('safe-stop-button').addEventListener('click', () => runUiTask(() => safeStop('manual')));
        $('relative-plan-toggle').addEventListener('click', () => runUiTask(toggleRelativePlan));
        $('relative-plan-select').addEventListener('change', updateHomePlanControls);
        $('new-plan-button').addEventListener('click', () => openPlanDialog());
        $('new-plan-button-home').addEventListener('click', () => openPlanDialog());
        $('edit-plan-button-home').addEventListener('click', () => {
            const plan = state.plans.find(item => item.id === $('relative-plan-select').value);
            if (plan) openPlanDialog(plan);
        });
        $('manage-plan-button-home').addEventListener('click', () => {
            const manager = $('home-plan-manager');
            if (!manager) return;
            manager.open = true;
            manager.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        $('plan-dialog-close').addEventListener('click', closePlanDialog);
        $('plan-dialog-cancel').addEventListener('click', closePlanDialog);
        $('plan-dialog').addEventListener('close', resetPlanDialogState);
        $('plan-mode').addEventListener('change', event => {
            syncActionRows();
            state.planEditingMode = event.target.value === 'relative' ? 'relative' : 'clock';
            $('plan-enabled-label').textContent = state.planEditingMode === 'relative' ? '允许手动启动' : '启用每日计划';
            state.planEditingActions = state.planEditingActions.map((action, index) => {
                if (state.planEditingMode === 'relative') return { ...action, offsetSeconds: Number.isInteger(action.offsetSeconds) ? action.offsetSeconds : index * 60 };
                return { ...action, time: action.time || `${String(12 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00` };
            });
            renderActionEditor();
        });
        $('add-action-button').addEventListener('click', () => {
            syncActionRows();
            if (state.planEditingMode === 'relative') {
                const latest = Math.max(-60, ...state.planEditingActions.map(action => Number(action.offsetSeconds) || 0));
                state.planEditingActions.push({ id: Core.makeId('action'), offsetSeconds: latest + 60, type: 'status_query' });
            } else state.planEditingActions.push({ id: Core.makeId('action'), time: '12:00:00', type: 'status_query' });
            renderActionEditor();
        });
        $('save-plan-button').addEventListener('click', () => runUiTask(savePlanFromDialog));
        $('action-editor').addEventListener('change', event => {
            if (event.target.classList.contains('action-type')) {
                syncActionRows();
                renderActionEditor();
            }
        });
        $('action-editor').addEventListener('click', event => {
            const button = event.target.closest('.remove-action');
            if (!button) return;
            syncActionRows();
            state.planEditingActions.splice(Number(button.closest('.action-row').dataset.index), 1);
            renderActionEditor();
        });
        $('plan-list').addEventListener('click', event => runUiTask(async () => {
            const card = event.target.closest('.plan-card');
            if (!card) return;
            const plan = state.plans.find(item => item.id === card.dataset.planId);
            if (planEngine.getRelativeStatus()?.planId === plan.id) throw new Error('运行中的相对方案不能编辑、停用或删除');
            if (event.target.closest('.edit-plan')) openPlanDialog(plan);
            if (event.target.closest('.toggle-plan')) { plan.enabled = !plan.enabled; await persistPlans(); }
            if (event.target.closest('.delete-plan')) {
                const button = event.target.closest('.delete-plan');
                if (button.dataset.confirm !== 'true') {
                    button.dataset.confirm = 'true'; button.textContent = '确认删除';
                    setTimeout(() => { if (button.isConnected) { button.dataset.confirm = ''; button.textContent = '删除'; } }, 3000);
                    return;
                }
                state.plans = state.plans.filter(item => item.id !== plan.id);
                await persistPlans();
            }
        }));
        $('refresh-records-button').addEventListener('click', () => runUiTask(loadSessions));
        $('record-list').addEventListener('click', event => {
            const analyze = event.target.closest('.analyze-session');
            if (analyze) {
                window.desktopAPI.openAnalysisWindow(analyze.dataset.sessionId)
                    .catch(error => toast(error.message, 'error'));
                return;
            }
            const button = event.target.closest('.reveal-session');
            if (button) window.desktopAPI.revealPath(button.dataset.directory);
        });
        $('discover-button').addEventListener('click', () => runUiTask(async () => {
            state.client.address = Number.parseInt($('debug-address').value, 0);
            state.deviceInfo = await requireClient().discover();
            $('register-view').textContent = JSON.stringify(state.deviceInfo, (_key, value) => value instanceof Uint8Array ? Core.bytesToHex(value) : value, 2);
        }));
        $('read-registers-button').addEventListener('click', () => runUiTask(readRegisters));
        $('apply-normal-config-button').addEventListener('click', () => runUiTask(() => applyChannel(Number($('debug-channel').value), false)));
        $('apply-impedance-config-button').addEventListener('click', () => runUiTask(() => applyChannel(Number($('debug-channel').value), true)));
        $('light-config-button').addEventListener('click', () => runUiTask(() => configureLight(Number($('light-channel').value), lightConfigFromInputs())));
        $('light-start-button').addEventListener('click', () => runUiTask(() => startLight(Number($('light-channel').value))));
        $('light-stop-button').addEventListener('click', () => runUiTask(() => stopLight(Number($('light-channel').value))));
        $('clear-log-button').addEventListener('click', () => { $('protocol-log').innerHTML = ''; });
        window.addEventListener('beforeunload', () => {
            planEngine.stopRelative('application_exit');
            planEngine.stop();
            if (state.relativePlanRefreshTimer) clearInterval(state.relativePlanRefreshTimer);
            if (state.streamMetricsTimer) clearInterval(state.streamMetricsTimer);
            if (state.sleepStimulusStopTimer) clearTimeout(state.sleepStimulusStopTimer);
            flushCsvQueue();
        });
    }

    function lightConfigFromInputs() {
        return {
            frequencyHz: Number($('light-frequency').value),
            durationMs: Number($('light-duration').value),
            powerPercent: Number($('light-power').value),
        };
    }

    async function runUiTask(task) {
        try { return await task(); }
        catch (error) {
            toast(error.message, 'error');
            logProtocol('ERR', formatProtocolError(error), 'error');
            await audit('ui_action_failed', { error: error.message, ...protocolErrorContext(error) }, 'error');
            return null;
        }
    }

    function startWaveformLoop() {
        const streams = [
            { canvas: $('eeg-canvas'), values: () => state.waveform.slice(-waveformWindowPoints()), color: '#111111' },
        ];
        let lastDraw = 0;
        function resize(canvas) {
            const ratio = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            const width = Math.max(1, Math.round(rect.width * ratio));
            const height = Math.max(1, Math.round(rect.height * ratio));
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width; canvas.height = height; state.drawDirty = true;
            }
        }
        function drawStream(stream) {
            const { canvas } = stream;
            const context = canvas.getContext('2d');
            resize(canvas);
            const ratio = window.devicePixelRatio || 1;
            const width = canvas.width / ratio;
            const height = canvas.height / ratio;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            context.clearRect(0, 0, width, height);
            context.fillStyle = '#fbfdfe'; context.fillRect(0, 0, width, height);
            const values = stream.values();
            const plotX = 58, plotY = 18, plotW = Math.max(1, width - 74), plotH = Math.max(1, height - 52);
            const plotBottom = plotY + plotH;
            const scale = Core.waveformScale(values);
            const live = Boolean(state.activeSession);
            const visibleSeconds = Math.min(state.waveformWindowSeconds, Core.sampleCountToSeconds(values.length, 250));
            const elapsedSeconds = currentRecordingDurationSeconds();
            const axisStart = live ? Math.max(0, elapsedSeconds - visibleSeconds) : state.waveformWindowSeconds;
            const axisEnd = live ? elapsedSeconds : 0;

            context.strokeStyle = '#e3e9ed'; context.lineWidth = 1;
            const xTickCount = 5;
            for (let index = 0; index <= xTickCount; index++) {
                const x = plotX + plotW * index / xTickCount;
                context.beginPath(); context.moveTo(x, plotY); context.lineTo(x, plotBottom); context.stroke();
            }
            const yTickCount = 4;
            for (let index = 0; index <= yTickCount; index++) {
                const y = plotY + plotH * index / yTickCount;
                context.beginPath(); context.moveTo(plotX, y); context.lineTo(width - 16, y); context.stroke();
            }
            if (values.length < 2 || !Number.isFinite(scale.min) || !Number.isFinite(scale.max)) return;
            const xFor = index => plotX + index * plotW / Math.max(1, values.length - 1);
            const yFor = value => {
                const bounded = Math.max(scale.min, Math.min(scale.max, Number(value)));
                return plotY + (scale.max - bounded) * plotH / (scale.max - scale.min);
            };
            context.strokeStyle = stream.color; context.lineWidth = 1.15; context.lineJoin = 'round'; context.lineCap = 'round';
            const samplesPerPixel = values.length / Math.max(1, plotW);
            if (samplesPerPixel <= 1.25) {
                context.beginPath();
                let started = false;
                values.forEach((value, index) => {
                    if (!Number.isFinite(value)) { started = false; return; }
                    const x = xFor(index), y = yFor(value);
                    if (started) context.lineTo(x, y); else context.moveTo(x, y);
                    started = true;
                });
                context.stroke();
            } else {
                const columns = [];
                for (let pixel = 0; pixel < plotW; pixel++) {
                    const start = Math.floor(pixel * samplesPerPixel);
                    const end = Math.min(values.length, Math.ceil((pixel + 1) * samplesPerPixel));
                    let low = Infinity, high = -Infinity;
                    for (let index = start; index < end; index++) {
                        if (!Number.isFinite(values[index])) continue;
                        low = Math.min(low, values[index]); high = Math.max(high, values[index]);
                    }
                    if (Number.isFinite(low)) columns.push({ x: plotX + pixel, low: yFor(low), high: yFor(high) });
                }
                context.beginPath();
                for (const column of columns) {
                    context.moveTo(column.x, column.high);
                    context.lineTo(column.x, column.low);
                }
                context.stroke();
            }
            context.fillStyle = '#657680'; context.font = '10px Segoe UI'; context.textBaseline = 'alphabetic';
            for (let index = 0; index <= yTickCount; index++) {
                const y = plotY + plotH * index / yTickCount;
                const value = scale.max - (scale.max - scale.min) * index / yTickCount - scale.center;
                const prefix = value > 0 ? '+' : '';
                context.fillText(`${prefix}${value.toFixed(1)} µV`, 5, Math.min(plotBottom, y + 4));
            }
            for (let index = 0; index <= xTickCount; index++) {
                const x = plotX + plotW * index / xTickCount;
                context.textAlign = index === 0 ? 'left' : (index === xTickCount ? 'right' : 'center');
                const seconds = axisStart + (axisEnd - axisStart) * index / xTickCount;
                context.fillText(timelineLabel(seconds, live), x, height - 10);
            }
            context.textAlign = 'left';
            if (scale.clipped) {
                context.fillStyle = '#9a6a12';
                context.fillText('极端瞬态已压缩', Math.max(plotX, width - 112), plotY + 12);
            }
        }
        function draw(timestamp) {
            requestAnimationFrame(draw);
            if (timestamp - lastDraw < 1000 / state.waveformRefreshFps || !state.drawDirty) return;
            lastDraw = timestamp;
            state.drawDirty = false;
            streams.forEach(drawStream);
        }
        const observer = new ResizeObserver(() => { state.drawDirty = true; });
        streams.forEach(stream => observer.observe(stream.canvas));
        requestAnimationFrame(draw);
    }

    async function runDeviceDiagnostic() {
        const report = { startedAt: Core.formatLocalIso(), appVersion: '0.3.1', sdkVersion: SDK.VERSION, success: false };
        try {
            if (!await connectBle()) throw new Error('BLE connection failed');
            report.device = {
                name: state.transport.name, id: state.transport.id,
                protocolVersion: state.deviceInfo?.protocolVersion,
                deviceIdHex: state.deviceInfo?.deviceId ? Core.bytesToHex(state.deviceInfo.deviceId) : null,
                actionCount: state.deviceInfo?.actionCount,
                actions: state.deviceInfo?.actions,
            };
            if (state.deviceInfo?.actionCount !== 9) throw new Error(`Expected 9 actions, got ${state.deviceInfo?.actionCount}`);
            report.statusBefore = await queryStatus();

            const expected = buildEegConfig(2, false);
            const configResult = await configureEegVerified(2, false);
            const readback = { values: configResult.readback };
            const mismatches = SDK.ads1299.compareAdsConfig(expected, readback.values);
            report.eegConfig = {
                expectedHex: Core.bytesToHex(expected),
                readbackHex: Core.bytesToHex(readback.values),
                mismatches,
            };
            if (mismatches.length) throw new Error(`ADS1299 readback mismatch at 0x${mismatches[0].address.toString(16).padStart(2, '0')}`);

            await startEeg({ channel: 2 });
            const sampleStart = state.streamStats.receivedFrames;
            const sampleStartedAt = performance.now();
            await new Promise(resolve => setTimeout(resolve, 3000));
            await stopEeg('device_diagnostic');
            const elapsedSeconds = (performance.now() - sampleStartedAt) / 1000;
            const samples = state.streamStats.receivedFrames - sampleStart;
            report.eegStream = {
                elapsedSeconds, samples, samplesPerSecond: samples / elapsedSeconds,
                seqGaps: state.streamStats.lostFrames, gapEvents: state.streamStats.gapEvents,
                lossRate: Core.eegStreamLossRate(state.streamStats),
            };
            if (samples < 500) throw new Error(`EEG stream too slow: ${samples} samples in ${elapsedSeconds.toFixed(2)}s`);
            report.statusAfter = await queryStatus();
            report.success = true;
        } catch (error) {
            report.error = { name: error.name, message: error.message, ...protocolErrorContext(error) };
        } finally {
            try { await safeStop('device_diagnostic_complete'); } catch (error) {
                report.safeStopError = { name: error.name, message: error.message, ...protocolErrorContext(error) };
            }
            report.finishedAt = Core.formatLocalIso();
            await window.desktopAPI.completeDiagnostic(report);
        }
    }

    async function init() {
        if (!SDK || !Core || !Sleep) throw new Error('BrainLume SDK 或实时分析模块加载失败');
        populateChannelSelects();
        setupNavigation();
        setupBleChooser();
        setupEvents();
        updateConnectionUi();
        updateEegUi();
        await setupRealtimeSleep();
        startWaveformLoop();
        await Promise.all([loadPlans(), loadSessions()]);
        planEngine.start();
        state.relativePlanRefreshTimer = setInterval(() => { if (planEngine.getRelativeStatus()) renderNextAction(); }, 500);
        state.streamMetricsTimer = setInterval(() => {
            updateStreamMetricsUi();
            if (state.activeSession) updateEegUi();
        }, 500);
        await audit('app_started', { version: '0.3.1', sdkVersion: SDK.VERSION });
        if (window.desktopAPI.getLaunchMode() === 'device-diagnostic') {
            $('header-status').textContent = 'PRESS ANY KEY TO DIAGNOSE';
            window.addEventListener('keydown', () => runDeviceDiagnostic(), { once: true });
        }
    }

    init().catch(error => {
        document.body.innerHTML = `<pre style="padding:24px;color:#a00">应用初始化失败\n${escapeHtml(error.stack || error.message)}</pre>`;
    });
}());
