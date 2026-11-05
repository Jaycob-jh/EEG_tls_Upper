(function () {
    'use strict';

    const SDK = window.BrainLume;
    const Core = window.BrainLumeDesktopCore;
    const Sleep = window.BrainLumeRealtimeSleep;
    const SleepPostprocess = window.BrainLumeSleepStagePostprocess;
    const { BleTransport } = window.BrainLumeBle;
    const $ = id => document.getElementById(id);
    const BLE_CONNECT_ATTEMPTS = 6;
    const BLE_CONNECT_RETRY_DELAY_MS = 1000;
    const ACTION_LABELS = Object.freeze({
        impedance_check: '检测阻抗', eeg_start: '开始采集', eeg_stop: '停止采集',
        light_start: '启动光照', light_stop: '停止光照', status_query: '查询状态',
    });

    function loadSleepStimulusProtocol() {
        try {
            const stored = JSON.parse(localStorage.getItem('sleepStimulusProtocol') || '{}');
            // Keep both supported N3 trigger bases readable across upgrades,
            // while forcing the live protocol off at startup for safety.
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
        deviceEegRunning: false,
        eegStopError: null,
        eegStopPromise: null,
        statusQueryPromise: null,
        lastDeviceStatus: null,
        lastDeviceStatusTime: null,
        statusDeferredNoticeShown: false,
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
        githubSync: null,
        activeSession: null,
        sessionStartedAt: 0,
        edfQueue: [],
        edfFlushPromise: Promise.resolve(),
        sessionEventPromise: Promise.resolve(),
        sessionFinishPromise: null,
        recordingWriteError: null,
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
        sleepN3Postprocessors: { center: null, causal: null },
        sleepHistory: [],
        sleepStimulusProtocol: loadSleepStimulusProtocol(),
        stimulusControlMode: Core.normalizeStimulusControlMode(localStorage.getItem('stimulusControlMode')),
        preferredLightMode: localStorage.getItem('preferredLightMode') === 'manual' ? 'manual' : 'automatic',
        sleepStimulusGate: null,
        sleepStimulusStopTimer: null,
        sleepStimulusActiveChannel: null,
        sleepEpochLightChannels: new Set(),
        badSignalEpochs: 0,
        lastEegReceivedAt: null,
        liveQuality: null,
        livePrediction: null,
        manualLightChannel: null,
        manualLightUntil: 0,
        manualLightStopTimer: null,
        lightLeasePromise: Promise.resolve(),
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

    function sleepStageLabel(stage) {
        return String(stage) === (SleepPostprocess?.UNKNOWN_STAGE || 'UNKNOWN') ? '无法判断' : String(stage || '--');
    }

    function sleepCandidateStage(item) {
        return String(item?.candidateStage || item?.modelStage || item?.rawStage || item?.stage || 'UNKNOWN');
    }

    function sleepStagePresentation(item) {
        const scoredStage = String(item?.stage || 'UNKNOWN');
        const candidateStage = sleepCandidateStage(item);
        if (scoredStage !== (SleepPostprocess?.UNKNOWN_STAGE || 'UNKNOWN')) return sleepStageLabel(scoredStage);
        if (candidateStage === 'N3') return '可能是 N3';
        if (candidateStage !== (SleepPostprocess?.UNKNOWN_STAGE || 'UNKNOWN')) return sleepStageLabel(candidateStage);
        return sleepStageLabel(scoredStage);
    }

    function sleepStagePresentationDetail(item) {
        const scoredStage = String(item?.stage || 'UNKNOWN');
        const candidateStage = sleepCandidateStage(item);
        const status = item?.quality?.ok === false
            ? '信号异常，不计入' : n3StatusLabel(item?.n3Status);
        if (scoredStage === (SleepPostprocess?.UNKNOWN_STAGE || 'UNKNOWN')) {
            const candidate = candidateStage === (SleepPostprocess?.UNKNOWN_STAGE || 'UNKNOWN')
                ? '' : `模型 ${sleepStageLabel(candidateStage)}${candidateStage === 'N3' && Number.isFinite(Number(item?.candidateConfidence))
                    ? ` · 概率 ${(Number(item.candidateConfidence) * 100).toFixed(1)}%` : ''}`;
            return [status, candidate, '本片段 不计入有效分期'].filter(Boolean).join(' · ');
        }
        return status || '已输出';
    }

    function n3StatusLabel(status) {
        return ({
            trusted: 'N3 通过额外检查', pending: '等待更多 N3 片段', pending_exit: '正在确认 N3 是否结束',
            suppressed: 'N3 未通过额外检查', quality_rejected: '信号异常，不计入',
            inactive: 'N3 未命中', unavailable: '额外检查未能运行',
        })[String(status || '')] || '';
    }

    function signalReasonLabel(reason) {
        return ({ raw_saturation: '信号超出范围', amplitude: '信号波动过大',
            flatline: '信号几乎没有变化', sample_gap: '数据有断档' })[reason] || '信号异常';
    }

    function protocolErrorContext(error) {
        if (error?.raw && !error.frame) return {
            errorName: error.name, receivedCrc: error.expected, calculatedCrc: error.actual,
            rawFrameHex: Core.bytesToHex(error.raw),
        };
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

    function renderLiveStatus() {
        if (!$('live-connection')) return;
        const gate = state.sleepStimulusGate;
        const status = window.CaoCaoLiveStatus.project({
            connected: state.connected, connecting: state.connecting, eegRunning: state.eegRunning,
            eegStopError: state.eegStopError, recordingWriteError: state.recordingWriteError,
            eegStopping: Boolean(state.eegStopPromise),
            modelReady: state.sleepModelReady && !state.liveModelError, lastSampleAt: state.lastEegReceivedAt,
            startedAt: state.liveStartedAt || Date.now(), quality: state.liveQuality, prediction: state.livePrediction,
            protocol: state.sleepStimulusProtocol, matchedCount: gate?.matchedCount,
            lastTriggeredAt: gate?.lastTriggeredAt, activeUntil: state.manualLightChannel ? state.manualLightUntil : gate?.activeUntil,
            manualLight: Boolean(state.manualLightChannel),
            manualMode: selectedLightMode() === 'manual',
            lightVerified: state.lightStateVerified, lightPending: state.lightStatePending,
            lightRunning: Boolean(state.lightRunning[1] || state.lightRunning[2]),
        });
        for (const [id, value] of Object.entries({
            'live-connection': status.connection, 'live-acquisition': status.acquisition,
            'live-signal': status.signal, 'live-stage': status.stage, 'live-n3-probability': status.probability,
            'live-light': status.light, 'live-automation': status.automation, 'live-prediction-age': status.freshness,
            'live-target-probability-label': status.probabilityLabel,
        })) $(id).textContent = value;
        $('live-duration').textContent = Core.formatDuration(currentRecordingDurationSeconds());
        const manualLabel = $('manual-light-live-state');
        if (manualLabel) manualLabel.textContent = state.manualLightChannel
            ? `手动光照中 · ${state.manualLightChannel === 3 ? '两个光源' : `光源${state.manualLightChannel}`} ${state.manualLightUntil ? `· 剩余 ${Math.max(0, Math.ceil((state.manualLightUntil - Date.now()) / 1000))} 秒` : ''}`
            : '未启动手动光照';
        $('live-light-confirmed').textContent = state.connected && state.lightStateCheckedAt ? `最近设备确认：${state.lightStateCheckedAt}` : '等待设备回报';
        $('live-status-badge').textContent = status.live ? '● 数据接收中' : '● 等待数据';
        $('live-status-badge').dataset.live = String(status.live);
        if (state.probabilityDisplayAvailable && status.probability === '--') renderSleepProbabilities();
    }

    function renderSimpleWorkflow() {
        renderLiveStatus();
        if (!$('simple-device-status')) return;
        const p = state.sleepStimulusProtocol;
        const armed = p.enabled && modelStimulusSourceAvailable();
        const targets = p.targetStages.join(' / ') || '未选择目标';
        const manual = Boolean(state.manualLightChannel);
        const emitting = Boolean(state.lightRunning[1] || state.lightRunning[2]);
        const manualView = selectedLightMode() === 'manual';
        $('simple-light-title').textContent = manualView ? '手动光照' : '分期自动光照';
        $('simple-device-status').textContent = state.connected ? '已连接' : (state.connecting ? '连接中…' : '未连接');
        $('simple-eeg-status').textContent = state.eegStopPromise ? '正在停止…' : state.eegStopError ? '停止未确认' : state.recordingWriteError ? '保存失败' : state.eegRunning ? '正在采集' : '未开始';
        $('simple-n3-status').textContent = manual ? '手动光照中' : emitting ? '正在光照' : !armed ? '自动光照未开启' : p.shadowMode ? '试运行 · 不发光' : `已开启 · 等待 ${targets}`;
        const lightDuration = p.durationSeconds < 60 ? `${p.durationSeconds} 秒`
            : `${Math.floor(p.durationSeconds / 60)} 分${p.durationSeconds % 60 ? ` ${p.durationSeconds % 60} 秒` : '钟'}`;
        $('simple-n3-parameters').textContent = `目标 ${targets} · ${p.lightChannel === 3 ? '两个光源' : `光源${p.lightChannel}`} · ${p.frequencyHz} Hz · ${p.powerPercent}% · 每次 ${lightDuration}`;
        if (manual) $('simple-n3-parameters').textContent = `${state.manualLightChannel === 3 ? '两个光源' : `光源${state.manualLightChannel}`} · ${state.manualLightUntil ? `剩余 ${Math.max(0, Math.ceil((state.manualLightUntil - Date.now()) / 1000))} 秒 · ` : ''}自动触发未开启`;
        else if (emitting) $('simple-n3-parameters').textContent = state.sleepStimulusActiveChannel ? '分期触发光照中' : '设备正在光照，可在实时状态查看详情';
        if (manualView && !manual && !emitting) {
            $('simple-n3-status').textContent = '尚未启动';
            $('simple-n3-parameters').textContent = `${Number($('home-light-channel').value) === 3 ? '两个光源' : `光源${$('home-light-channel').value}`} · ${$('home-light-frequency').value} Hz · ${$('home-light-power').value}% · ${$('home-light-duration').value} 秒`;
        }
        for (const [id, active] of [['simple-device-status',state.connected],['simple-eeg-status',state.eegRunning],['simple-n3-status',armed || manual || emitting]]) $(id).setAttribute?.('data-active',String(Boolean(active)));
        const button = $('simple-n3-toggle');
        button.textContent = armed ? '关闭自动光照' : '开启自动光照';
        button.className = `button ${armed ? 'danger' : 'primary'}`;
        button.disabled = !armed && (!state.connected || !state.eegRunning || !state.sleepModelReady || emitting || Boolean(state.manualLightChannel) || Boolean(state.eegStopPromise) || Boolean(state.eegStopError));
        if (manualView) {
            button.textContent = manual ? '停止手动光照' : '开始手动光照';
            button.className = `button ${manual ? 'danger' : 'primary'}`;
            button.disabled = !state.connected || Boolean(state.lightStatePending) || (emitting && !manual);
        }
        $('simple-n3-settings').textContent = manualView ? '修改光照参数' : '选择分期 / 参数';
        $('simple-manual-light').textContent = manualView ? '切换自动光照' : '切换手动光照';
        $('simple-session-hint').textContent = !state.connected ? '先点击第 1 步「连接设备」。'
            : manual ? '手动光照正在运行，到时自动关闭。'
            : manualView ? '手动光照按设定时长运行，无需等待分期。'
            : !state.eegRunning ? '设备已连接，点击第 2 步「开始采集」。'
            : !armed ? '正在采集并保存。需要自动光照时，再开启第 3 步。'
            : p.shadowMode ? '试运行中，只记录，不开灯。'
            : `目标 ${targets}；同一分期连续满足 ${p.consecutiveEpochs} 次（约 ${p.consecutiveEpochs / 2} 分钟），并满足阈值、质量与间隔条件后才发光。`;
    }

    function selectedLightMode() {
        if (state.manualLightChannel) return 'manual';
        if (state.sleepStimulusProtocol.enabled || state.sleepStimulusActiveChannel) return 'automatic';
        return state.preferredLightMode === 'manual' ? 'manual' : 'automatic';
    }

    function preferLightMode(mode) {
        state.preferredLightMode = mode;
        localStorage.setItem('preferredLightMode', mode);
        renderSimpleWorkflow();
    }

    async function toggleSimpleN3() {
        if (state.sleepStimulusProtocol.enabled) return disableSleepStimulus('手动关闭');
        if (!state.connected || !state.eegRunning) throw new Error('请先连接设备并开始采集');
        if (!state.sleepModelReady) throw new Error('睡眠模型尚未就绪');
        if (!state.realtimeEnabled) {
            state.realtimeEnabled = true;
            localStorage.setItem('realtimeSleepEnabled', 'true');
            $('realtime-enabled').checked = true;
            resetRealtimeSleep(true);
        }
        if (state.lightRunning[1] || state.lightRunning[2] || planEngine.getRelativeStatus()) throw new Error('请先停止正在运行的手动光照或方案');
        const previousMode = state.stimulusControlMode;
        preferLightMode('automatic');
        state.stimulusControlMode = 'model';
        localStorage.setItem('stimulusControlMode', 'model');
        renderStimulusSources();
        const protocol = applySleepStimulusProtocol({ ...state.sleepStimulusProtocol, enabled: true });
        setSleepStimulusStatus(`已启用 · 等待 ${protocol.targetStages.join(' / ')}`);
        await audit('stimulus_control_mode_changed', { mode: 'model', previousMode });
        await audit('sleep_stimulus_enabled', protocol);
    }

    function updateConnectionUi() {
        renderSimpleWorkflow();
        const online = state.connected;
        $('sidebar-dot').classList.toggle('online', online);
        $('header-status').parentElement.classList.toggle('online', online);
        $('header-status').textContent = state.connecting ? '连接中' : (online ? '已连接' : '未连接');
        $('sidebar-connection').textContent = online ? '已连接' : (state.connecting ? '连接中' : '未连接');
        $('sidebar-device').textContent = online ? (state.transport?.name || 'BrainLume') : '等待设备';
        $('connect-button').textContent = online ? '断开设备' : (state.connecting ? '正在连接…' : '连接设备');
        $('connect-button').disabled = state.connecting;
        $('metric-device').textContent = online ? (state.transport?.name || 'BrainLume') : '--';
        if (!online) {
            $('metric-battery').textContent = '--%';
            $('metric-battery-update').textContent = '设备未连接';
        }
        updateIndicatorUi();
        renderLightStimulusState();
        renderStimulusSources();
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

    function setElementVisibility(id, visible) {
        const element = $(id);
        if (!element) return;
        element.hidden = !visible;
        element.setAttribute('aria-hidden', String(!visible));
    }

    // The dropdown selects which output sources are allowed. Settings are
    // opened in a mode-specific dialog; the light-command lease still
    // arbitrates so only one source can occupy the hardware at a time.
    function manualStimulusSourceAvailable() {
        // Manual output has its own explicit action; it is no longer hidden by
        // the retired manual/model mode dropdown. The light lease prevents overlap.
        return true;
    }

    function modelStimulusSourceAvailable() {
        return Core.stimulusControlModeAllows(state.stimulusControlMode, 'model');
    }

    function sleepStimulusTriggerSummary(protocol = {}) {
        const targets = [...new Set(protocol.targetStages || [])];
        const hasN3 = targets.includes('N3');
        const otherTargets = targets.filter(stage => stage !== 'N3');
        const parts = [];
        if (hasN3) {
            parts.push(protocol.n3TriggerMode === 'confirmed'
                ? `N3 额外检查后概率 ≥ ${Math.round(protocol.minN3Confidence * 100)}%`
                : `N3 概率 ≥ ${Math.round(protocol.minN3Probability * 100)}%`);
        }
        if (otherTargets.length) parts.push(`${otherTargets.join('、')} 概率 ≥ ${Math.round(protocol.minConfidence * 100)}%`);
        const targetLabel = targets.length ? targets.join('/') : '未选择目标';
        return `目标 ${targetLabel} · ${parts.join(' · ') || '请先选择触发条件'} · 连续 ${protocol.consecutiveEpochs || 0} 段`;
    }

    function renderStimulusModeCard() {
        const mode = Core.normalizeStimulusControlMode(state.stimulusControlMode);
        const protocol = state.sleepStimulusProtocol;
        const modelAllowed = modelStimulusSourceAvailable();
        const manualAllowed = manualStimulusSourceAvailable();
        const labels = Core.STIMULUS_CONTROL_MODE_LABELS;
        const modelStatus = !modelAllowed
            ? '模型触发未启用'
            : (protocol.enabled ? (protocol.shadowMode ? '模型验证中' : '模型主动触发') : '模型未启用');
        const modeCopy = {
            manual: {
                title: labels.manual,
                description: '手动按钮和已保存方案可用；模型触发关闭。',
                summary: '打开弹窗设置手动参数或运行方案。',
                button: '设置手动 / 方案',
                status: '手动 / 方案可用',
            },
            model: {
                title: labels.model,
                description: '只允许实时分期模型候选进入实时触发。',
                summary: sleepStimulusTriggerSummary(protocol),
                button: '设置模型触发',
                status: modelStatus,
            },
            both: {
                title: labels.both,
                description: '手动 / 方案和模型都可用；同一时刻只允许一路输出。',
                summary: `模型：${modelStatus} · 手动 / 方案可用`,
                button: '设置两种方式',
                status: '两种方式可用',
            },
        }[mode];
        const title = $('stimulus-mode-title');
        const description = $('stimulus-mode-description');
        const summary = $('stimulus-mode-summary');
        const live = $('stimulus-mode-live');
        const status = $('stimulus-mode-status');
        const button = $('stimulus-open-settings');
        const select = $('stimulus-control-mode');
        if (select) select.value = mode;
        if (title) title.textContent = modeCopy.title;
        if (description) description.textContent = modeCopy.description;
        if (summary) summary.textContent = modeCopy.summary;
        if (live) live.textContent = mode === 'model'
            ? (protocol.enabled
                ? (protocol.shadowMode ? '试运行 · 只记录命中，不发光' : '主动模式 · 满足检查后才允许发光')
                : '协议未启用 · 默认试运行，不发光')
            : (mode === 'both' ? '模型和手动 / 方案分别配置' : '模型触发关闭');
        if (status) {
            status.className = `state-badge ${mode === 'model' && !protocol.enabled ? 'off' : ''}`;
            status.textContent = modeCopy.status;
        }
        if (button) button.textContent = modeCopy.button;
        const card = $('stimulus-mode-card');
        if (card) card.dataset.mode = mode;
        const dialogMode = $('sleep-stimulus-dialog-mode');
        if (dialogMode) {
            dialogMode.textContent = protocol.enabled ? '自动光照已开启；保存后用于后续触发。' : '保存参数后，在首页开启自动光照。';
        }
        const combinedModelSummary = $('combined-model-summary');
        if (combinedModelSummary) combinedModelSummary.textContent = `${modelStatus} · ${sleepStimulusTriggerSummary(protocol)}`;
        const combinedManualSummary = $('combined-manual-summary');
        if (combinedManualSummary) combinedManualSummary.textContent = manualAllowed
            ? '手动按钮和已保存方案可用，参数在手动 / 方案设置中管理。'
            : '当前控制方式未开放手动 / 方案。';
    }

    function openSleepStimulusSettings() {
        const dialog = $('sleep-stimulus-settings-dialog');
        if (!dialog) return;
        preferLightMode('automatic');
        $('combined-stimulus-settings-dialog')?.close();
        $('manual-stimulus-settings-dialog')?.close();
        renderStimulusSources();
        renderSleepStimulusProtocol();
        const feedback = $('sleep-settings-feedback');
        feedback.dataset.error = 'false';
        feedback.textContent = state.sleepStimulusProtocol.enabled ? '保存后用于后续触发，不会立即开灯。' : '保存后回首页开启，不会立即开灯。';
        if (!dialog.open) dialog.showModal();
        requestAnimationFrame(() => $('sleep-stimulus-n3-enabled')?.focus({ preventScroll: true }));
    }

    function openManualStimulusSettings() {
        const dialog = $('manual-stimulus-settings-dialog');
        if (!dialog) return;
        preferLightMode('manual');
        $('combined-stimulus-settings-dialog')?.close();
        $('sleep-stimulus-settings-dialog')?.close();
        renderStimulusSources();
        if (!dialog.open) dialog.showModal();
        requestAnimationFrame(() => $('home-light-frequency')?.focus({ preventScroll: true }));
    }

    function openCombinedStimulusSettings() {
        const dialog = $('combined-stimulus-settings-dialog');
        if (!dialog) return;
        renderStimulusSources();
        if (!dialog.open) dialog.showModal();
    }

    function openStimulusSettingsForMode(mode = state.stimulusControlMode) {
        const normalizedMode = Core.normalizeStimulusControlMode(mode);
        if (normalizedMode === 'model') return openSleepStimulusSettings();
        if (normalizedMode === 'both') return openCombinedStimulusSettings();
        return openManualStimulusSettings();
    }

    function openHomePlanManager() {
        const manager = $('plan-manager-dialog');
        if (!manager) return;
        $('manual-stimulus-settings-dialog')?.close();
        $('combined-stimulus-settings-dialog')?.close();
        renderPlans();
        if (!manager.open) manager.showModal();
    }

    async function changeStimulusControlMode(value) {
        const previousMode = state.stimulusControlMode;
        const mode = Core.normalizeStimulusControlMode(value);
        if (mode === previousMode) {
            openStimulusSettingsForMode(mode);
            return;
        }
        const removesManual = !Core.stimulusControlModeAllows(mode, 'manual');
        const removesModel = !Core.stimulusControlModeAllows(mode, 'model');
        try {
            if (removesManual && (state.lightRunning[1] || state.lightRunning[2]) && !state.sleepStimulusActiveChannel) {
                throw new Error('当前有手动或方案光照正在运行，请先停止后再切换控制方式');
            }
            state.stimulusControlMode = mode;
            localStorage.setItem('stimulusControlMode', mode);
            renderStimulusSources();
            // Open synchronously from the select change so macOS keeps the
            // user gesture associated with the requested mode-specific dialog.
            openStimulusSettingsForMode(mode);
            if (removesModel && (state.sleepStimulusProtocol.enabled || state.sleepStimulusActiveChannel)) {
                await disableSleepStimulus(`切换至${Core.STIMULUS_CONTROL_MODE_LABELS[mode]}`);
            }
            await audit('stimulus_control_mode_changed', { mode, previousMode });
        } catch (error) {
            state.stimulusControlMode = previousMode;
            localStorage.setItem('stimulusControlMode', previousMode);
            ['manual-stimulus-settings-dialog', 'combined-stimulus-settings-dialog', 'sleep-stimulus-settings-dialog']
                .forEach(id => $(id)?.close());
            renderStimulusSources();
            throw error;
        }
    }

    function renderStimulusSources() {
        const manualAllowed = manualStimulusSourceAvailable();
        const modelAllowed = modelStimulusSourceAvailable();
        const connected = state.connected;
        const manualInputFields = ['home-light-frequency', 'home-light-duration', 'home-light-power'];
        manualInputFields.forEach(id => {
            const element = $(id);
            if (element) element.disabled = !manualAllowed;
        });
        const manualStartButton = $('home-light-start');
        if (manualStartButton) manualStartButton.disabled = !manualAllowed || !connected;
        if (manualStartButton && state.manualLightChannel) manualStartButton.disabled = true;
        if (state.manualLightChannel) manualInputFields.forEach(id => { $(id).disabled = true; });
        if ($('home-light-channel')) $('home-light-channel').disabled = Boolean(state.manualLightChannel);
        const stopButton = $('home-light-stop');
        if (stopButton) stopButton.disabled = !connected;
        setElementVisibility('sleep-stimulus-config', modelAllowed);
        const modelEnableLabel = $('sleep-stimulus-enabled')?.closest('.realtime-enable');
        if (modelEnableLabel) modelEnableLabel.hidden = true;
        const modelEnableToggle = $('sleep-stimulus-enabled');
        if (modelEnableToggle) modelEnableToggle.disabled = true;
        const settingsDialog = $('sleep-stimulus-settings-dialog');
        if (!modelAllowed && settingsDialog?.open) settingsDialog.close();
        const manualSettingsDialog = $('manual-stimulus-settings-dialog');
        if (!manualAllowed && manualSettingsDialog?.open) manualSettingsDialog.close();
        const detail = $('stimulus-control-detail');
        if (detail) detail.textContent = `${Core.STIMULUS_CONTROL_MODE_LABELS[state.stimulusControlMode]}；${Core.stimulusControlModePresentation(state.stimulusControlMode).detail} 同一时刻只允许一个光照源输出。`;
        renderStimulusModeCard();
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
        renderSimpleWorkflow();
        $('metric-channel').textContent = `CH${state.selectedChannel}`;
        $('metric-eeg').textContent = state.eegRunning ? '采集中' : '已停止';
        $('metric-eeg').style.color = state.eegRunning ? 'var(--green)' : '';
        $('eeg-toggle-button').textContent = state.eegStopPromise ? '正在停止，请稍候…' : state.eegStopError ? '重试停止' : state.recordingWriteError && state.activeSession ? '重试保存' : state.eegRunning || state.impedanceMode ? '停止采集' : '开始采集';
        $('eeg-toggle-button').disabled = !state.connected || Boolean(state.eegStopPromise) || (state.impedanceBusy && !state.impedanceMode);
        $('status-button').disabled = !state.connected || Boolean(state.statusQueryPromise) || Boolean(state.eegStopPromise);
        $('impedance-button').disabled = !state.connected || state.eegRunning || state.impedanceMode || state.impedanceBusy || Boolean(state.eegStopPromise) || Boolean(state.eegStopError);
        if (state.eegRunning || state.impedanceMode) $('metric-battery-update').textContent = state.lastDeviceStatusTime
            ? `上次读取 ${state.lastDeviceStatusTime} · 停止采集后刷新` : '采集中，停止后读取电量';
        $('eeg-toggle-button').className = `button ${state.eegRunning ? 'danger' : 'success'}`;
        $('channel-select').value = String(state.selectedChannel);
        $('debug-channel').value = String(state.selectedChannel);
        $('wave-x-range').value = String(state.waveformWindowSeconds);
        $('wave-refresh-rate').value = String(state.waveformRefreshFps);
        $('wave-title').textContent = `CH${state.selectedChannel} 实时脑电`;
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

    function renderSleepProbabilities(probabilities = null, info = null) {
        const available = probabilities?.length === 5 && probabilities.every(Number.isFinite)
            && probabilities.reduce((sum, value) => sum + value, 0) > 0;
        state.probabilityDisplayAvailable = Boolean(available);
        $('probability-result-note').textContent = available
            ? `实时分期 · ${info?.outputTime || formatTime()}${info?.quality?.ok === false ? ' · 信号异常，不计入有效分期' : ''}`
            : (state.realtimeEnabled ? '等待新的分期结果' : '实时分期已停用');
        $('realtime-probabilities').innerHTML = Sleep.STAGES.map((stage, index) => {
            const value = available ? Math.max(0, Math.min(1, Number(probabilities[index] || 0))) : 0;
            return `<div class="stage-probability"><span>${stage}</span><div><i style="width:${(value * 100).toFixed(1)}%"></i></div><strong>${available ? `${(value * 100).toFixed(1)}%` : '--'}</strong></div>`;
        }).join('');
    }

    function resetRealtimeSleep(clearHistory = true) {
        state.sleepInferenceGeneration += 1;
        state.sleepInferencePromise = Promise.resolve();
        state.sleepPipeline?.reset();
        state.liveQuality = null;
        state.livePrediction = null;
        state.badSignalEpochs = 0;
        if ($('realtime-health-hint')) $('realtime-health-hint').hidden = true;
        state.sleepModelFilter?.reset();
        const previousTriggerTime = state.sleepStimulusGate?.lastTriggeredAt ?? null;
        state.sleepStimulusGate?.reset();
        if (state.sleepStimulusGate) state.sleepStimulusGate.lastTriggeredAt = previousTriggerTime;
        Object.values(state.sleepProbabilitySmoothers).forEach(smoother => smoother?.reset());
        Object.values(state.sleepN3Postprocessors).forEach(processor => processor?.reset());
        state.sleepEpochLightChannels.clear();
        if (clearHistory) state.sleepHistory = [];
        $('realtime-epoch').textContent = '0 段';
        $('realtime-progress').textContent = '判断所需数据 0%';
        $('realtime-stage').textContent = state.realtimeEnabled ? '等待数据' : '已停用';
        $('realtime-stage-time').textContent = '尚无结果';
        $('realtime-quality').textContent = '--';
        $('realtime-quality-detail').textContent = '等待 30 秒片段';
        $('realtime-inference-state').textContent = state.realtimeEnabled ? '等待脑电数据' : '实时分期已停用';
        renderSleepProbabilities();
        $('realtime-history').innerHTML = '<tr><td colspan="6">尚无分期结果</td></tr>';
    }

    function renderSleepHistory() {
        const mode = $('realtime-history-mode').value || 'causal';
        const rows = state.sleepHistory.filter(item => item.inferenceMode === mode);
        $('realtime-history').innerHTML = rows.length ? rows.map(item => `<tr>
            <td>${escapeHtml(item.outputTime)}</td><td>${item.epochIndex + 1}</td><td title="${item.inferenceMode === 'causal' ? '实时判断，可用于自动光照' : '利用后续数据判断约 5 分钟前，只供查看'}"><span class="state-badge ${item.quality.ok && item.stage !== (SleepPostprocess?.UNKNOWN_STAGE || 'UNKNOWN') ? '' : 'off'}">${escapeHtml(sleepStagePresentation(item))}</span><small class="stage-source">${escapeHtml(sleepStagePresentationDetail(item))}</small></td>
            <td>${sleepHistoryProbability(item)}</td><td>${item.quality.ok ? '正常' : signalReasonLabel(item.quality.reason)}</td>
            <td>${item.inferenceMode === 'center' ? '只供查看' : item.stimulusShadow ? '试运行达标，未开灯' : (item.lightChannels?.length ? `CH${item.lightChannels.join('、CH')} 开启` : '关闭')}</td>
        </tr>`).join('') : '<tr><td colspan="6">尚无此类分期结果</td></tr>';
    }

    function sleepHistoryProbability(item) {
        const stageIndex = Sleep.STAGES.indexOf(item?.stage);
        const displayedProbability = stageIndex >= 0 ? item?.probabilities?.[stageIndex] : null;
        const value = Number(displayedProbability ?? (stageIndex >= 0 ? item?.confidence : item?.candidateConfidence ?? item?.modelConfidence ?? item?.confidence));
        return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '--';
    }

    function sleepStimulusProtocolFromForm(enabled = state.sleepStimulusProtocol.enabled) {
        const targetStages = [];
        if ($('sleep-stimulus-n3-enabled')?.checked) targetStages.push('N3');
        targetStages.push(...[...document.querySelectorAll('input[name="sleep-stimulus-stage"]:checked')].map(input => input.value));
        return Sleep.normalizeStimulusProtocol({
            enabled,
            shadowMode: $('sleep-stimulus-shadow-mode').checked,
            targetStages: [...new Set(targetStages)],
            n3TriggerMode: $('sleep-stimulus-n3-mode')?.value || 'probability',
            minN3Probability: Number($('sleep-stimulus-n3-probability').value) / 100,
            minN3Confidence: Number($('sleep-stimulus-n3-confidence').value) / 100,
            minConfidence: Number($('sleep-stimulus-other-confidence').value) / 100,
            consecutiveEpochs: Number($('sleep-stimulus-consecutive').value),
            lightChannel: Number($('sleep-stimulus-channel').value),
            frequencyHz: Number($('sleep-stimulus-frequency').value),
            powerPercent: Number($('sleep-stimulus-power').value),
            durationSeconds: Number($('sleep-stimulus-duration').value),
            cooldownMinutes: Number($('sleep-stimulus-cooldown').value),
        });
    }

    function setSleepStimulusStatus(message) {
        renderSimpleWorkflow();
        $('sleep-stimulus-status').textContent = message;
        $('realtime-closed-loop-state').textContent = selectedLightMode() === 'manual' ? '手动模式 · 无需分期触发' : message;
        if (state.sleepStimulusProtocol.enabled && modelStimulusSourceAvailable()) {
            const element = $('stimulus-mode-live');
            if (element) element.textContent = message;
        }
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

    function renderSleepStimulusTriggerFields(protocol = null) {
        const selectedStages = protocol
            ? protocol.targetStages
            : [
                $('sleep-stimulus-n3-enabled')?.checked ? 'N3' : null,
                ...[...document.querySelectorAll('input[name="sleep-stimulus-stage"]:checked')].map(input => input.value),
            ].filter(Boolean);
        const targetStages = new Set(selectedStages || []);
        const includesN3 = targetStages.has('N3');
        const nonN3Stages = ['W', 'N1', 'N2', 'REM'].filter(stage => targetStages.has(stage));
        const n3TriggerMode = protocol?.n3TriggerMode || $('sleep-stimulus-n3-mode')?.value || 'probability';
        const n3ConfidenceVisible = includesN3 && n3TriggerMode === 'confirmed';
        const otherConfidenceVisible = nonN3Stages.length > 0;
        setElementVisibility('sleep-stimulus-n3-mode-field', includesN3);
        setElementVisibility('sleep-stimulus-n3-probability-field', includesN3 && n3TriggerMode === 'probability');
        setElementVisibility('sleep-stimulus-n3-confidence-field', n3ConfidenceVisible);
        setElementVisibility('sleep-stimulus-other-confidence-field', otherConfidenceVisible);
        const modeHelp = $('sleep-stimulus-n3-mode-help');
        if (modeHelp) {
            modeHelp.textContent = n3TriggerMode === 'confirmed'
                ? '增加一次信号特征检查，可能更晚开灯；不保证更准确。'
                : '按实时模型给出的 N3 概率判断。';
        }
        const confidenceHelp = $('sleep-stimulus-other-confidence-help');
        if (confidenceHelp) {
            confidenceHelp.textContent = nonN3Stages.length
                ? `用于 ${nonN3Stages.join('、')}；N3 使用自己的阈值。`
                : '当前没有其他分期目标，此项不会参与判断。';
        }
        const triggerSummary = $('sleep-stimulus-trigger-summary');
        if (triggerSummary) {
            const targetText = targetStages.size ? [...targetStages].join('、') : '尚未选择';
            const modeText = includesN3
                ? (n3TriggerMode === 'confirmed'
                    ? 'N3 需额外检查'
                    : '按 N3 概率判断')
                : `概率至少 ${Math.round((protocol?.minConfidence ?? Number($('sleep-stimulus-other-confidence').value) / 100) * 100)}%`;
            triggerSummary.textContent = `目标：${targetText} · ${modeText}。先收满约 10.5 分钟的合格数据，再按下方条件开灯。`;
        }
    }

    function renderSleepStimulusProtocol() {
        renderSimpleWorkflow();
        const protocol = state.sleepStimulusProtocol;
        $('stimulus-active-mode-note').textContent = protocol.shadowMode
            ? '试运行：只记录命中，不发光。'
            : '自动开灯：开启后，满足所选条件才发光。';
        const modelAllowed = modelStimulusSourceAvailable();
        $('sleep-stimulus-enabled').checked = modelAllowed && protocol.enabled;
        $('sleep-stimulus-n3-enabled').checked = protocol.targetStages.includes('N3');
        $('sleep-stimulus-n3-mode').value = protocol.n3TriggerMode;
        for (const input of document.querySelectorAll('input[name="sleep-stimulus-stage"]')) {
            input.checked = protocol.targetStages.includes(input.value);
        }
        $('sleep-stimulus-n3-probability').value = String(Math.round(protocol.minN3Probability * 100));
        $('sleep-stimulus-n3-confidence').value = String(Math.round(protocol.minN3Confidence * 100));
        $('sleep-stimulus-other-confidence').value = String(Math.round(protocol.minConfidence * 100));
        $('sleep-stimulus-consecutive').value = String(protocol.consecutiveEpochs);
        $('sleep-stimulus-channel').value = String(protocol.lightChannel);
        $('sleep-stimulus-frequency').value = String(protocol.frequencyHz);
        $('sleep-stimulus-power').value = String(protocol.powerPercent);
        $('sleep-stimulus-duration').value = String(protocol.durationSeconds);
        $('sleep-stimulus-cooldown').value = String(protocol.cooldownMinutes);
        $('sleep-stimulus-shadow-mode').checked = protocol.shadowMode;
        renderSleepStimulusTriggerFields(protocol);
        $('sleep-stimulus-mode').textContent = `${protocol.shadowMode
            ? `试运行：仅记录命中，不发光 · ${sleepStimulusTriggerSummary(protocol)}`
            : `自动开灯 · ${sleepStimulusTriggerSummary(protocol)}`} · 回看结果和重新分期不会开灯`;
        renderStimulusModeCard();
        if (!protocol.enabled) setSleepStimulusStatus('未启用');
    }

    function saveSleepStimulusProtocol(protocol) {
        localStorage.setItem('sleepStimulusProtocol', JSON.stringify({ ...protocol, enabled: false }));
    }

    function applySleepStimulusProtocol(protocol) {
        const errors = Sleep.validateStimulusProtocol(protocol);
        if (errors.length) throw new Error(errors.join('；'));
        state.sleepStimulusProtocol = Sleep.normalizeStimulusProtocol(protocol);
        const previousTriggerTime = state.sleepStimulusGate.lastTriggeredAt;
        const previousActiveUntil = state.sleepStimulusGate.activeUntil;
        state.sleepStimulusGate.updateProtocol(state.sleepStimulusProtocol);
        // Changing targets restarts consecutive matching, not the shared
        // cooldown or the duration of an already running light pulse.
        state.sleepStimulusGate.lastTriggeredAt = previousTriggerTime;
        state.sleepStimulusGate.activeUntil = previousActiveUntil;
        saveSleepStimulusProtocol(state.sleepStimulusProtocol);
        renderSleepStimulusProtocol();
        return state.sleepStimulusProtocol;
    }

    async function disableSleepStimulus(reason, stopActive = true) {
        const wasEnabled = state.sleepStimulusProtocol.enabled;
        const activeChannel = state.sleepStimulusActiveChannel;
        const previousTriggerTime = state.sleepStimulusGate?.lastTriggeredAt ?? null;
        if (state.sleepStimulusStopTimer) clearTimeout(state.sleepStimulusStopTimer);
        state.sleepStimulusStopTimer = null;
        state.sleepStimulusActiveChannel = null;
        state.sleepStimulusProtocol = { ...state.sleepStimulusProtocol, enabled: false };
        state.sleepStimulusGate?.updateProtocol(state.sleepStimulusProtocol);
        if (state.sleepStimulusGate) state.sleepStimulusGate.lastTriggeredAt = previousTriggerTime;
        if ($('sleep-stimulus-enabled')) $('sleep-stimulus-enabled').checked = false;
        setSleepStimulusStatus(`未启用${reason ? ` · ${reason}` : ''}`);
        if (stopActive && activeChannel && state.connected) {
            await withLightLease(() => stopLight(activeChannel, { source: 'sleep_stage', reason, quiet: true }));
        }
        if (wasEnabled || activeChannel) await audit('sleep_stimulus_disabled', { reason, activeChannel });
    }

    // A manual or scheduled light action may take the hardware lease from an
    // active model pulse, but it must not silently disable the saved model
    // protocol. The next eligible causal epoch can use it again.
    async function preemptSleepStimulus(reason) {
        const activeChannel = state.sleepStimulusActiveChannel;
        if (!activeChannel) return;
        if (state.sleepStimulusStopTimer) clearTimeout(state.sleepStimulusStopTimer);
        state.sleepStimulusStopTimer = null;
        state.sleepStimulusActiveChannel = null;
        state.sleepStimulusGate?.cancelTrigger();
        if (state.connected) await stopLight(activeChannel, { source: 'manual_or_plan', reason, quiet: true });
        else await audit('sleep_stimulus_stop_unconfirmed', { channel: activeChannel, reason, source: 'manual_or_plan' }, 'error');
        setSleepStimulusStatus(`模型触发暂挂 · ${reason}`);
        await audit('sleep_stimulus_preempted', { channel: activeChannel, reason });
    }

    async function executeSleepStimulus(trigger) {
        if (!modelStimulusSourceAvailable()) {
            state.sleepStimulusGate?.cancelTrigger();
            setSleepStimulusStatus('模型触发已取消 · 当前控制方式不包含模型');
            return;
        }
        const triggerLabel = trigger.triggerBasis === 'n3_probability'
            ? `N3 概率 ${(trigger.n3Probability * 100).toFixed(1)}%`
            : `把握程度 ${(trigger.confidence * 100).toFixed(1)}%`;
        if (trigger.shadowMode) {
            await audit('sleep_stimulus_shadow_triggered', { ...trigger, deviceCommandSent: false });
            setSleepStimulusStatus(`${trigger.stage} 试运行达标 · ${triggerLabel} · 未发光`);
            addActivity(`睡眠分期 ${trigger.stage} 试运行达标（shadow mode，未发光）`);
            return;
        }
        return withLightLease(() => executeSleepStimulusHardware(trigger, triggerLabel));
    }

    async function executeSleepStimulusHardware(trigger, triggerLabel) {
        if (!state.sleepStimulusProtocol.enabled || !state.connected || !state.eegRunning) {
            state.sleepStimulusGate.cancelTrigger();
            setSleepStimulusStatus('模型触发已取消 · 设备、EEG 或自动光照状态已变化');
            return;
        }
        if (planEngine.getRelativeStatus() || state.lightRunning[1] || state.lightRunning[2]) {
            state.sleepStimulusGate.cancelTrigger();
            setSleepStimulusStatus('模型触发已暂停 · 手动或方案光照正在运行');
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
            // A command can reach hardware even when its acknowledgement fails.
            // Stop every selected output, including a partially started pair.
            try { await stopLight(channel, { ...context, reason: 'trigger_failed', quiet: true }); }
            catch (stopError) { await audit('sleep_stimulus_stop_unconfirmed', { channel, error: stopError.message }, 'error'); }
            state.sleepStimulusGate.cancelTrigger();
            setSleepStimulusStatus(`触发失败 · ${error.message}`);
            await audit('sleep_stimulus_trigger_failed', { ...trigger, error: error.message }, 'error');
            throw error;
        }

        state.sleepStimulusActiveChannel = channel;
        const channelLabel = channel === 3 ? '两个光源' : `光源${channel}`;
        setSleepStimulusStatus(`${trigger.stage} 已触发 ${channelLabel} · ${triggerLabel} · ${trigger.durationMs / 1000} 秒`);
        addActivity(`睡眠分期 ${trigger.stage} 触发光照 ${channelLabel}`);
        await audit('sleep_stimulus_triggered', { ...trigger, modelDelayEpochs: 0, decisionCadenceSeconds: 30 });
        if (state.sleepStimulusStopTimer) clearTimeout(state.sleepStimulusStopTimer);
        state.sleepStimulusStopTimer = setTimeout(() => {
            state.sleepStimulusStopTimer = null;
            if (state.sleepStimulusActiveChannel !== channel) return;
            state.sleepStimulusActiveChannel = null;
            void runUiTask(() => withLightLease(async () => {
                if (state.connected) await stopLight(channel, { source: 'sleep_stage', reason: 'duration_elapsed', quiet: true });
                else await audit('sleep_stimulus_stop_unconfirmed', { channel, reason: 'ble_disconnected' }, 'error');
                setSleepStimulusStatus(`等待下次允许开灯 · ${trigger.cooldownMinutes} 分钟`);
                await audit('sleep_stimulus_completed', { channel, epochIndex: trigger.epochIndex, stage: trigger.stage });
            }));
        }, trigger.durationMs);
    }

    async function handleSleepStimulusResult(item) {
        if (!state.sleepStimulusGate || !state.sleepStimulusProtocol.enabled) return;
        if (!modelStimulusSourceAvailable()) {
            setSleepStimulusStatus('模型触发未开放 · 当前控制方式不包含模型');
            return;
        }
        if (!state.connected || !state.eegRunning) {
            setSleepStimulusStatus('已启用 · 等待设备连接并开始采集');
            return;
        }
        if (item.inferenceMode !== 'causal') {
            setSleepStimulusStatus('已启用 · 延后结果仅作事后查看，等待实时分期');
            return;
        }
        const useN3ProbabilityTrigger = state.sleepStimulusProtocol.n3TriggerMode === 'probability'
            && state.sleepStimulusProtocol.targetStages.includes('N3')
            && (item.candidateStage === 'N3' || item.stage === 'N3');
        const stimulusControlEligible = useN3ProbabilityTrigger
            ? item.stimulusControlEligible === true : item.controlEligible === true;
        if (stimulusControlEligible !== true) {
            state.sleepStimulusGate.reject('control_ineligible');
            const eligibilityReason = useN3ProbabilityTrigger
                ? item.stimulusControlEligibilityReason : item.controlEligibilityReason;
            const reason = eligibilityReason === 'insufficient_context'
                ? '尚未收满 21 段'
                : (eligibilityReason === 'context_quality' ? '21 段 中存在质量警告' : '实时分期时序未满足');
            setSleepStimulusStatus(`实时分期暂不触发 · ${reason}`);
            await audit('sleep_stimulus_control_blocked', {
                epochIndex: item.epochIndex,
                stage: item.stage,
                inferenceMode: item.inferenceMode,
                modelDelaySeconds: item.modelDelaySeconds,
                controlEligibilityReason: eligibilityReason,
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
            setSleepStimulusStatus('已启用 · 已有光照运行，暂停触发');
            return;
        }
        const decision = state.sleepStimulusGate.evaluate({
            epochIndex: item.epochIndex,
            stage: item.stage,
            confidence: item.confidence,
            candidateStage: item.candidateStage,
            candidateConfidence: item.candidateConfidence,
            probabilities: item.probabilities,
            quality: item.quality,
            n3Postprocessed: item.n3Postprocessed === true,
        });
        if (decision.triggered) {
            item.stimulusShadow = state.sleepStimulusProtocol.shadowMode;
            item.stimulusTriggerBasis = decision.triggerBasis;
            item.stimulusN3Probability = decision.n3Probability;
            renderSleepHistory();
            await executeSleepStimulus(decision);
            return;
        }
        const statusLabels = {
            poor_quality: '质量未通过，连续计数已清零',
            stage_not_selected: `等待目标分期 · 当前 ${sleepStageLabel(item.stage)}`,
            low_confidence: useN3ProbabilityTrigger
                ? `N3 概率不足 · ${(Number(item.candidateConfidence || 0) * 100).toFixed(1)}%`
                : `把握程度不足 · ${(item.confidence * 100).toFixed(1)}%`,
            stimulus_active: '刺激进行中',
            cooldown: '等待下次允许开灯',
            duplicate_epoch: '已跳过重复片段',
            context_quality: '连续片段的信号未通过',
            n3_not_trusted: `N3 未通过额外检查 · ${n3StatusLabel(item.n3Status) || '等待检查'}`,
        };
        if (decision.reason === 'awaiting_consecutive') {
            setSleepStimulusStatus(`${decision.stage}${useN3ProbabilityTrigger ? ' 估计' : ''}连续满足 ${decision.matchedCount} / ${decision.requiredCount}`);
        } else if (statusLabels[decision.reason]) {
            setSleepStimulusStatus(statusLabels[decision.reason]);
        }
    }

    async function inferSleepEpoch(input, generation = state.sleepInferenceGeneration) {
        if (!state.sleepModelReady) return;
        $('realtime-inference-state').textContent = `正在判断第 ${input.classifiedEpochIndex + 1} 段…`;
        try {
            const result = await window.desktopAPI.inferSleepStage(input);
            if (generation !== state.sleepInferenceGeneration) return;
            state.liveModelError = false;
            const inferenceMode = input.inferenceMode || 'unknown';
            const smoother = state.sleepProbabilitySmoothers[inferenceMode];
            const smoothed = smoother ? smoother.update(result.probabilities) : {
                probabilities: result.probabilities,
                stageIndex: result.stage,
                confidence: Math.max(...result.probabilities),
                margin: null,
                rawProbabilities: result.probabilities,
            };
            const modelConfidence = smoothed.confidence;
            const modelStage = Sleep.STAGES[smoothed.stageIndex] || `Stage ${smoothed.stageIndex}`;
            const targetQuality = input.targetQuality || input.centerQuality || { ok: false, reason: 'missing_quality' };
            const delaySeconds = Number(input.modelDelaySeconds) || 0;
            const contextReady = input.historyEpochs >= input.temporalContext && input.contextQualityOk === true;
            const n3Postprocessor = state.sleepN3Postprocessors[inferenceMode];
            const postprocessed = n3Postprocessor ? n3Postprocessor.update({
                epochIndex: input.classifiedEpochIndex,
                rawStage: modelStage,
                rawProbabilities: smoothed.probabilities,
                quality: targetQuality,
                deltaRatio: targetQuality.deltaRatio,
                contextReady,
                contextQualityOk: input.contextQualityOk === true,
                controlEligible: input.controlEligible === true,
            }) : {
                stage: modelStage,
                candidateStage: modelStage,
                candidateConfidence: modelConfidence,
                confidence: modelConfidence,
                n3Status: 'unavailable',
                reason: 'postprocessor_unavailable',
                controlEligible: false,
                controlEligibilityReason: 'postprocessor_unavailable',
                n3Evidence: null,
            };
            const stage = postprocessed.stage || modelStage;
            const candidateStage = postprocessed.candidateStage || modelStage;
            const candidateConfidence = Number.isFinite(Number(postprocessed.candidateConfidence))
                ? Number(postprocessed.candidateConfidence) : modelConfidence;
            const confidence = Number.isFinite(Number(postprocessed.confidence))
                ? Number(postprocessed.confidence) : modelConfidence;
            // Scoring/control eligibility remains conservative for the displayed
            // stage. The probability-trigger path below gets its own eligibility
            // flag so a visible N3 candidate can drive the optional experiment
            // without rewriting the reported sleep stage.
            const controlEligible = modelStage === 'N3' && n3Postprocessor
                ? postprocessed.controlEligible === true
                : input.controlEligible === true && targetQuality.ok === true;
            const stimulusControlEligible = input.inferenceMode === 'causal'
                && input.controlEligible === true && targetQuality.ok === true;
            const stimulusControlEligibilityReason = input.controlEligibilityReason;
            const item = {
                outputTime: formatTime(), epochIndex: input.classifiedEpochIndex, stage, confidence,
                probabilities: smoothed.probabilities, rawProbabilities: Array.from(result.probabilities, Number),
                rawStage: Sleep.STAGES[result.stage] || `Stage ${result.stage}`, modelStage,
                candidateStage, candidateConfidence,
                modelConfidence, n3Status: postprocessed.n3Status, n3Reason: postprocessed.reason,
                n3Evidence: postprocessed.n3Evidence, n3Postprocessed: postprocessed.n3Status === 'trusted',
                probabilityMargin: smoothed.margin, quality: targetQuality,
                inferenceMode, modelDelaySeconds: delaySeconds,
                controlEligible,
                controlEligibilityReason: postprocessed.controlEligibilityReason || input.controlEligibilityReason,
                stimulusControlEligible,
                stimulusControlEligibilityReason,
                lightChannels: Array.from(input.lightChannels || []),
            };
            state.sleepHistory.unshift(item);
            if (inferenceMode === 'causal') {
                state.livePrediction = { ...item, receivedAt: Date.now() };
                renderLiveStatus();
            }
            state.sleepHistory.length = Math.min(state.sleepHistory.length, 120);
            const presentation = sleepStagePresentation(item);
            $('realtime-stage').textContent = targetQuality.ok ? presentation : `${presentation}（质量警告）`;
            const presentationHint = stage === (SleepPostprocess?.UNKNOWN_STAGE || 'UNKNOWN')
                ? (candidateStage === 'N3'
                    ? (state.sleepStimulusProtocol.n3TriggerMode === 'probability'
                        ? '可能是 N3，按设置的概率决定是否开灯' : '可能是 N3，未通过额外检查')
                    : '暂时无法判断，不计入统计')
                : '模型已给出结果';
            $('realtime-stage-time').textContent = inferenceMode === 'center'
                ? `${presentationHint} · 第 ${input.classifiedEpochIndex + 1} 段 · 约 ${Math.round(delaySeconds / 60)} 分钟前`
                : `${presentationHint} · 第 ${input.classifiedEpochIndex + 1} 段 · 实时分期`;
            $('realtime-inference-state').textContent = inferenceMode === 'center'
                ? '已更新约 5 分钟前的分期'
                : '已更新实时分期';
            if (inferenceMode === 'causal') renderSleepProbabilities(smoothed.probabilities, item);
            renderSleepHistory();
            await audit('sleep_stage_inferred', {
                epochIndex: input.classifiedEpochIndex, stage, confidence,
                probabilities: smoothed.probabilities, rawProbabilities: item.rawProbabilities,
                rawStage: item.rawStage, modelStage, modelConfidence,
                candidateStage: item.candidateStage, candidateConfidence: item.candidateConfidence,
                n3Status: item.n3Status, n3Reason: item.n3Reason, n3Evidence: item.n3Evidence,
                n3Postprocessed: item.n3Postprocessed,
                probabilityMargin: smoothed.margin, quality: targetQuality,
                outputIndex: result.selectedOutputIndex, historyEpochs: input.historyEpochs,
                lightChannels: item.lightChannels, inferenceMode,
                modelDelaySeconds: delaySeconds, controlEligible: item.controlEligible,
                stimulusControlEligible: item.stimulusControlEligible,
                stimulusControlEligibilityReason: item.stimulusControlEligibilityReason,
                controlEligibilityReason: item.controlEligibilityReason,
            });
            await handleSleepStimulusResult(item);
        } catch (error) {
            if (generation !== state.sleepInferenceGeneration) return;
            $('realtime-model').textContent = '模型错误';
            state.liveModelError = true;
            renderLiveStatus();
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
                $('realtime-progress').textContent = `本段收集进度 ${(state.sleepPipeline.progress * 100).toFixed(0)}% · 每段 30 秒`;
            }
            return;
        }
        const buffered = Math.min(epoch.totalEpochs, state.sleepPipeline.temporalContext);
        state.liveQuality = epoch.quality;
        renderLiveStatus();
        $('realtime-epoch').textContent = `${epoch.totalEpochs} 段`;
        $('realtime-progress').textContent = `每段 30 秒 · 判断所需数据 ${buffered} / ${state.sleepPipeline.temporalContext} 段`;
        $('realtime-quality').textContent = epoch.quality.ok ? '通过' : '警告';
        state.badSignalEpochs = epoch.quality.ok ? 0 : state.badSignalEpochs + 1;
        const healthHint = $('realtime-health-hint');
        if (healthHint) {
            healthHint.hidden = false;
            healthHint.textContent = !epoch.quality.ok
                ? `${signalReasonLabel(epoch.quality.reason)}，请检查电极和连接；这段数据不会触发光照。`
                : selectedLightMode() === 'manual' ? '信号正常；手动光照不依赖分期。' : '信号正常；满足所选分期条件后才会自动开灯。';
        }
        if (state.badSignalEpochs === 2) {
            toast('脑电连续约 1 分钟异常，请检查电极与连接；异常片段不会触发光照。', 'error');
            void audit('signal_recovery_needed', { reason: epoch.quality.reason, consecutiveBadEpochs: 2 }, 'error');
        }
        if (epoch.quality.reason === 'raw_saturation') {
            $('realtime-quality').textContent = '原始脑电饱和：检查电极、参考与接线';
            if (state.sleepStimulusActiveChannel) void runUiTask(() => disableSleepStimulus('原始脑电饱和'));
        }
        const gapDetail = epoch.gapSamples ? ` · 序列缺口 ${epoch.gapSamples} 点` : '';
        const deltaDetail = Number.isFinite(epoch.quality.deltaRatio) ? ` · δ ${(epoch.quality.deltaRatio * 100).toFixed(1)}%` : '';
        const amplitudeDetail = Number.isFinite(epoch.quality.maxAbsUv)
            ? `max|x| ${epoch.quality.maxAbsUv.toFixed(1)} / ${Sleep.DEFAULT_EEG_QUALITY_PROFILE.maxAbsUv} µV`
            : `max|x| / ${Sleep.DEFAULT_EEG_QUALITY_PROFILE.maxAbsUv} µV`;
        $('realtime-quality-detail').textContent = `${amplitudeDetail} · SD ${epoch.quality.stdUv.toFixed(2)} µV · P-P ${epoch.quality.peakToPeakUv.toFixed(1)} µV${deltaDetail}${gapDetail}`;
        if (epoch.gapSamples) {
            state.sleepEpochLightChannels.clear();
            $('realtime-inference-state').textContent = `检测到序列缺口，跳过第 ${epoch.totalEpochs} 段`;
            return;
        }
        $('realtime-inference-state').textContent = '正在更新分期…';
        // 延后结果对应约 5 分钟前的目标 epoch，当前 epoch 的光照状态不能
        // 反写到历史目标 epoch；只有实时分期在完整、质量通过的 21 epoch
        // 上才具备试验性自动光照资格。
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
        state.sleepPipeline = new Sleep.RealtimeSleepPipeline({
            inputRateHz: 250, modelRateHz: 100, epochSeconds: 30, temporalContext: 21,
            qualityWarmupSeconds: 5,
        });
        state.sleepProbabilitySmoothers = {
            center: new Sleep.SleepStageSmoother({ alpha: 0.5 }),
            causal: new Sleep.SleepStageSmoother({ alpha: 0.5 }),
        };
        state.sleepN3Postprocessors = SleepPostprocess ? {
            center: new SleepPostprocess.N3Postprocessor({ mode: 'center' }),
            causal: new SleepPostprocess.N3Postprocessor({ mode: 'causal' }),
        } : { center: null, causal: null };
        state.sleepStimulusGate = new Sleep.SleepStageStimulusGate(state.sleepStimulusProtocol);
        renderSleepStimulusProtocol();
        for (const input of document.querySelectorAll('input[name="sleep-stimulus-stage"]')) {
            input.addEventListener('change', () => renderSleepStimulusTriggerFields());
        }
        $('realtime-enabled').checked = state.realtimeEnabled;
        $('realtime-enabled').addEventListener('change', event => {
            state.realtimeEnabled = event.target.checked;
            localStorage.setItem('realtimeSleepEnabled', String(state.realtimeEnabled));
            resetRealtimeSleep(true);
            if (!state.realtimeEnabled) void runUiTask(() => disableSleepStimulus('实时分期已停用'));
        });
        $('sleep-stimulus-save').addEventListener('click', () => runUiTask(async () => {
            const feedback = $('sleep-settings-feedback');
            const invalid = [...$('sleep-stimulus-config').querySelectorAll('input[type="number"]')]
                .find(input => input.getClientRects().length && (!input.value.trim() || !input.checkValidity()));
            if (invalid) {
                feedback.dataset.error = 'true';
                feedback.textContent = `请检查“${invalid.closest('label').innerText.split('\n')[0]}”${invalid.min && invalid.max ? `（${invalid.min}–${invalid.max}）` : ''}。`;
                invalid.focus();
                invalid.scrollIntoView({ block: 'center' });
                return;
            }
            const errors = Sleep.validateStimulusProtocol(sleepStimulusProtocolFromForm());
            if (errors.length) { feedback.dataset.error = 'true'; feedback.textContent = errors.join('；'); return; }
            const protocol = applySleepStimulusProtocol(sleepStimulusProtocolFromForm());
            setSleepStimulusStatus(protocol.enabled ? '参数已保存 · 等待目标分期' : '参数已保存 · 未启用');
            await audit('sleep_stimulus_protocol_saved', { ...protocol, enabled: undefined });
            $('sleep-stimulus-settings-dialog').close();
            toast(protocol.enabled ? '参数已保存，将用于后续触发。' : '参数已保存，自动光照尚未开启。');
        }));
        $('sleep-stimulus-config').addEventListener('input', () => {
            $('sleep-settings-feedback').dataset.error = 'false';
            $('sleep-settings-feedback').textContent = '有未保存的修改';
        });
        $('sleep-stimulus-cancel').addEventListener('click', () => $('sleep-stimulus-settings-dialog').close());
        $('sleep-stimulus-enabled').addEventListener('change', event => {
            const shouldEnable = event.target.checked;
            event.target.checked = state.sleepStimulusProtocol.enabled;
            void runUiTask(async () => {
                if (!shouldEnable) return disableSleepStimulus('手动关闭');
                if (!state.realtimeEnabled) throw new Error('请先启用实时分期');
                if (!state.sleepModelReady) throw new Error('睡眠分期模型尚未就绪');
                if (!state.connected || !state.eegRunning) throw new Error('请先连接设备并开始采集，再启用刺激协议');
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
            $('realtime-model-detail').textContent = 'Stage-1 ONNX · 研究版，实时判断尚未独立验证';
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
                // The renderer owns the display history; unused eight-channel
                // spectra and impedance estimates need not run on every sample.
                historyPoints: 256,
                filter: { enabled: true, preset: 'eeg-display-0p5-45' },
                fft: { enabled: false },
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
            let protocolErrors = 0;
            client.on('error', error => {
                protocolErrors += 1;
                if (protocolErrors <= 8 || protocolErrors % 100 === 0) {
                    logProtocol('ERR', `${formatProtocolError(error)} · 累计 ${protocolErrors} 次`, 'error');
                    audit('protocol_error', { error: error.message, protocolErrors, ...protocolErrorContext(error) }, 'error');
                }
            });
            client.on('warning', warning => logProtocol('WARN', warning.message, 'error'));
            await client.connect();
            state.transport = transport;
            state.processor = processor;
            state.sleepModelFilter = sleepModelFilter;
            state.client = client;
            state.lastDeviceStatus = null;
            state.lastDeviceStatusTime = null;
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
                state.deviceInfo = await client.discover({ timeoutMs: 10000 });
                const version = state.deviceInfo.protocolVersion;
                const capabilityLabel = state.deviceInfo.compatibilityMode
                    ? '兼容模式'
                    : `${state.deviceInfo.actionCount} Actions`;
                $('metric-protocol').textContent = `ActionBus ${version.major}.${version.minor} · ${capabilityLabel}`;
                if (state.deviceInfo.compatibilityMode) {
                    addActivity('设备未提供完整能力目录，已按兼容路径继续：状态、EEG、方案和手动控制仍可测试');
                    toast('BLE 已连接；设备能力目录不完整，已使用与 Windows 相同的兼容路径继续', 'info');
                } else {
                    addActivity(`能力发现完成：${state.deviceInfo.actionCount} Actions`);
                }
            } catch (error) {
                toast('蓝牙已连接，但设备信息还未读到。请先查询设备状态，暂不重复连接。', 'info');
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
        state.disconnecting = true;
        try { await state.client?.disconnect(); } catch (error) { logProtocol('ERR', error.message, 'error'); }
        finally { state.disconnecting = false; }
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
        clearManualLightTracking();
        if (state.disconnecting) return;
        if (!state.connected) return;
        planEngine.stopRelative('ble_disconnected');
        state.connected = false;
        state.eegRunning = false;
        state.deviceEegRunning = false;
        state.eegStopError = null;
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
        // Live testing shows status queries time out during EEG on this firmware.
        // Avoid repeated queries and do not label cached battery values fresh.
        if (state.eegRunning || state.impedanceMode || state.eegStopPromise) {
            const cached = state.lastDeviceStatus;
            $('metric-battery').textContent = cached ? `${cached.batteryLevel}%` : '--%';
            $('metric-battery-update').textContent = cached
                ? `上次读取 ${state.lastDeviceStatusTime} · 停止采集后刷新` : '采集中，停止后读取电量';
            if (!state.statusDeferredNoticeShown) {
                state.statusDeferredNoticeShown = true;
                toast('采集中使用最近一次电量，停止后刷新。');
            }
            return { ...cached, cached: true };
        }
        if (state.statusQueryPromise) return state.statusQueryPromise;
        const request = (async () => {
        const status = await requireClient().getStatus({ timeoutMs: 10000 });
        state.lastDeviceStatus = status;
        state.lastDeviceStatusTime = formatTime();
        state.statusDeferredNoticeShown = false;
        state.deviceEegRunning = Boolean(status.eegRunning);
        if (!state.deviceEegRunning && !state.eegRunning && !state.activeSession) state.eegStopError = null;
        // A device may still be streaming after reconnecting. Do not claim
        // that these samples are being saved without an application session.
        if (!state.impedanceMode && !state.activeSession) state.eegRunning = false;
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
        })();
        state.statusQueryPromise = request;
        updateEegUi();
        try { return await request; }
        catch (error) {
            if (error.name === 'TimeoutError') {
                logProtocol('ERR', error.message, 'error');
                throw new Error('设备状态回复较慢，暂时未更新电量。请稍后重试。');
            }
            throw error;
        } finally { if (state.statusQueryPromise === request) state.statusQueryPromise = null; updateEegUi(); }
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
            await stopEegOnDevice();
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        let commandError = null;
        try { await client.configureEeg(expected); }
        catch (error) { commandError = error; }
        await new Promise(resolve => setTimeout(resolve, 2));
        const after = await client.readAds1299Registers();
        const mismatches = SDK.ads1299.compareAdsConfig(expected, after.values);
        if (mismatches.length) {
            const first = mismatches[0];
            if (commandError) throw commandError;
            throw new Error(`ADS1299 配置回读不一致: 0x${first.address.toString(16).padStart(2, '0')} expected=0x${first.expected.toString(16).padStart(2, '0')} actual=0x${first.actual.toString(16).padStart(2, '0')}`);
        }
        if (commandError) {
            await audit('eeg_config_reply_failed_but_verified', { channel, impedance, error: commandError.message, registersHex: Core.bytesToHex(after.values) }, 'warn');
            logProtocol('WARN', `设备配置回复异常，但寄存器回读已确认一致：${commandError.message}`, 'warning');
        }
        await audit('eeg_config_verified', { channel, impedance, registersHex: Core.bytesToHex(after.values) });
        return { config: expected, readback: after.values, skippedWrite: false };
    }

    async function applyChannel(channel, impedance = false) {
        if (state.eegRunning && !state.impedanceMode) throw new Error('请先停止采集 再切换通道');
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
        if (state.impedanceBusy) throw new Error('电极检测正在结束，请稍候再开始采集');
        if (state.deviceEegRunning) await stopEegOnDevice();
        const channel = options.channel || state.selectedChannel;
        await applyChannel(channel, false);
        await beginSession(options.plan || null);
        try {
            await requireClient().startEeg();
            state.eegRunning = true;
            state.deviceEegRunning = true;
            state.eegStopError = null;
            state.liveStartedAt = Date.now();
            state.lastEegReceivedAt = null;
            state.statusDeferredNoticeShown = false;
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

    async function stopEegOnDevice() {
        if (state.eegStopPromise) return state.eegStopPromise;
        const task = confirmEegStopped();
        state.eegStopPromise = task;
        updateEegUi();
        try { return await task; }
        finally { if (state.eegStopPromise === task) state.eegStopPromise = null; updateEegUi(); }
    }

    async function confirmEegStopped() {
        const client = requireClient();
        let commandError = null;
        // Streaming firmware can deliver replies behind buffered EEG packets.
        // One bounded transaction is preferable to queuing repeated stop clicks.
        try { await client.stopEeg({ timeoutMs: 15000 }); } catch (error) { commandError = error; }
        try {
            const status = await client.getStatus({ timeoutMs: 10000 });
            state.deviceEegRunning = Boolean(status.eegRunning);
            if (state.deviceEegRunning) throw commandError || new Error('设备仍在采集');
            state.lastDeviceStatus = status;
            state.lastDeviceStatusTime = formatTime();
            $('metric-battery').textContent = `${status.batteryLevel}%`;
            $('metric-battery-update').textContent = `更新 ${state.lastDeviceStatusTime} · 已停止采集`;
            state.eegStopError = null;
        } catch (error) {
            state.eegStopError = error.message;
            updateEegUi();
            throw new Error(`停止未确认，请重试；记录仍保持打开：${error.message}`);
        }
    }

    async function stopEeg(reason = 'manual') {
        if (!state.eegRunning && !state.impedanceMode && !state.activeSession) return;
        state.cancelImpedanceWaiter?.();
        try { await disableSleepStimulus('EEG 已停止'); }
        catch (error) {
            logProtocol('ERR', `解除分期刺激协议：${error.message}`, 'error');
            await audit('sleep_stimulus_disable_failed', { reason, error: error.message }, 'error');
        }
        await stopEegOnDevice();
        state.eegRunning = false;
        state.impedanceMode = false;
        updateEegUi();
        renderNextAction();
        addActivity('脑电采集已停止');
        await audit('eeg_stopped', { reason });
        if (state.activeSession) await finishSession('completed', reason);
    }

    async function measureImpedance(channel = state.selectedChannel) {
        if (state.eegRunning) throw new Error('阻抗检测前必须停止普通 EEG');
        if (state.impedanceBusy) throw new Error('电极检测正在进行，请稍候');
        const client = requireClient();
        state.impedanceBusy = true;
        state.impedanceMode = true;
        renderNextAction();
        $('impedance-button').disabled = true;
        $('metric-impedance').textContent = '-- kΩ';
        $('metric-impedance-state').textContent = '正在采集 1024 点…';
        let measurementError = null;
        state.impedanceDiagnostics = { received: 0, windows: 0, lastKohm: null, maxAbsRaw: 0, saturated: 0, cleanSamples: 0, longestCleanRun: 0, rawWindow: [] };
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
            state.processor.impedance = new SDK.impedance.ImpedanceEstimator({ channelCount: 8, preset: 'brainlume-24na-v1' });
            await client.startEeg();
            const value = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    state.impedanceWaiter = null;
                    state.cancelImpedanceWaiter = null;
                    const d = state.impedanceDiagnostics;
                    const message = d && d.received >= 1024
                        ? d.saturated >= d.received * 0.99 ? '阻抗信号超出设备量程，请检查电极、参考与接线'
                            : d.longestCleanRun < 1024 ? '未收到连续且未超量程的阻抗数据，请检查电极与连接'
                                : '已收到阻抗数据，但未得到有效测量值，请检查电极与连接'
                        : `阻抗数据不足（${d?.received || 0}/1024 点），请检查设备连接`;
                    reject(new Error(message));
                }, 8000);
                state.cancelImpedanceWaiter = () => {
                    clearTimeout(timer);state.impedanceWaiter=null;state.cancelImpedanceWaiter=null;
                    reject(new Error('电极检测已取消'));
                };
                state.impedanceWaiter = impedanceValues => {
                    const kohm = impedanceValues[channel - 1];
                    if (!Number.isFinite(kohm) || kohm <= 0) return;
                    clearTimeout(timer);
                    state.impedanceWaiter = null;
                    state.cancelImpedanceWaiter = null;
                    resolve(kohm);
                };
            });
            $('metric-impedance').textContent = `${value.toFixed(2)} kΩ`;
            $('metric-impedance-state').textContent = `CH${channel} · 已校准预设`;
            addActivity(`CH${channel} 阻抗 ${value.toFixed(2)} kΩ`);
            await audit('impedance_measured', { channel, kohm: value });
            return value;
        } catch (error) {
            measurementError = error;
            $('metric-impedance-state').textContent = `检测失败：${error.message}`;
            const { rawWindow, ...diagnostics } = state.impedanceDiagnostics;
            const estimator = state.processor?.impedance;
            const filtered = estimator?.buffers?.[channel - 1];
            if (filtered && filtered.length === estimator.options.fftSize && rawWindow.length === filtered.length) {
                const { sampleRateHz, excitationHz, gain, vrefVolts } = estimator.options;
                const rawPeak = SDK.impedance.tonePeakCodes(rawWindow, sampleRateHz, excitationHz);
                const filteredPeak = SDK.impedance.tonePeakCodes(filtered, sampleRateHz, excitationHz);
                diagnostics.excitationHz = excitationHz;
                diagnostics.rawTonePeakUv = SDK.data.codeToMicrovolts(rawPeak, { gain, vrefVolts });
                diagnostics.filteredTonePeakUv = SDK.data.codeToMicrovolts(filteredPeak, { gain, vrefVolts });
                diagnostics.beforeSeriesCorrectionKohm = SDK.impedance.impedanceKohmFromPeakCodes(filteredPeak, { ...estimator.options, seriesOhms: 0 });
            }
            await audit('impedance_measure_failed', { channel, error: error.message, diagnostics }, 'error');
            throw error;
        } finally {
            try {
                await stopEegOnDevice();
                state.eegRunning = false;
                state.impedanceMode = false;
                if (state.processor) { state.processor.impedance = null; state.processor.reset(); }
                await new Promise(resolve => setTimeout(resolve, 150));
                await applyChannel(channel, false);
            } catch (error) {
                const stopped = !state.impedanceMode;
                const message = stopped ? '采集已停止，但恢复脑电配置失败；开始采集时将重新配置' : '停止尚未确认，请先重试停止';
                $('metric-impedance-state').textContent = measurementError ? `检测失败：${measurementError.message}；${message}` : message;
                logProtocol('ERR', error.message, 'error');
                await audit('impedance_cleanup_failed', { channel, stopped, error: error.message }, 'error');
                throw measurementError ? new Error(`${measurementError.message}；${message}：${error.message}`) : error;
            } finally { state.impedanceBusy = false; state.impedanceDiagnostics = null; state.cancelImpedanceWaiter = null; updateEegUi(); renderNextAction(); }
        }
    }

    const LIGHT_MAX_ATTEMPTS = 3;
    const LIGHT_RETRY_DELAY_MS = 150;

    function delay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    // Serialize the complete configure/start/stop transaction for each light
    // source. A state check alone is not atomic when a model result and a
    // manual/plan action arrive in the same event loop turn.
    function withLightLease(task) {
        const previous = state.lightLeasePromise;
        let release;
        state.lightLeasePromise = new Promise(resolve => { release = resolve; });
        return previous.catch(() => {}).then(task).finally(() => release());
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
                        const error = new Error(`光照 CH${channel} 状态校验失败：期望 ${expectedRunning ? '运行' : '停止'}，实际 ${actualRunning ? '运行' : '停止'}`);
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
        throw lastError || new Error(`光照 CH${channel} ${operation}失败`);
    }

    async function configureLight(channel, config, context = {}) {
        if (channel === 3) {
            for (const output of [1, 2]) await configureLight(output, config, context);
            return;
        }
        await runLightOperation('configure', channel, () => requireClient().setLightConfig(channel, config), {
            context, detail: { frequencyHz: config.frequencyHz, durationMs: config.durationMs, powerPercent: config.powerPercent },
        });
        await audit('light_configured', { channel, ...config, ...lightContext(context) });
        addActivity(`光照 CH${channel}：${config.frequencyHz}Hz / ${config.powerPercent}%`);
    }

    async function startLight(channel, context = {}) {
        if (channel === 3) {
            for (const output of [1, 2]) await startLight(output, context);
            return;
        }
        await runLightOperation('start', channel, () => requireClient().startLight(channel), {
            context, expectedRunning: true,
        });
        await audit('light_started', { channel, verified: true, ...lightContext(context) });
        addActivity(`光照 CH${channel} 已启动`);
    }

    async function stopLight(channel, context = {}) {
        if (channel === 3) {
            const failures = [];
            // Attempt both stops even if the first output does not respond.
            for (const output of [1, 2]) {
                try { await stopLight(output, context); }
                catch (error) { failures.push(error); }
            }
            if (failures.length) throw new AggregateError(failures, '全部通道停止未完全确认');
            return;
        }
        if (!state.connected) {
            const error = new Error(`设备未连接，无法停止光照 CH${channel}`);
            await audit('light_stop_failed', { channel, ...lightContext(context), error: error.message }, 'error');
            throw error;
        }
        await runLightOperation('stop', channel, () => requireClient().stopLight(channel), {
            context, expectedRunning: false,
        });
        await audit('light_stopped', { channel, verified: true, ...lightContext(context) });
        if (!context.quiet) addActivity(`光照 CH${channel} 已停止`);
    }

    async function performSafeStop(reason = 'manual') {
        state.cancelImpedanceWaiter?.();
        clearManualLightTracking();
        planEngine.stopRelative(reason);
        await disableSleepStimulus(reason, false);
        if (!state.connected) {
            for (const channel of [1, 2]) await audit('light_stop_failed', { channel, source: 'safe_stop', reason, error: '设备未连接，无法发送停止命令' }, 'error');
            if (state.activeSession) await finishSession('interrupted', reason);
            await audit('safe_stop_incomplete', { reason, error: '设备未连接，无法确认硬件最终状态' }, 'error');
            return;
        }
        const failures = await withLightLease(async () => {
            const output = [];
            for (const channel of [1, 2]) {
                try { await stopLight(channel, { source: 'safe_stop', reason, quiet: true }); }
                catch (error) { output.push({ channel, error: error.message }); logProtocol('ERR', `停止光照 CH${channel}：${error.message}`, 'error'); }
            }
            return output;
        });
        try {
            await stopEegOnDevice();
            state.eegRunning = false;
            state.impedanceMode = false;
            if (state.activeSession) await finishSession('interrupted', reason);
        } catch (error) {
            failures.push({ operation: 'eeg_stop_or_save', error: error.message });
            logProtocol('ERR', `停止采集或保存失败：${error.message}`, 'error');
        }
        updateEegUi();
        addActivity(failures.length ? '停止未完全确认，请重试' : '光照和采集已停止');
        if (failures.length) {
            toast('停止或保存未完成，请检查设备和磁盘后重试。', 'error');
            await audit('safe_stop_incomplete', { reason, failures }, 'error');
        }
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
        state.sessionFinishPromise = null;
        state.recordingWriteError = null;
        state.sessionStartedAt = performance.now();
        state.activeSession = await window.desktopAPI.startSession({
            id,
            planId: plan?.id || '',
            planName: plan?.name || '手动采集',
            planSnapshot: plan || null,
            deviceId: state.deviceInfo?.deviceId ? Core.bytesToHex(state.deviceInfo.deviceId) : (state.transport?.id || ''),
            selectedChannel: state.selectedChannel,
            sampleRateHz: 250,
            appVersion: '0.6.1',
            rawStorageVersion: 1,
        });
        updateEegUi();
        return state.activeSession;
    }

    function handleEegFrame(result, frame) {
        state.lastEegReceivedAt = Date.now();
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
        if (state.eegRunning && !state.impedanceMode) handleRealtimeSleepSample(modelFilteredMicrovolts, { seqGap, rawCode });
        if (state.waveform.length > state.waveformMax) state.waveform.splice(0, state.waveform.length - state.waveformMax);
        state.drawDirty = true;
        if (state.activeSession && !state.impedanceMode) {
            state.edfQueue.push({ rawCode, seq: result.seq, elapsedMs: Math.max(0, performance.now() - state.sessionStartedAt) });
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
        if (state.impedanceMode && state.impedanceDiagnostics) {
            const d = state.impedanceDiagnostics;
            d.received++;
            d.rawWindow[(d.received - 1) % 1024] = rawCode;
            d.maxAbsRaw = Math.max(d.maxAbsRaw, Math.abs(rawCode));
            if (Math.abs(rawCode) >= 0.99 * 8388607) { d.saturated++; d.cleanSamples = 0; }
            else d.cleanSamples = delta === 1 ? d.cleanSamples + 1 : 1;
            d.longestCleanRun = Math.max(d.longestCleanRun, d.cleanSamples);
            if (result.impedanceKohm) { d.windows++; d.lastKohm = result.impedanceKohm[channelIndex]; }
            if (result.impedanceKohm && d.cleanSamples >= 1024) state.impedanceWaiter?.(result.impedanceKohm);
        }
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
            .then(() => state.recordingWriteError ? undefined : window.desktopAPI.appendSessionSamples(sessionId, samples))
            .catch(error => {
                state.recordingWriteError = error;
                logProtocol('ERR', `EDF 写入失败：${error.message}`, 'error');
                toast('数据保存失败，正在停止采集；请检查磁盘空间。', 'error');
                // finishSession waits for this flush. Awaiting safeStop here
                // would make the two promises wait forever for each other.
                queueMicrotask(() => { void safeStop('edf_write_failed').catch(stopError => {
                    logProtocol('ERR', `保存失败后的停止未完成：${stopError.message}`, 'error');
                }); });
            });
        return state.edfFlushPromise;
    }

    async function finishSession(status, reason) {
        if (state.sessionFinishPromise) return state.sessionFinishPromise;
        if (!state.activeSession) return;
        const session = state.activeSession;
        state.sessionFinishPromise = (async () => {
            await flushEdfQueue();
            await state.edfFlushPromise;
            await state.sessionEventPromise;
            const result = await window.desktopAPI.stopSession(session.id,
                state.recordingWriteError ? 'failed' : status,
                state.recordingWriteError ? 'edf_write_failed' : reason);
            state.activeSession = null;
            updateEegUi();
            await loadSessions();
            if (result) addActivity(state.recordingWriteError ? '保存中断，已保留可用数据，请检查磁盘。'
                : `记录已保存：${result.rows} 样本 · ${result.rawDataFile ? '完整精度原始记录 + EDF' : 'EDF'}`);
        })().finally(() => { state.sessionFinishPromise = null; });
        return state.sessionFinishPromise;
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
        case 'light_stop':
            if (!manualStimulusSourceAvailable()) throw new Error('当前控制方式不包含手动 / 方案光照');
            await withLightLease(async () => {
                if (action.type === 'light_start') {
                    await preemptSleepStimulus('时间方案刺激开始');
                    if (state.lightRunning[1] || state.lightRunning[2]) throw new Error('已有光照运行，方案动作未启动');
                    await configureLight(action.lightChannel || 1, action.light, context);
                    await startLight(action.lightChannel || 1, context);
                } else if (state.sleepStimulusActiveChannel === 3 || state.sleepStimulusActiveChannel === (action.lightChannel || 1)) {
                    await preemptSleepStimulus('时间方案停止刺激');
                } else {
                    await stopLight(action.lightChannel || 1, context);
                }
            });
            break;
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
        if (event.phase === 'startup-baseline') {
            void audit('plan_startup_baseline', {
                planId: event.plan.id,
                actionIds: event.actionIds,
                reason: event.reason,
                aborted: event.aborted,
            });
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

    function formatClockTime(time) {
        const value = String(time || '--:--:--');
        return value.length >= 8 ? value.slice(0, 8) : value;
    }

    function formatScheduledDateTime(date) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '--:--:--';
        const now = new Date();
        const dayDelta = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
            - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000);
        const day = dayDelta === 0 ? '今天' : dayDelta === 1 ? '明天' : `${date.getMonth() + 1}月${date.getDate()}日`;
        return `${day} ${formatClockTime(date.toTimeString().slice(0, 8))}`;
    }

    function renderNextAction() {
        const selectablePlans = state.plans.filter(plan => plan.enabled);
        const relativeSelect = $('relative-plan-select');
        const previousSelection = relativeSelect.value;
        relativeSelect.innerHTML = selectablePlans.length
            ? selectablePlans.map(plan => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)} · ${plan.mode === 'relative' ? '相对时间' : '每日定时'} · CH${plan.eegChannel}</option>`).join('')
            : '<option value="">暂无可用方案</option>';
        const relativeRun = planEngine.getRelativeStatus();
        if (relativeRun) relativeSelect.value = relativeRun.planId;
        else if (selectablePlans.some(plan => plan.id === previousSelection)) relativeSelect.value = previousSelection;
        relativeSelect.title = '这里只选择要立即运行的方案，不会改变每日定时计划';
        relativeSelect.disabled = Boolean(relativeRun) || selectablePlans.length === 0;
        $('relative-plan-toggle').disabled = relativeRun ? false : (!state.connected || selectablePlans.length === 0);
        $('relative-plan-toggle').textContent = relativeRun ? '停止方案' : '立即运行';
        $('relative-plan-toggle').className = `button ${relativeRun ? 'danger' : 'success'}`;

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
        const manualLightAllowed = manualStimulusSourceAvailable();
        const actionLabel = action => {
            return ACTION_LABELS[action?.type] || action?.type || '方案动作';
        };
        const dailySource = plan => `每日方案「${plan.name}」`;
        const runSource = plan => {
            const sourcePlan = state.plans.find(item => item.id === relativeRun?.planId);
            return sourcePlan ? `立即运行方案「${sourcePlan.name}」` : `相对方案「${plan.name}」`;
        };
        const operationIsActive = operation.operation !== 'idle' && operation.operation !== 'unknown';

        if (relativeRun) {
            const next = relativeRun.nextAction;
            if (currentAction || operationIsActive) {
                const active = currentAction ? actionLabel(currentAction.action) : operation.label;
                const detail = currentAction ? `${runSource(currentAction.plan)} · 当前动作` : `手动操作 · ${operation.detail}`;
                $('next-action').innerHTML = `<span class="time">正在执行 · 已运行 +${formatRelativeElapsed(relativeRun.elapsedSeconds)}</span><strong>${escapeHtml(active)}</strong><small>${escapeHtml(detail)}${next ? ` · 下一动作：${escapeHtml(actionLabel(next))} · 第 ${(next.offsetSeconds / 60).toFixed(1)} 分钟` : ''}</small>`;
            } else {
                $('next-action').innerHTML = `<span class="time">相对方案进行中 · 已运行 +${formatRelativeElapsed(relativeRun.elapsedSeconds)}</span><strong>${escapeHtml(next ? actionLabel(next) : '正在结束')}</strong><small>${escapeHtml(runSource(relativeRun.plan))}${next ? ` · 第 ${(next.offsetSeconds / 60).toFixed(1)} 分钟` : ''} · 当前设备：${escapeHtml(operation.label)}</small>`;
            }
            return;
        }

        const candidates = state.plans.filter(plan => plan.enabled && plan.mode !== 'relative').flatMap(plan =>
            (plan.actions || [])
                .filter(action => manualLightAllowed || (action.type !== 'light_start' && action.type !== 'light_stop'))
                .map(action => ({ plan, action, date: nextDateForTime(action.time) })));
        candidates.sort((a, b) => a.date - b.date);
        const next = candidates[0];
        if (currentAction || operationIsActive) {
            const active = currentAction ? actionLabel(currentAction.action) : operation.label;
            const detail = currentAction ? `${dailySource(currentAction.plan)} · 当前动作` : `手动操作 · ${operation.detail}`;
            $('next-action').innerHTML = `<span class="time">当前设备操作</span><strong>${escapeHtml(active)}</strong><small>${escapeHtml(detail)}${next ? ` · 下次执行：${escapeHtml(formatScheduledDateTime(next.date))} · ${escapeHtml(actionLabel(next.action))}` : ''}</small>`;
        } else {
            $('next-action').innerHTML = next
                ? `<span class="time">下次执行 · ${escapeHtml(formatScheduledDateTime(next.date))}</span><strong>${escapeHtml(actionLabel(next.action))}</strong><small>来源：${escapeHtml(dailySource(next.plan))} · CH${next.plan.eegChannel} · 当前设备：${escapeHtml(operation.label)}</small>`
                : '<span class="time">暂无下次执行</span><strong>没有启用的每日定时方案</strong><small>“立即运行选择”只用于马上启动，不会改变每日调度</small>';
        }
    }

    function renderPlans() {
        const list = $('plan-list');
        if (!state.plans.length) {
            list.innerHTML = '<div class="empty-state">尚未创建方案。新建一个默认不发光的纯 EEG 采集时间轴；需要时再手动添加光照动作。</div>';
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
            { id: Core.makeId('action'), time: at(4), type: 'eeg_stop' },
        ];
    }

    function openPlanDialog(plan = null) {
        $('plan-manager-dialog')?.close();
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
                    <label class="action-parameter"><span>频率 (Hz)</span><input class="action-frequency" type="number" min="1" max="100" value="${action.light?.frequencyHz ?? 10}" aria-label="光照频率 Hz"></label>
                    <label class="action-parameter fixed"><span>时间 (ms，固定)</span><input class="action-duration" type="number" value="0" readonly aria-readonly="true" aria-label="光照时间固定为 0 ms"></label>
                    <label class="action-parameter"><span>功率/占空比 (%)</span><input class="action-power" type="number" min="0" max="100" value="${action.light?.powerPercent ?? 5}" aria-label="光照功率或占空比百分比"></label>
                </div>`
                : '<span></span>';
            const scheduleInput = state.planEditingMode === 'relative'
                ? `<input class="action-offset-minutes" type="number" min="0" step="0.1" value="${Number(action.offsetSeconds || 0) / 60}" title="方案开始后的分钟数">`
                : `<input class="action-time" type="time" step="1" value="${escapeHtml(action.time || '12:00:00')}" title="本机时间">`;
            return `<div class="action-row" data-index="${index}">
                ${scheduleInput}
                <select class="action-type">${Core.ACTION_TYPES.map(type => `<option value="${type}" ${type === action.type ? 'selected' : ''}>${ACTION_LABELS[type]}</option>`).join('')}</select>
                <select class="action-light-channel" disabled aria-readonly="true" aria-label="光照通道固定为 CH2" title="方案光照通道固定为 CH2"><option value="2" selected>光 CH2（固定）</option></select>
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

    function githubUploadPresentation(session) {
        const upload = session?.githubUpload;
        const status = String(upload?.status || 'not_uploaded');
        const labels = {
            not_uploaded: ['未上传', 'off'],
            not_applicable: ['无刺激', 'off'],
            not_configured: ['待配置', 'off'],
            disabled: ['自动关闭', 'off'],
            queued: ['排队中', 'pending'],
            uploading: ['上传中', 'pending'],
            uploaded: ['已上传', 'success'],
            failed: ['失败', 'error'],
        };
        const [label, tone] = labels[status] || [status, 'off'];
        const fileKinds = Array.isArray(upload?.files) ? upload.files.map(file => file.kind === 'events' ? 'events' : 'EDF') : [];
        const detail = [upload?.repository, upload?.path, fileKinds.length ? fileKinds.join('+') : null, upload?.error].filter(Boolean).join(' · ');
        return { label, tone, detail };
    }

    function renderGithubSync() {
        const panel = $('github-sync-panel');
        if (!panel) return;
        const sync = state.githubSync || {};
        const config = sync.config || {};
        const repository = $('github-repository');
        const branch = $('github-branch');
        const directory = $('github-directory');
        const autoUpload = $('github-auto-upload');
        if (repository && document.activeElement !== repository) repository.value = config.repository || 'Jaycob-jh/EEG_tls_Upper';
        if (branch && document.activeElement !== branch) branch.value = config.branch || 'main';
        if (directory && document.activeElement !== directory) directory.value = config.directory || 'data/edf';
        if (autoUpload) autoUpload.checked = config.autoUploadStimulated !== false;
        const status = $('github-sync-status');
        if (status) {
            if (sync.tokenStored && sync.encryptionAvailable === false) status.textContent = '安全存储不可用';
            else if (sync.tokenStored) status.textContent = '已配置令牌';
            else status.textContent = '未配置';
        }
        const queue = (sync.queue || []).filter(item => item.status !== 'uploaded');
        const queueNode = $('github-sync-queue');
        if (queueNode) {
            if (!queue.length) queueNode.textContent = sync.tokenStored
                ? '暂无待上传记录；历史记录不会在启动时自动上传。'
                : '尚未配置令牌；保存并测试私有仓库后才会启用自动归档。';
            else queueNode.textContent = `待处理 ${queue.length} 条记录：${queue.map(item => `${item.sessionId}（${item.status}${Array.isArray(item.files) && item.files.some(file => file.kind === 'events') ? '，EDF+events' : '，EDF'}）`).join('、')}`;
        }
    }

    async function loadGithubSync() {
        state.githubSync = await window.desktopAPI.getGithubSyncConfig();
        renderGithubSync();
    }

    async function loadSessions() {
        state.sessions = await window.desktopAPI.listSessions();
        const body = $('record-list');
        if (!state.sessions.length) {
            body.innerHTML = '<tr><td colspan="9"><div class="empty-state">暂无采集记录</div></td></tr>';
            return;
        }
        body.innerHTML = state.sessions.map(session => `<tr>
            <td>${escapeHtml(formatDateTime(session.startedAt))}</td><td>CH${session.selectedChannel}</td><td>${escapeHtml(session.planName || '手动采集')}</td>
            <td>${Number(session.rows || 0).toLocaleString()}</td><td title="${recordingSampleRate(session)} Hz 有效数据">${Core.formatDuration(sessionDurationSeconds(session))}</td><td>${session.storageFormat === 'EDF' ? 'EDF' : 'CSV（旧版）'}</td><td><span class="state-badge ${session.status === 'completed' ? '' : 'off'}">${({ completed: '已完成', recording: '采集中', interrupted: '已中断', failed: '失败', error: '出错' })[session.status] || '已停止'}</span></td>
            ${(() => { const upload = githubUploadPresentation(session); return `<td><span class="github-upload-badge ${upload.tone}" title="${escapeHtml(upload.detail)}">${escapeHtml(upload.label)}</span></td>`; })()}
            <td><button class="button text analyze-session" data-session-id="${escapeHtml(session.id)}">查看分析</button><button class="button text upload-session-github" data-session-id="${escapeHtml(session.id)}">备份记录</button><button class="button text reveal-session" data-directory="${escapeHtml(session.directory)}">打开文件夹</button></td>
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
            realtime: ['SLEEP STAGING', '实时分期'],
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
        $('realtime-history-mode').addEventListener('change', renderSleepHistory);
        $('simple-manual-light').addEventListener('click', () => selectedLightMode() === 'manual' ? openSleepStimulusSettings() : openManualStimulusSettings());
        $('connect-button').addEventListener('click', () => runUiTask(connectBle));
        $('simple-n3-toggle').addEventListener('click', () => runUiTask(() => selectedLightMode() === 'manual'
            ? state.manualLightChannel ? stopManualLight(state.manualLightChannel, { source: 'manual_home', reason: 'manual_stop' })
                : startManualLight(Number($('home-light-channel').value), homeLightConfigFromInputs(), { source: 'manual_home' })
            : toggleSimpleN3()));
        $('simple-n3-settings').addEventListener('click', () => runUiTask(async () => {
            if (selectedLightMode() === 'manual') return openManualStimulusSettings();
            if (!modelStimulusSourceAvailable()) await changeStimulusControlMode('model');
            openSleepStimulusSettings();
        }));
        $('advanced-plan-manager').addEventListener('click', openHomePlanManager);
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
        $('eeg-toggle-button').addEventListener('click', () => runUiTask(() => state.eegRunning || state.activeSession || state.impedanceMode || state.eegStopError ? stopEeg('manual') : startEeg()));
        $('impedance-button').addEventListener('click', () => runUiTask(() => measureImpedance()));
        $('status-button').addEventListener('click', () => runUiTask(queryStatus));
        $('safe-stop-button').addEventListener('click', () => runUiTask(() => safeStop('manual')));
        $('relative-plan-toggle').addEventListener('click', () => runUiTask(toggleRelativePlan));
        $('new-plan-button').addEventListener('click', () => openPlanDialog());
        $('stimulus-control-mode').addEventListener('change', event => runUiTask(() => changeStimulusControlMode(event.target.value)));
        $('stimulus-open-settings').addEventListener('click', () => openStimulusSettingsForMode());
        $('manual-stimulus-settings-close').addEventListener('click', () => $('manual-stimulus-settings-dialog').close());
        $('manual-stimulus-settings-dialog').addEventListener('click', event => {
            if (event.target === event.currentTarget) event.currentTarget.close();
        });
        $('manual-open-plan-manager').addEventListener('click', openHomePlanManager);
        $('plan-manager-dialog-close').addEventListener('click', () => $('plan-manager-dialog').close());
        $('plan-manager-dialog').addEventListener('click', event => {
            if (event.target === event.currentTarget) event.currentTarget.close();
        });
        $('combined-stimulus-settings-close').addEventListener('click', () => $('combined-stimulus-settings-dialog').close());
        $('combined-stimulus-settings-dialog').addEventListener('click', event => {
            if (event.target === event.currentTarget) event.currentTarget.close();
        });
        $('combined-model-settings').addEventListener('click', openSleepStimulusSettings);
        $('combined-manual-settings').addEventListener('click', openManualStimulusSettings);
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
        $('github-save-button').addEventListener('click', () => runUiTask(async () => {
            const result = await window.desktopAPI.saveGithubSyncConfig({
                config: {
                    repository: $('github-repository').value,
                    branch: $('github-branch').value,
                    directory: $('github-directory').value,
                    autoUploadStimulated: $('github-auto-upload').checked,
                },
                token: $('github-token').value,
            });
            state.githubSync = result;
            $('github-token').value = '';
            renderGithubSync();
            toast(result.tokenStored ? 'GitHub 设置已保存；请测试私有仓库连接' : 'GitHub 设置已保存，但尚未配置令牌', result.tokenStored ? 'info' : 'error');
        }));
        $('github-test-button').addEventListener('click', () => runUiTask(async () => {
            const result = await window.desktopAPI.testGithubSync();
            state.githubSync = result;
            renderGithubSync();
            toast(result.message || 'GitHub 连接正常');
        }));
        $('github-history-button').addEventListener('click', () => runUiTask(async () => {
            const candidates = await window.desktopAPI.getGithubHistoryCandidates();
            const pending = candidates.filter(candidate => !candidate.alreadyUploaded);
            if (!pending.length) {
                toast(candidates.length ? '前几天的 EDF 已经同步，或没有可上传的历史 EDF' : '没有找到今天以前的已完成 EDF', 'info');
                return;
            }
            const dates = [...new Set(pending.map(candidate => candidate.date))].join('、');
            const eventsCount = pending.filter(candidate => candidate.hasEvents).length;
            const confirmed = window.confirm(`将同步 ${pending.length} 条今天以前的 EEG 记录（${dates}）。其中 ${eventsCount} 条包含可用 events，将与 EDF 一并上传。原始脑电 只会进入私有 GitHub 仓库，是否继续？`);
            if (!confirmed) return;
            const result = await window.desktopAPI.uploadGithubHistory({ sessionIds: pending.map(candidate => candidate.id) });
            state.githubSync = result;
            renderGithubSync();
            await loadSessions();
            const notConfigured = (result.statuses || []).filter(item => item.status?.status === 'not_configured').length;
            toast(notConfigured ? `已登记 ${result.selectedCount} 条记录，但请先配置 GitHub 令牌` : `已将 ${result.selectedCount} 条历史记录加入上传队列` , notConfigured ? 'error' : 'info');
        }));
        $('github-retry-button').addEventListener('click', () => runUiTask(async () => {
            state.githubSync = await window.desktopAPI.retryGithubUploads();
            renderGithubSync();
            await loadSessions();
            toast('已重试待上传 EDF 和 events');
        }));
        window.desktopAPI.onGithubSyncStatus(status => {
            state.githubSync = status;
            renderGithubSync();
            void loadSessions();
        });
        $('record-list').addEventListener('click', event => {
            const analyze = event.target.closest('.analyze-session');
            if (analyze) {
                window.desktopAPI.openAnalysisWindow(analyze.dataset.sessionId)
                    .catch(error => toast(error.message, 'error'));
                return;
            }
            const upload = event.target.closest('.upload-session-github');
            if (upload) {
                void runUiTask(async () => {
                    await window.desktopAPI.uploadSessionToGithub(upload.dataset.sessionId);
                    await loadSessions();
                    toast('EDF 和 events 已加入 GitHub 上传队列');
                });
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
        $('sleep-stimulus-settings-close').addEventListener('click', () => $('sleep-stimulus-settings-dialog').close());
        $('sleep-stimulus-settings-dialog').addEventListener('click', event => {
            if (event.target === event.currentTarget) event.currentTarget.close();
        });
        $('sleep-stimulus-n3-enabled').addEventListener('change', () => renderSleepStimulusTriggerFields());
        $('sleep-stimulus-n3-mode').addEventListener('change', () => renderSleepStimulusTriggerFields());
        $('home-light-start').addEventListener('click', () => runUiTask(() => startManualLight(Number($('home-light-channel').value), homeLightConfigFromInputs(), { source: 'manual_home' })));
        $('home-light-stop').addEventListener('click', () => runUiTask(() => stopManualLight(Number($('home-light-channel').value), { source: 'manual_home', reason: 'home_manual_stop' })));
        $('light-config-button').addEventListener('click', () => runUiTask(() => configureLight(Number($('light-channel').value), lightConfigFromInputs(), { source: 'manual_debug' })));
        $('light-start-button').addEventListener('click', () => runUiTask(() => startManualLight(Number($('light-channel').value), null, { source: 'manual_debug' })));
        $('light-stop-button').addEventListener('click', () => runUiTask(() => stopManualLight(Number($('light-channel').value), { source: 'manual_debug', reason: 'debug_manual_stop' })));
        $('clear-log-button').addEventListener('click', () => { $('protocol-log').innerHTML = ''; });
        window.addEventListener('beforeunload', () => {
            planEngine.stopRelative('application_exit');
            planEngine.stop();
            if (state.relativePlanRefreshTimer) clearInterval(state.relativePlanRefreshTimer);
            if (state.streamMetricsTimer) clearInterval(state.streamMetricsTimer);
            if (state.sleepStimulusStopTimer) clearTimeout(state.sleepStimulusStopTimer);
            void flushEdfQueue();
        });
    }

    function lightConfigFromInputs() {
        return {
            frequencyHz: Number($('light-frequency').value),
            durationMs: Number($('light-duration').value),
            powerPercent: Number($('light-power').value),
        };
    }

    function homeLightConfigFromInputs() {
        return {
            frequencyHz: Number($('home-light-frequency').value),
            durationMs: Number($('home-light-duration').value) * 1000,
            powerPercent: Number($('home-light-power').value),
        };
    }

    function validateManualLightConfig(config) {
        if (!(config.frequencyHz >= 1 && config.frequencyHz <= 100)) throw new Error('光照频率必须为 1~100 Hz');
        if (!Number.isFinite(config.durationMs) || !(config.durationMs >= 1 && config.durationMs <= 3600000)) throw new Error('手动光照时长必须大于 0，且不超过 3600 秒');
        if (!(config.powerPercent >= 0 && config.powerPercent <= 100)) throw new Error('光照功率必须为 0~100%');
        return {
            frequencyHz: Math.round(config.frequencyHz),
            durationMs: Math.round(config.durationMs),
            powerPercent: Math.round(config.powerPercent),
        };
    }

    function clearManualLightTracking() {
        if (state.manualLightStopTimer) clearTimeout(state.manualLightStopTimer);
        state.manualLightStopTimer = null;
        state.manualLightChannel = null;
        state.manualLightUntil = 0;
    }

    async function startManualLight(channel, config = null, context = {}) {
        return withLightLease(async () => {
            if (!manualStimulusSourceAvailable()) throw new Error('当前控制方式不包含手动 / 方案光照');
            requireClient();
            const normalizedConfig = config ? validateManualLightConfig(config) : null;
            if (state.sleepStimulusActiveChannel) await preemptSleepStimulus('手动光照请求');
            if (state.lightRunning[1] || state.lightRunning[2]) throw new Error('已有光照运行，请先停止后再启动');
            if (state.sleepStimulusProtocol.enabled) await disableSleepStimulus('切换为手动光照', false);
            try {
                if (normalizedConfig) await configureLight(channel, normalizedConfig, context);
                await startLight(channel, context);
            } catch (error) {
                try { await stopLight(channel, { ...context, quiet: true, reason: 'manual_start_failed' }); }
                catch (stopError) { await audit('manual_light_stop_unconfirmed', {channel,error:stopError.message}, 'error'); }
                throw error;
            }
            state.manualLightChannel = channel;
            preferLightMode('manual');
            state.manualLightUntil = normalizedConfig ? Date.now() + normalizedConfig.durationMs : 0;
            const activeUntil = state.manualLightUntil;
            if (normalizedConfig) state.manualLightStopTimer = setTimeout(() => {
                if (state.manualLightChannel !== channel || state.manualLightUntil !== activeUntil) return;
                void runUiTask(() => stopManualLight(channel, { source: 'manual_home', reason: 'duration_elapsed', quiet: true }));
            }, normalizedConfig.durationMs);
            renderStimulusSources();
            renderSimpleWorkflow();
        });
    }

    async function stopManualLight(channel, context = {}) {
        return withLightLease(async () => {
            requireClient();
            channel = state.manualLightChannel || channel;
            if (state.sleepStimulusActiveChannel) {
                await preemptSleepStimulus('手动停止');
                await disableSleepStimulus('手动停止', false);
                return;
            }
            await stopLight(channel, context);
            clearManualLightTracking();
            renderStimulusSources();
            renderSimpleWorkflow();
        });
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
        const report = { startedAt: Core.formatLocalIso(), appVersion: '0.6.1', sdkVersion: SDK.VERSION, success: false };
        try {
            if (!await connectBle()) throw new Error('BLE connection failed');
            report.device = {
                name: state.transport.name, id: state.transport.id,
                protocolVersion: state.deviceInfo?.protocolVersion,
                deviceIdHex: state.deviceInfo?.deviceId ? Core.bytesToHex(state.deviceInfo.deviceId) : null,
                actionCount: state.deviceInfo?.actionCount,
                actions: state.deviceInfo?.actions,
                compatibilityMode: state.deviceInfo?.compatibilityMode,
                capabilityDiscoveryComplete: state.deviceInfo?.capabilityDiscoveryComplete,
                capabilityWarnings: state.deviceInfo?.capabilityWarnings,
            };
            if (state.deviceInfo?.capabilityDiscoveryComplete && state.deviceInfo?.actionCount !== 9) {
                throw new Error(`Expected 9 actions, got ${state.deviceInfo?.actionCount}`);
            }
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

    function renderHistoryReplay(status) {
        $('history-replay-start').disabled = Boolean(status.running);
        $('history-replay-cancel').hidden = !status.running;
        $('history-replay-open').disabled = Boolean(status.running || !status.output);
        const phases = { read: '读取记录', replay: '重算实时分期', yasa: 'YASA 重新分期', record_complete: '已完成' };
        if (status.running) $('history-replay-status').textContent = `${phases[status.phase] || '准备中'} · ${status.index || 0} / ${status.total || '--'} 条${status.epochs ? ` · 当前 ${status.epochs} 个片段` : ''}`;
        else if (status.phase === 'error') $('history-replay-status').textContent = `回放失败：${status.error}`;
        else if (status.phase === 'cancelled') $('history-replay-status').textContent = '已停止回放，可查看已完成的部分。';
        else if (status.phase === 'done') $('history-replay-status').textContent = `已完成 ${status.records} 条 · ${Number(status.hours).toFixed(1)} 小时数据 · 用时 ${Math.round(status.seconds)} 秒${status.failures ? ` · ${status.failures} 条失败，见报告` : ''}。全程未开灯。`;
        else if (status.output) $('history-replay-status').textContent = '已有回放报告。修改光照条件后，可以再次回放。';
    }

    async function init() {
        if (!SDK || !Core || !Sleep) throw new Error('BrainLume SDK 或实时分期模块加载失败');
        populateChannelSelects();
        setupNavigation();
        setupBleChooser();
        setupEvents();
        try {
            const saved = JSON.parse(localStorage.getItem('manualLightSettings') || 'null');
            if (saved && [1, 2, 3].includes(saved.channel)) {
                const config = validateManualLightConfig(saved);
                $('home-light-channel').value = String(saved.channel);
                $('home-light-frequency').value = String(config.frequencyHz);
                $('home-light-power').value = String(config.powerPercent);
                $('home-light-duration').value = String(config.durationMs / 1000);
            }
        } catch (_) { /* Invalid saved settings fall back to the existing defaults. */ }
        for (const id of ['home-light-channel', 'home-light-frequency', 'home-light-power', 'home-light-duration']) {
            $(id).addEventListener('change', () => {
                try {
                    const config = validateManualLightConfig(homeLightConfigFromInputs());
                    localStorage.setItem('manualLightSettings', JSON.stringify({ ...config, channel: Number($('home-light-channel').value) }));
                } catch (_) { /* Validation remains visible when the user starts output. */ }
                renderSimpleWorkflow();
            });
        }
        $('history-replay-start').addEventListener('click', () => runUiTask(async () => {
            renderHistoryReplay(await window.desktopAPI.startHistoryReplay(state.sleepStimulusProtocol));
        }));
        $('history-replay-cancel').addEventListener('click', () => runUiTask(() => window.desktopAPI.cancelHistoryReplay()));
        $('history-replay-open').addEventListener('click', () => runUiTask(() => window.desktopAPI.openHistoryReplayReport()));
        window.desktopAPI.onHistoryReplayProgress(renderHistoryReplay);
        renderHistoryReplay(await window.desktopAPI.getHistoryReplayStatus());
        updateConnectionUi();
        updateEegUi();
        await setupRealtimeSleep();
        startWaveformLoop();
        // Keep old plans on disk for historical records, but do not load or run
        // the legacy scheduler in the N3-only workflow.
        await Promise.all([loadSessions(), loadGithubSync()]);
        state.streamMetricsTimer = setInterval(() => {
            updateStreamMetricsUi();
            renderLiveStatus();
            if (state.activeSession) updateEegUi();
        }, 500);
        await audit('app_started', { version: '0.6.1', sdkVersion: SDK.VERSION });
        if (window.desktopAPI.getLaunchMode() === 'device-diagnostic') {
            $('header-status').textContent = 'PRESS ANY KEY TO DIAGNOSE';
            window.addEventListener('keydown', () => runDeviceDiagnostic(), { once: true });
        }
    }

    init().catch(error => {
        document.body.innerHTML = `<pre style="padding:24px;color:#a00">应用初始化失败\n${escapeHtml(error.stack || error.message)}</pre>`;
    });
}());
