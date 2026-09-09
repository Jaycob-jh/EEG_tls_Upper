(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.BrainLumeDesktopCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ACTION_TYPES = Object.freeze([
        'impedance_check', 'eeg_start', 'eeg_stop',
        'light_start', 'light_stop', 'status_query',
    ]);
    const PLAN_MODES = Object.freeze(['clock', 'relative']);
    const STIMULUS_CONTROL_MODES = Object.freeze(['manual', 'model', 'both']);
    const STIMULUS_CONTROL_MODE_LABELS = Object.freeze({
        manual: '手动 / 方案',
        model: '模型判别',
        both: '手动 / 方案 + 模型',
    });
    const STIMULUS_CONTROL_MODE_PRESENTATION = Object.freeze({
        manual: Object.freeze({
            manualVisible: true,
            modelVisible: false,
            detail: '当前只显示手动启动和固定时间方案；实时模型不会触发光刺激。',
        }),
        model: Object.freeze({
            manualVisible: false,
            modelVisible: true,
            detail: '当前只显示实时模型触发；EEG 采集方案仍可运行，方案中的光刺激动作会被安全跳过。',
        }),
        both: Object.freeze({
            manualVisible: true,
            modelVisible: true,
            detail: '手动/方案与实时模型均可触发；系统仍会阻止同一时刻重复发光。',
        }),
    });
    const START_GRACE_SECONDS = 5;
    const SAFETY_ACTIONS = new Set(['light_stop', 'eeg_stop']);
    const DAILY_START_ACTIONS = new Set(['light_start', 'eeg_start']);
    const FIXED_PLAN_EEG_CHANNEL = 2;
    const FIXED_PLAN_LIGHT_CHANNEL = 2;
    const WAVEFORM_X_RANGES_SECONDS = Object.freeze([5, 10, 20, 30, 60]);
    const WAVEFORM_REFRESH_RATES_FPS = Object.freeze([10, 30, 60]);
    const EEG_SEQUENCE_MODULUS = 0x10000;
    const EEG_MAX_FORWARD_DELTA = EEG_SEQUENCE_MODULUS / 2;
    const EEG_CSV_COLUMNS = Object.freeze([
        'session_id', 'plan_id', 'device_id', 'selected_channel', 'sample_index',
        'received_at_iso', 'elapsed_us', 'seq', 'status_hex', 'raw_code',
        'voltage_uv', 'payload_hex', 'seq_gap', 'row_index',
    ]);

    function normalizeWaveformDisplay(value = {}) {
        const source = value && typeof value === 'object' ? value : {};
        const xRangeSeconds = Number(source.xRangeSeconds);
        const refreshFps = Number(source.refreshFps);
        return {
            xRangeSeconds: WAVEFORM_X_RANGES_SECONDS.includes(xRangeSeconds) ? xRangeSeconds : 20,
            refreshFps: WAVEFORM_REFRESH_RATES_FPS.includes(refreshFps) ? refreshFps : 30,
        };
    }

    function normalizeStimulusControlMode(value) {
        const mode = String(value || '').trim();
        return STIMULUS_CONTROL_MODES.includes(mode) ? mode : 'manual';
    }

    function stimulusControlModePresentation(mode) {
        const normalizedMode = normalizeStimulusControlMode(mode);
        return STIMULUS_CONTROL_MODE_PRESENTATION[normalizedMode];
    }

    // "manual" includes an explicitly started light command and a user-created
    // time plan. The model path is kept separate so selecting model-only cannot
    // silently turn a scheduled/manual light action into hardware output.
    function stimulusControlModeAllows(mode, source = 'manual') {
        const normalizedMode = normalizeStimulusControlMode(mode);
        const normalizedSource = source === 'model' ? 'model' : 'manual';
        return normalizedMode === 'both' || normalizedMode === normalizedSource;
    }

    function formatDuration(seconds) {
        const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const rest = totalSeconds % 60;
        const pad = value => String(value).padStart(2, '0');
        return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
    }

    // A plan's next action is only a schedule hint. Keep the hardware operation
    // presentation separate so an upcoming light action cannot look like a
    // currently active light stimulus (for example while impedance is measured).
    function deviceOperationPresentation(value = {}) {
        const source = value && typeof value === 'object' ? value : {};
        if (!source.connected) {
            return { tone: 'unknown', operation: 'unknown', label: '未连接', detail: '无法确认设备当前功能' };
        }
        if (source.impedanceMode) {
            return { tone: 'active', operation: 'impedance_check', label: '检测阻抗', detail: `CH${Number(source.channel) || 2} · 当前设备操作` };
        }
        if (source.pending && (source.pending.operation === 'start' || source.pending.operation === 'stop')) {
            const operation = source.pending.operation === 'start' ? '开启' : '关闭';
            return {
                tone: 'pending', operation: `light_${source.pending.operation}`,
                label: `正在${operation}光刺激`, detail: `CH${Number(source.pending.channel) || 2} · 等待设备确认`,
            };
        }
        const channels = Object.entries(source.lightRunning || {})
            .filter(([, running]) => Boolean(running))
            .map(([channel]) => Number(channel))
            .filter(channel => channel === 1 || channel === 2).sort();
        if (channels.length && source.eegRunning) {
            return { tone: 'active', operation: 'eeg_and_light', label: `采集 EEG · CH${channels.join('、CH')} 刺激中`, detail: '设备状态回读确认' };
        }
        if (channels.length) {
            return { tone: 'active', operation: 'light', label: `CH${channels.join('、CH')} 光刺激中`, detail: '设备状态回读确认' };
        }
        if (source.eegRunning) {
            return { tone: 'active', operation: 'eeg', label: '采集 EEG', detail: `CH${Number(source.channel) || 2} · 设备状态回读确认` };
        }
        if (!source.verified) {
            return { tone: 'unknown', operation: 'unknown', label: '状态待确认', detail: '已连接，正在读取设备当前功能' };
        }
        return { tone: 'off', operation: 'idle', label: '待机', detail: '未检测到 EEG、阻抗检测或光刺激运行' };
    }

    function sampleCountToSeconds(sampleCount, sampleRateHz = 250) {
        const count = Math.max(0, Number(sampleCount) || 0);
        const rate = Number(sampleRateHz);
        return rate > 0 ? count / rate : 0;
    }

    function percentile(sortedValues, ratio) {
        if (!sortedValues.length) return 0;
        const index = Math.max(0, Math.min(sortedValues.length - 1, (sortedValues.length - 1) * ratio));
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        if (lower === upper) return sortedValues[lower];
        return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
    }

    // The display scale intentionally ignores the most extreme 2% at each end.
    // A lead settling transient should not flatten the rest of the live EEG view;
    // this changes only the plot bounds, never the samples written to EDF.
    function waveformScale(values, options = {}) {
        const finiteValues = Array.from(values || [], Number).filter(Number.isFinite).sort((a, b) => a - b);
        if (!finiteValues.length) return { min: -50, max: 50, center: 0, clipped: false };
        const minimumSpanUv = Math.max(1, Number(options.minimumSpanUv) || 100);
        const center = percentile(finiteValues, .5);
        const lower = percentile(finiteValues, finiteValues.length < 20 ? 0 : .02);
        const upper = percentile(finiteValues, finiteValues.length < 20 ? 1 : .98);
        const robustHalfRange = Math.max(Math.abs(center - lower), Math.abs(upper - center), 1);
        const halfRange = Math.max(minimumSpanUv / 2, robustHalfRange * 1.15);
        const min = center - halfRange;
        const max = center + halfRange;
        return {
            min, max, center,
            clipped: finiteValues[0] < min || finiteValues.at(-1) > max,
        };
    }

    function formatLocalIso(date = new Date()) {
        const value = date instanceof Date ? date : new Date(date);
        const offsetMinutes = -value.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? '+' : '-';
        const absoluteOffset = Math.abs(offsetMinutes);
        const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, '0')}:${String(absoluteOffset % 60).padStart(2, '0')}`;
        const pad = number => String(number).padStart(2, '0');
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${String(value.getMilliseconds()).padStart(3, '0')}${offset}`;
    }

    function parseTimeOfDay(value) {
        const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
        if (!match) throw new RangeError(`Invalid time: ${value}`);
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        const second = Number(match[3] || 0);
        if (hour > 23 || minute > 59 || second > 59) throw new RangeError(`Invalid time: ${value}`);
        return hour * 3600 + minute * 60 + second;
    }

    function dateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function secondsOfDay(date) {
        return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
    }

    function planMode(plan) {
        return plan?.mode === 'relative' ? 'relative' : 'clock';
    }

    function actionScheduleSeconds(action, mode) {
        return mode === 'relative' ? Number(action.offsetSeconds) : parseTimeOfDay(action.time);
    }

    function dailyOperationForAction(action) {
        if (action?.type === 'eeg_start' || action?.type === 'eeg_stop') return 'eeg';
        if (action?.type === 'light_start' || action?.type === 'light_stop') {
            return `light:${Number(action.lightChannel) || FIXED_PLAN_LIGHT_CHANNEL}`;
        }
        return null;
    }

    function normalizePlan(plan) {
        if (!plan || typeof plan !== 'object') return plan;
        const actions = Array.isArray(plan.actions) ? plan.actions.map(action => {
            if (!action || typeof action !== 'object') return action;
            if (action.type === 'light_start' || action.type === 'light_stop') {
                return { ...action, lightChannel: FIXED_PLAN_LIGHT_CHANNEL };
            }
            return action;
        }) : plan.actions;
        return { ...plan, eegChannel: FIXED_PLAN_EEG_CHANNEL, actions };
    }

    function validatePlan(plan) {
        const errors = [];
        if (!plan || typeof plan !== 'object') return ['方案不能为空'];
        if (!String(plan.name || '').trim()) errors.push('方案名称不能为空');
        if (plan.mode != null && !PLAN_MODES.includes(plan.mode)) errors.push(`不支持的方案模式：${plan.mode}`);
        if (plan.eegChannel !== FIXED_PLAN_EEG_CHANNEL) errors.push('方案 EEG 导联固定为 CH2（双极差分）');
        if (!Array.isArray(plan.actions) || plan.actions.length === 0) errors.push('方案至少需要一个动作');
        const seenIds = new Set();
        const starts = { eeg: 0, light1: 0, light2: 0 };
        for (const action of plan.actions || []) {
            if (!action.id || seenIds.has(action.id)) errors.push('每个动作必须有唯一 ID');
            seenIds.add(action.id);
            if (!ACTION_TYPES.includes(action.type)) errors.push(`不支持的动作：${action.type}`);
            if ((action.type === 'light_start' || action.type === 'light_stop')
                && action.lightChannel !== FIXED_PLAN_LIGHT_CHANNEL) {
                errors.push('方案光刺激通道固定为 CH2');
            }
            try {
                const scheduleSeconds = actionScheduleSeconds(action, planMode(plan));
                if (!Number.isInteger(scheduleSeconds) || scheduleSeconds < 0) throw new RangeError('相对时间必须是大于等于 0 的整数秒');
            } catch (error) { errors.push(error.message); }
            if (action.type === 'eeg_start') starts.eeg++;
            if (action.type === 'eeg_stop') starts.eeg--;
            if (action.type === 'light_start') starts[`light${action.lightChannel || 1}`]++;
            if (action.type === 'light_stop') starts[`light${action.lightChannel || 1}`]--;
            if (action.type === 'light_start') {
                const config = action.light || {};
                if (!(config.frequencyHz >= 1 && config.frequencyHz <= 100)) errors.push('光刺激频率必须为 1~100Hz');
                if (!(config.powerPercent >= 0 && config.powerPercent <= 100)) errors.push('光刺激功率必须为 0~100%');
                if (!(config.durationMs >= 0)) errors.push('光刺激时长不能小于 0');
            }
        }
        if (starts.eeg !== 0) errors.push('EEG 开始和停止动作必须配对');
        if (starts.light1 !== 0 || starts.light2 !== 0) errors.push('每路光刺激开始和停止动作必须配对');
        return Array.from(new Set(errors));
    }

    class PlanEngine {
        constructor(options = {}) {
            this.now = options.now || (() => new Date());
            this.execute = options.execute || (async () => {});
            this.onEvent = options.onEvent || (() => {});
            this.monotonicNow = options.monotonicNow || (() => globalThis.performance?.now?.() ?? Date.now());
            this.plans = [];
            this.executed = new Set();
            this.abortedDailyPlans = new Set();
            this.baselinedDailyPlans = new Set();
            this.activeDailyOperations = new Map();
            this.running = false;
            this.interval = null;
            this.busy = false;
            this.currentAction = null;
            this.relativeRun = null;
        }
        setPlans(plans) { this.plans = Array.isArray(plans) ? plans : []; }
        getCurrentAction() { return this.currentAction; }
        getRelativeStatus() {
            if (!this.relativeRun) return null;
            const elapsedSeconds = Math.max(0, (this.monotonicNow() - this.relativeRun.startedMonotonicMs) / 1000);
            const plan = this.relativeRun.plan;
            const actions = [...(plan?.actions || [])].sort((a, b) => actionScheduleSeconds(a, 'relative') - actionScheduleSeconds(b, 'relative'));
            const nextAction = actions.find(action => !this.relativeRun.processed.has(action.id)) || null;
            return {
                planId: this.relativeRun.planId, plan, elapsedSeconds, nextAction,
                currentAction: this.relativeRun.currentAction || null, startedAt: this.relativeRun.startedAt,
            };
        }
        startRelative(planId) {
            if (this.relativeRun) throw new Error('已有相对方案正在运行');
            const plan = this.plans.find(item => item.id === planId);
            if (!plan || planMode(plan) !== 'relative') throw new Error('请选择一个相对时间方案');
            if (!plan.enabled) throw new Error('该相对方案已停用');
            const errors = validatePlan(plan);
            if (errors.length) throw new Error(errors.join('；'));
            const now = this.now();
            this.relativeRun = {
                planId: plan.id,
                plan,
                startedAt: formatLocalIso(now),
                startedMonotonicMs: this.monotonicNow(),
                processed: new Set(),
                currentAction: null,
            };
            this.onEvent({ phase: 'run-started', plan, startedAt: this.relativeRun.startedAt });
            void this.tick();
            return this.getRelativeStatus();
        }
        startManual(planId) {
            if (this.relativeRun) throw new Error('已有方案正在运行');
            const source = this.plans.find(item => item.id === planId);
            if (!source) throw new Error('请选择一个方案');
            if (!source.enabled) throw new Error('该方案已停用');
            if (planMode(source) === 'relative') return this.startRelative(planId);
            const sorted = [...(source.actions || [])].sort((a, b) => parseTimeOfDay(a.time) - parseTimeOfDay(b.time));
            if (!sorted.length) throw new Error('方案至少需要一个动作');
            const baseSeconds = parseTimeOfDay(sorted[0].time);
            const plan = {
                ...source,
                name: `${source.name}（立即运行）`,
                mode: 'relative',
                actions: sorted.map(action => ({
                    ...action,
                    offsetSeconds: parseTimeOfDay(action.time) - baseSeconds,
                })),
            };
            const errors = validatePlan(plan);
            if (errors.length) throw new Error(errors.join('；'));
            const now = this.now();
            this.relativeRun = {
                planId: source.id,
                plan,
                startedAt: formatLocalIso(now),
                startedMonotonicMs: this.monotonicNow(),
                processed: new Set(),
                currentAction: null,
            };
            this.onEvent({ phase: 'run-started', plan, sourceMode: 'clock', startedAt: this.relativeRun.startedAt });
            void this.tick();
            return this.getRelativeStatus();
        }
        stopRelative(reason = 'manual') {
            if (!this.relativeRun) return null;
            const status = this.getRelativeStatus();
            this.relativeRun = null;
            this.currentAction = null;
            this.onEvent({ phase: 'run-stopped', plan: status.plan, reason, elapsedSeconds: status.elapsedSeconds });
            return status;
        }
        start() {
            if (this.interval) return;
            this.interval = setInterval(() => this.tick(), 250);
            this.tick();
        }
        stop() { clearInterval(this.interval); this.interval = null; }
        baselineDailyPlan(plan, today, current) {
            const planKey = `${today}:${plan.id}`;
            const skippedActionIds = [];
            let aborted = false;
            for (const action of [...plan.actions].sort((a, b) => parseTimeOfDay(a.time) - parseTimeOfDay(b.time))) {
                const delay = current - parseTimeOfDay(action.time);
                if (delay <= START_GRACE_SECONDS) continue;
                this.executed.add(`${planKey}:${action.id}`);
                skippedActionIds.push(action.id);
                if (!SAFETY_ACTIONS.has(action.type)) aborted = true;
            }
            if (aborted) this.abortedDailyPlans.add(planKey);
            if (skippedActionIds.length) {
                this.onEvent({
                    phase: 'startup-baseline', plan, actionIds: skippedActionIds,
                    reason: 'clock_action_overdue', aborted,
                });
            }
        }
        updateDailyOperation(planKey, action) {
            const operation = dailyOperationForAction(action);
            if (!operation) return;
            const active = this.activeDailyOperations.get(planKey) || new Set();
            if (DAILY_START_ACTIONS.has(action.type)) active.add(operation);
            else if (SAFETY_ACTIONS.has(action.type)) active.delete(operation);
            if (active.size) this.activeDailyOperations.set(planKey, active);
            else this.activeDailyOperations.delete(planKey);
        }
        hasActiveDailyOperation(planKey, action) {
            const operation = dailyOperationForAction(action);
            return Boolean(operation && this.activeDailyOperations.get(planKey)?.has(operation));
        }
        async tick() {
            if (this.busy) return;
            this.busy = true;
            try {
                const now = this.now();
                if (this.relativeRun) {
                    await this.tickRelative();
                    return;
                }
                const today = dateKey(now);
                const current = secondsOfDay(now);
                for (const plan of this.plans.filter(item => item.enabled)) {
                    if (planMode(plan) !== 'clock') continue;
                    const errors = validatePlan(plan);
                    if (errors.length) continue;
                    const planKey = `${today}:${plan.id}`;
                    if (!this.baselinedDailyPlans.has(planKey)) {
                        this.baselineDailyPlan(plan, today, current);
                        this.baselinedDailyPlans.add(planKey);
                    }
                    for (const action of [...plan.actions].sort((a, b) => parseTimeOfDay(a.time) - parseTimeOfDay(b.time))) {
                        const key = `${today}:${plan.id}:${action.id}`;
                        const delay = current - parseTimeOfDay(action.time);
                        if (delay < 0 || this.executed.has(key)) continue;
                        if (this.abortedDailyPlans.has(planKey) && !SAFETY_ACTIONS.has(action.type)) {
                            this.executed.add(key);
                            this.onEvent({ phase: 'skipped', plan, action, delaySeconds: delay, reason: 'daily_plan_aborted' });
                            continue;
                        }
                        if (delay > START_GRACE_SECONDS && !SAFETY_ACTIONS.has(action.type)) {
                            this.executed.add(key);
                            this.abortedDailyPlans.add(planKey);
                            this.onEvent({ phase: 'skipped', plan, action, delaySeconds: delay, reason: 'clock_action_overdue' });
                            continue;
                        }
                        if (SAFETY_ACTIONS.has(action.type) && !this.hasActiveDailyOperation(planKey, action)) {
                            this.executed.add(key);
                            this.onEvent({ phase: 'skipped', plan, action, delaySeconds: delay, reason: 'daily_safety_not_active' });
                            continue;
                        }
                        this.executed.add(key);
                        this.currentAction = { plan, action, startedAt: formatLocalIso(now) };
                        this.onEvent({ phase: 'started', plan, action, delaySeconds: delay });
                        try {
                            await this.execute(plan, action);
                            this.updateDailyOperation(planKey, action);
                            this.currentAction = null;
                            this.onEvent({ phase: 'completed', plan, action, delaySeconds: delay });
                        } catch (error) {
                            this.currentAction = null;
                            this.abortedDailyPlans.add(planKey);
                            this.onEvent({ phase: 'failed', plan, action, delaySeconds: delay, error });
                        }
                    }
                }
                if (this.executed.size > 1000) this.executed = new Set([...this.executed].filter(key => key.startsWith(today)));
                this.abortedDailyPlans = new Set([...this.abortedDailyPlans].filter(key => key.startsWith(today)));
                this.baselinedDailyPlans = new Set([...this.baselinedDailyPlans].filter(key => key.startsWith(today)));
                this.activeDailyOperations = new Map([...this.activeDailyOperations].filter(([key]) => key.startsWith(today)));
            } finally {
                this.busy = false;
            }
        }
        async tickRelative() {
            const run = this.relativeRun;
            if (!run) return;
            const elapsedSeconds = Math.max(0, (this.monotonicNow() - run.startedMonotonicMs) / 1000);
            const actions = [...run.plan.actions].sort((a, b) => actionScheduleSeconds(a, 'relative') - actionScheduleSeconds(b, 'relative'));
            for (const action of actions) {
                if (run.processed.has(action.id)) continue;
                const plannedSeconds = actionScheduleSeconds(action, 'relative');
                const delaySeconds = elapsedSeconds - plannedSeconds;
                if (delaySeconds < 0) continue;
                run.processed.add(action.id);
                if (delaySeconds > START_GRACE_SECONDS && !SAFETY_ACTIONS.has(action.type)) {
                    this.onEvent({ phase: 'skipped', plan: run.plan, action, delaySeconds, reason: 'relative_action_overdue' });
                    this.relativeRun = null;
                    this.onEvent({ phase: 'run-failed', plan: run.plan, reason: 'relative_action_overdue', elapsedSeconds });
                    return;
                }
                run.currentAction = { plan: run.plan, action, startedAt: formatLocalIso(this.now()) };
                this.currentAction = run.currentAction;
                this.onEvent({ phase: 'started', plan: run.plan, action, delaySeconds });
                try {
                    await this.execute(run.plan, action);
                    run.currentAction = null;
                    this.currentAction = null;
                    this.onEvent({ phase: 'completed', plan: run.plan, action, delaySeconds });
                } catch (error) {
                    run.currentAction = null;
                    this.currentAction = null;
                    this.onEvent({ phase: 'failed', plan: run.plan, action, delaySeconds, error });
                    this.relativeRun = null;
                    this.onEvent({ phase: 'run-failed', plan: run.plan, reason: error.message, elapsedSeconds });
                    return;
                }
                if (!this.relativeRun) return;
            }
            if (run.processed.size === actions.length) {
                this.relativeRun = null;
                this.currentAction = null;
                this.onEvent({ phase: 'run-completed', plan: run.plan, elapsedSeconds });
            }
        }
    }

    function csvEscape(value) {
        const text = value == null ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function eegCsvLine(record = {}) {
        return EEG_CSV_COLUMNS.map(column => csvEscape(record[column])).join(',');
    }

    function createEegStreamStats(windowMs = 2000) {
        const normalizedWindowMs = Number(windowMs);
        if (!(normalizedWindowMs > 0)) throw new RangeError('windowMs must be positive');
        return {
            windowMs: normalizedWindowMs,
            receivedFrames: 0,
            lastSeq: null,
            gapEvents: 0,
            lostFrames: 0,
            recentFrameTimes: [],
        };
    }

    function pruneEegFrameTimes(stats, nowMs) {
        const cutoff = Number(nowMs) - stats.windowMs;
        let removeCount = 0;
        while (removeCount < stats.recentFrameTimes.length && stats.recentFrameTimes[removeCount] < cutoff) removeCount++;
        if (removeCount) stats.recentFrameTimes.splice(0, removeCount);
    }

    function trackEegStreamFrame(stats, seq, timestampMs) {
        if (!stats || !Array.isArray(stats.recentFrameTimes)) throw new TypeError('stats must be created by createEegStreamStats');
        const normalizedSeq = Number(seq);
        const normalizedTimestamp = Number(timestampMs);
        if (!Number.isInteger(normalizedSeq) || normalizedSeq < 0 || normalizedSeq >= EEG_SEQUENCE_MODULUS) throw new RangeError('seq must be a uint16');
        if (!Number.isFinite(normalizedTimestamp)) throw new RangeError('timestampMs must be finite');

        let delta = null;
        let seqGap = 0;
        let sequenceReset = false;
        if (stats.lastSeq != null) {
            delta = (normalizedSeq - stats.lastSeq + EEG_SEQUENCE_MODULUS) % EEG_SEQUENCE_MODULUS;
            if (delta > 1 && delta < EEG_MAX_FORWARD_DELTA) {
                seqGap = delta - 1;
                stats.gapEvents++;
                stats.lostFrames += seqGap;
            } else if (delta >= EEG_MAX_FORWARD_DELTA) {
                sequenceReset = true;
            }
        }
        stats.lastSeq = normalizedSeq;
        stats.receivedFrames++;
        stats.recentFrameTimes.push(normalizedTimestamp);
        pruneEegFrameTimes(stats, normalizedTimestamp);
        return { delta, seqGap, sequenceReset };
    }

    function eegStreamFrameRate(stats, nowMs) {
        if (!stats || !Array.isArray(stats.recentFrameTimes)) return 0;
        pruneEegFrameTimes(stats, Number(nowMs));
        const times = stats.recentFrameTimes;
        if (times.length < 2) return 0;
        const elapsedMs = times.at(-1) - times[0];
        return elapsedMs > 0 ? (times.length - 1) * 1000 / elapsedMs : 0;
    }

    function eegStreamLossRate(stats) {
        const received = Math.max(0, Number(stats?.receivedFrames) || 0);
        const lost = Math.max(0, Number(stats?.lostFrames) || 0);
        const expected = received + lost;
        return expected > 0 ? lost / expected : 0;
    }

    function bytesToHex(bytes) {
        return Array.from(bytes || [], value => value.toString(16).padStart(2, '0').toUpperCase()).join('');
    }

    function makeId(prefix = 'id') {
        if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
        return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    return Object.freeze({
        ACTION_TYPES, PLAN_MODES, STIMULUS_CONTROL_MODES, STIMULUS_CONTROL_MODE_LABELS, STIMULUS_CONTROL_MODE_PRESENTATION,
        normalizeStimulusControlMode, stimulusControlModePresentation, stimulusControlModeAllows, START_GRACE_SECONDS,
        WAVEFORM_X_RANGES_SECONDS, WAVEFORM_REFRESH_RATES_FPS, normalizeWaveformDisplay,
        formatDuration, sampleCountToSeconds, waveformScale, deviceOperationPresentation,
        FIXED_PLAN_EEG_CHANNEL, FIXED_PLAN_LIGHT_CHANNEL, normalizePlan,
        EEG_CSV_COLUMNS, eegCsvLine, createEegStreamStats, trackEegStreamFrame, eegStreamFrameRate, eegStreamLossRate,
        parseTimeOfDay, formatLocalIso, validatePlan, PlanEngine, csvEscape, bytesToHex, makeId,
    });
}));
