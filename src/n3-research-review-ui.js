(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const root = $('n3-research-review');
    const status = $('n3-research-status');
    const content = $('n3-research-content');
    const recordFilter = $('n3-research-record');
    const preRows = $('n3-prelabel-rows');
    const rankedRows = $('n3-ranked-rows');
    const span = $('n3-research-span');
    const view = $('n3-research-wave-content');
    const waveStatus = $('n3-research-wave-status');
    const canvas = $('n3-research-waveform');
    const viewCard = canvas.closest('section');
    const editor = $('n3-manual-editor');
    const manualLabels = $('n3-manual-labels');
    const labelInputs = [...manualLabels.querySelectorAll('input')];
    const labelText = Object.fromEntries(labelInputs.map(input => [input.value, input.labels[0].textContent.trim()]));
    const manualNote = $('n3-manual-note');
    const saveButton = $('n3-manual-save');
    const resumeButton = $('n3-manual-resume');
    const exportButton = $('n3-manual-export');
    const exportStatus = $('n3-manual-export-status');
    const unreviewed = $('n3-manual-unreviewed');
    const annotations = {
        N3_like_low_confidence: 'N3-like · 低置信',
        N3_like_conditional_drift: 'N3-like · 有条件低置信',
    };
    const failures = {
        slow_lt_6s: '高幅慢波不足 6 秒', anysleep_hp_not_n3: '去漂移版未判 N3',
        no_yasa_or_caocao_n3: '缺少其他模型互证', quality_warning: '有质量提醒',
    };
    const warnText = { drift_dominant: '漂移', input_clipped: '限幅' };
    const stageText = row => [row.anysleepDetrended, row.yasa, row.caocao].map(value => value || '—').join(' / ');
    const quality = row => [
        ...(row.status === 'insufficient' ? ['质量或上下文不足'] : []),
        ...row.warnings.map(w => warnText[w]),
    ].join('、') || '无提醒';
    let batch = null, pending = false, picked = null, context = null, request = 0;
    const saved = new Map(), drafts = new Map();
    let manualReady = false, lastRank = null, saving = false, exporting = false;

    function clock(seconds) {
        return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
            .map(value => String(value).padStart(2, '0')).join(':');
    }

    function timeText(item) {
        return item.date.slice(5) + '  ' + clock(item.startSec) + '–' + clock(item.endSec);
    }

    function makeRow(body, item, first, tail) {
        const row = body.insertRow();
        row.dataset.rank = String(item.rank);
        row.insertCell().textContent = first;
        const button = document.createElement('button');
        button.className = 'research-pick';
        button.type = 'button';
        button.textContent = timeText(item);
        row.insertCell().append(button);
        for (const text of tail) row.insertCell().textContent = text;
        return row;
    }

    function highlight() {
        for (const row of root.querySelectorAll('tr[data-rank]')) {
            const selected = Number(row.dataset.rank) === picked;
            row.dataset.selected = String(selected);
            row.querySelector('button').setAttribute('aria-pressed', String(selected));
        }
    }

    function renderRanked() {
        const rows = batch.ranked.filter(row => (recordFilter.value === 'all' || row.record === recordFilter.value)
            && (!unreviewed.checked || !saved.has(row.rank)));
        rankedRows.replaceChildren();
        for (const row of rows) {
            const tableRow = makeRow(rankedRows, row, String(row.rank),
                [row.strictSlowSeconds.toFixed(2), row.modelVotes + ' 票 · ' + quality(row)]);
            const cell = tableRow.insertCell(), item = saved.get(row.rank);
            cell.textContent = item ? labelText[item.label] : manualReady ? '未标注' : '—';
            if (item) cell.className = 'research-manual-cell';
        }
        $('n3-research-count').textContent = rows.length + ' / ' + batch.ranked.length + ' 段';
        highlight();
    }

    function updateManualProgress() {
        if (!manualReady) return;
        $('n3-manual-progress').textContent = '本批次 ' + saved.size + ' / ' + batch.ranked.length + ' 段已标注';
        resumeButton.disabled = lastRank === null;
        exportButton.disabled = saved.size === 0 || exporting || saving;
        unreviewed.disabled = false;
    }

    function updateEditorStatus(message) {
        const item = saved.get(picked), draft = drafts.get(picked);
        manualLabels.disabled = manualNote.disabled = saving;
        saveButton.disabled = saving || !draft?.label;
        $('n3-manual-edit-status').textContent = message || (saving ? '正在保存…'
            : draft ? '有未保存的改动。'
            : item ? '已保存 · ' + new Date(item.savedAt).toLocaleString('zh-CN') : '未标注');
    }

    function renderEditor() {
        editor.hidden = !manualReady || !context;
        if (editor.hidden) return;
        const item = drafts.get(picked) || saved.get(picked);
        for (const input of labelInputs) input.checked = input.value === item?.label;
        manualNote.value = item?.note ?? '';
        updateEditorStatus();
    }

    async function loadManual() {
        try {
            const state = await window.desktopAPI.loadN3ManualAnnotations();
            for (const item of state.items) saved.set(item.rank, item);
            lastRank = state.lastRank;
            manualReady = true;
            updateManualProgress();
            renderRanked();
            renderEditor();
        } catch (error) {
            $('n3-manual-progress').textContent = '人工标注暂不可用：' + error.message;
        }
    }

    async function load() {
        if (!root.open || pending || batch) return;
        pending = true;
        status.textContent = '正在读取本地复核批次…';
        try {
            const data = await window.desktopAPI.loadN3ResearchReview();
            if (!data?.reviewOnly) {
                status.textContent = '未配置本机研究复核批次。自动 N3 候选仍可在分期对照中查看。';
                return;
            }
            batch = data;
            preRows.replaceChildren();
            recordFilter.replaceChildren(new Option('全部记录', 'all'));
            for (const record of data.records) recordFilter.add(new Option(record.date + '（' + record.queueCount + ' 段）', record.id));
            for (const item of data.prelabels) makeRow(preRows, item, String(item.priority), [annotations[item.label]]);
            $('n3-prelabel-heading').textContent = '研究性预标注（' + data.prelabels.length + ' 段）';
            $('n3-ranked-heading').textContent = '待复核排序（' + data.ranked.length + ' 段）';
            status.textContent = '已加载 ' + data.records.length + ' 份记录，保留原排序。';
            content.hidden = false;
            renderRanked();
            void loadManual();
        } catch (error) {
            status.textContent = '复核批次读取失败：' + error.message;
        } finally {
            pending = false;
        }
    }

    function renderContext(item, selected) {
        const prelabel = batch.prelabels.find(row => row.rank === item.rank);
        const reason = selected.fails.map(key => failures[key]).join('、');
        const drift = selected.rawDriftPercent === null ? '—' : selected.rawDriftPercent.toFixed(1) + '%';
        waveStatus.textContent = timeText(selected) + ' · 待复核第 ' + item.rank + ' 名';
        $('n3-research-wave-note').textContent = (prelabel ? annotations[prelabel.label] + '。' + prelabel.note + ' ' : '')
            + '未通过自动候选：' + reason + '。原始极低频占比 ' + drift
            + '，输入限幅 ' + selected.inputClippedPercent.toFixed(2) + '%。';
        const neighbors = $('n3-research-neighbors');
        neighbors.replaceChildren();
        for (const epoch of item.epochs) {
            const row = neighbors.insertRow();
            row.dataset.selected = String(epoch.relative === 0);
            const position = epoch.relative === -1 ? '前一段' : epoch.relative === 1 ? '后一段' : '当前段';
            for (const value of [position + ' ' + clock(epoch.startSec) + '–' + clock(epoch.endSec),
                stageText(epoch), epoch.strictSlowSeconds.toFixed(2), quality(epoch)]) row.insertCell().textContent = value;
        }
        span.value = 'all';
        for (const option of span.options) option.disabled = option.value !== 'all'
            && !item.epochs.some(epoch => epoch.relative === Number(option.value));
        view.hidden = false;
        draw();
    }

    async function choose(rank) {
        if (!batch) return;
        const row = batch.ranked[rank - 1];
        if (!row) return;
        const current = ++request;
        picked = rank;
        context = null;
        highlight();
        view.hidden = true;
        waveStatus.textContent = '正在读取第 ' + rank + ' 名及相邻波形…';
        try {
            const item = await window.desktopAPI.loadN3ResearchContext(rank);
            if (current !== request) return;
            if (!item.reviewOnly || item.rank !== rank || item.record !== row.record || item.selectedEpoch !== row.epochIndex) {
                throw new Error('收到的片段与所选记录不一致。');
            }
            context = item;
            renderContext(item, row);
            renderEditor();
            viewCard.scrollIntoView({ block: 'nearest' });
        } catch (error) {
            if (current === request) waveStatus.textContent = '波形读取失败：' + error.message;
        }
    }

    function draw() {
        if (!context || view.hidden) return;
        const epochs = span.value === 'all' ? context.epochs : context.epochs.filter(row => row.relative === Number(span.value));
        const width = Math.floor(canvas.getBoundingClientRect().width);
        if (width < 140 || !epochs.length) return;
        const height = 350, dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.dataset.startSec = String(epochs[0].startSec);
        canvas.dataset.endSec = String(epochs.at(-1).endSec);
        canvas.dataset.selectedEpoch = String(context.selectedEpoch);
        canvas.setAttribute('aria-label', '原始 CH2、0.3 Hz 高通、0.5–2 Hz 慢波；EDF '
            + clock(epochs[0].startSec) + ' 至 ' + clock(epochs.at(-1).endSec) + '，单位微伏。');
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        const left = 57, right = 10, slot = (width - left - right) / epochs.length;
        let min = Infinity, max = -Infinity, limit = 1;
        for (const epoch of epochs) {
            const { raw, highpass, slow } = epoch.tracks;
            for (let i = 0; i < raw.length; i++) {
                min = Math.min(min, raw[i]);
                max = Math.max(max, raw[i]);
                limit = Math.max(limit, Math.abs(highpass[i]), Math.abs(slow[i]));
            }
        }
        const margin = Math.max((max - min) * .04, 1);
        const tracks = [
            ['raw', '原始 CH2 · 保留基线', '#283745', min - margin, max + margin],
            ['highpass', '0.3 Hz 高通', '#0072b2', -limit * 1.07, limit * 1.07],
            ['slow', '0.5–2 Hz 慢波', '#a43a19', -limit * 1.07, limit * 1.07],
        ];
        for (const [trackIndex, [key, title, color, lo, hi]] of tracks.entries()) {
            const top = 24 + trackIndex * 105, bottom = top + 74;
            const y = value => bottom - (value - lo) * (bottom - top) / (hi - lo);
            for (const [i, epoch] of epochs.entries()) {
                const x = left + i * slot;
                if (epoch.relative === 0) {
                    ctx.fillStyle = '#edf5fc';
                    ctx.fillRect(x, top, slot, bottom - top);
                }
                if (key === 'slow') {
                    ctx.fillStyle = '#f4d999';
                    for (const [a, b] of epoch.slowMarks) {
                        const scale = slot / epoch.tracks.slow.length;
                        ctx.fillRect(x + a * scale, top, (b - a) * scale, bottom - top);
                    }
                }
            }
            ctx.fillStyle = '#1d2d3a';
            ctx.font = 'bold 12px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(title + '（µV）', left, top - 7);
            ctx.font = '11px system-ui, sans-serif';
            ctx.textAlign = 'right';
            for (const value of [lo, (lo + hi) / 2, hi]) {
                const py = y(value);
                ctx.fillText(value.toFixed(Math.abs(value) < 10 ? 1 : 0), left - 5, py + 4);
                ctx.strokeStyle = '#d4dde4';
                ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(width - right, py); ctx.stroke();
            }
            ctx.strokeStyle = '#74899a';
            ctx.setLineDash([3, 4]);
            for (let i = 1; i < epochs.length; i++) {
                const x = left + i * slot;
                ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.strokeStyle = color;
            for (const [i, epoch] of epochs.entries()) {
                const values = epoch.tracks[key];
                const origin = left + i * slot;
                const step = Math.max(1, Math.ceil(values.length / slot));
                const px = index => origin + index * slot / values.length;
                ctx.beginPath(); ctx.moveTo(origin, y(values[0]));
                for (let start = 0; start < values.length; start += step) {
                    let low = start, high = start;
                    const end = Math.min(start + step, values.length);
                    for (let j = start + 1; j < end; j++) {
                        if (values[j] < values[low]) low = j;
                        if (values[j] > values[high]) high = j;
                    }
                    const first = Math.min(low, high), last = Math.max(low, high);
                    ctx.lineTo(px(first), y(values[first]));
                    ctx.lineTo(px(last), y(values[last]));
                }
                ctx.lineTo(px(values.length - 1), y(values.at(-1)));
                ctx.stroke();
            }
        }
        const t0 = epochs[0].startSec, t1 = epochs.at(-1).endSec;
        const times = epochs.length === 1 ? [t0, t0 + 10, t0 + 20, t1] : [...epochs.map(row => row.startSec), t1];
        ctx.fillStyle = '#263b4b';
        ctx.font = '11px system-ui, sans-serif';
        for (const time of times) {
            ctx.textAlign = time === t0 ? 'left' : time === t1 ? 'right' : 'center';
            ctx.fillText(clock(time), left + (width - left - right) * (time - t0) / (t1 - t0), 331);
        }
        ctx.textAlign = 'center';
        ctx.fillText('EDF 起点相对时间', (left + width - right) / 2, 346);
    }

    function pick(event) {
        const row = event.target.closest('tr[data-rank]');
        if (row) void choose(Number(row.dataset.rank));
    }
    preRows.addEventListener('click', pick);
    rankedRows.addEventListener('click', pick);
    recordFilter.addEventListener('change', renderRanked);
    unreviewed.addEventListener('change', renderRanked);
    editor.addEventListener('input', () => {
        if (!context || saving) return;
        const item = { label: labelInputs.find(input => input.checked)?.value ?? '', note: manualNote.value };
        const baseline = saved.get(picked);
        if (item.label === (baseline?.label ?? '') && item.note === (baseline?.note ?? '')) drafts.delete(picked);
        else drafts.set(picked, item);
        updateEditorStatus();
    });
    editor.addEventListener('submit', async event => {
        event.preventDefault();
        const rank = picked, draft = drafts.get(rank);
        if (!manualReady || !context || saving || !draft?.label) return;
        saving = true;
        updateEditorStatus();
        updateManualProgress();
        let message;
        try {
            const item = await window.desktopAPI.saveN3ManualAnnotation(rank, draft.label, draft.note);
            saved.set(rank, item);
            drafts.delete(rank);
            lastRank = rank;
            renderRanked();
        } catch (error) {
            message = '保存失败：' + error.message;
        } finally {
            saving = false;
            updateManualProgress();
            if (context) updateEditorStatus(rank === picked ? message : undefined);
        }
    });
    resumeButton.addEventListener('click', () => {
        if (lastRank === null) return;
        recordFilter.value = 'all';
        unreviewed.checked = false;
        renderRanked();
        rankedRows.querySelector('tr[data-rank="' + lastRank + '"]')?.scrollIntoView({ block: 'nearest' });
        void choose(lastRank);
    });
    exportButton.addEventListener('click', async () => {
        exporting = true;
        updateManualProgress();
        exportStatus.hidden = false;
        exportStatus.textContent = '请选择导出位置…';
        try {
            const result = await window.desktopAPI.exportN3ManualAnnotations();
            exportStatus.textContent = result.canceled ? '已取消导出。'
                : '已导出 ' + result.count + ' 条已保存的人工标注：' + result.fileName;
        } catch (error) {
            exportStatus.textContent = '导出失败：' + error.message;
        } finally {
            exporting = false;
            updateManualProgress();
        }
    });
    span.addEventListener('change', draw);
    new ResizeObserver(draw).observe(canvas);
    root.addEventListener('toggle', load);
    if (root.open) void load();
}());
