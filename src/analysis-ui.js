(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const state = {
        sessions: [], analysisId: null, summary: null, source: 'filtered',
        startSample: 0, endSample: 1, yZoom: 1, yOffset: 0,
        viewport: null, requestSerial: 0, drag: null, initialized: false,
        spectrogram: null, spectrogramSerial: 0, yasa: null, yasaRunning: false,
    };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
        })[character]);
    }

    function number(value, digits = 2) {
        return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--';
    }

    function duration(value) {
        const seconds = Math.max(0, Number(value) || 0);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor(seconds % 3600 / 60);
        const rest = seconds % 60;
        return hours ? `${hours}h ${minutes}m ${rest.toFixed(1)}s` : `${minutes}m ${rest.toFixed(1)}s`;
    }

    function formatDate(value) {
        return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '--';
    }

    function setLoading(active, label = '准备分析…', percent = 0) {
        $('analysis-progress').hidden = !active;
        $('analysis-progress-label').textContent = label;
        $('analysis-progress-bar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
        $('analysis-open-button').disabled = active;
        $('analysis-yasa-button').disabled = active || !state.summary || state.yasaRunning;
    }

    function toast(message, error = false) {
        const node = document.createElement('div');
        node.className = `toast ${error ? 'error' : ''}`;
        node.textContent = message;
        $('toast-stack').append(node);
        setTimeout(() => node.remove(), 4200);
    }

    function setSessions(sessions) {
        state.sessions = sessions || [];
        const selected = $('analysis-session-select').value;
        $('analysis-session-select').innerHTML = '<option value="">请选择采集记录</option>' + state.sessions.map(session =>
            `<option value="${escapeHtml(session.id)}">${escapeHtml(formatDate(session.startedAt))} · CH${session.selectedChannel} · ${escapeHtml(session.planName || '手动采集')} · ${Number(session.rows || 0).toLocaleString()} 点</option>`).join('');
        if (state.sessions.some(session => session.id === selected)) $('analysis-session-select').value = selected;
    }

    function showAnalysisDialog() {
        window.focus();
    }

    async function closeAnalysisDialog() {
        const dialog = $('analysis-dialog');
        const analysisId = state.analysisId;
        state.analysisId = null;
        state.summary = null;
        state.viewport = null;
        state.spectrogram = null;
        state.yasa = null;
        state.yasaRunning = false;
        state.requestSerial += 1;
        state.spectrogramSerial += 1;
        if (analysisId) await window.desktopAPI.closeAnalysis(analysisId).catch(() => {});
        $('analysis-workspace').hidden = true;
        $('analysis-empty').hidden = false;
        $('analysis-empty').textContent = '从采集记录中选择一个会话开始分析。';
        $('analysis-export-button').disabled = true;
        $('analysis-yasa-button').disabled = true;
        setLoading(false);
        if (dialog?.open) dialog.close();
        document.body.classList.remove('analysis-dialog-open');
        if (window.desktopAPI.closeAnalysisWindow) await window.desktopAPI.closeAnalysisWindow().catch(() => {});
    }

    async function openSession(sessionId) {
        if (!sessionId) throw new Error('请先选择采集记录');
        if (state.analysisId) await window.desktopAPI.closeAnalysis(state.analysisId).catch(() => {});
        state.analysisId = null;
        state.summary = null;
        state.viewport = null;
        state.yasa = null;
        state.yasaRunning = false;
        $('analysis-workspace').hidden = true;
        $('analysis-empty').hidden = false;
        $('analysis-empty').textContent = '正在读取并分析记录…';
        $('analysis-yasa-button').disabled = true;
        $('analysis-export-button').disabled = true;
        setLoading(true, '读取采集数据…', 1);
        try {
            const result = await window.desktopAPI.openAnalysis(sessionId);
            state.analysisId = result.analysisId;
            state.summary = result;
            state.source = 'filtered';
            state.startSample = 0;
            state.endSample = result.integrity.validSamples;
            state.yZoom = 1;
            state.yOffset = 0;
            renderSummary();
            $('analysis-empty').hidden = true;
            $('analysis-workspace').hidden = false;
            $('analysis-export-button').disabled = false;
            setLoading(false);
            await requestViewport();
            await requestSpectrogram();
            return result;
        } catch (error) {
            setLoading(false);
            $('analysis-empty').textContent = `分析失败：${error.message}`;
            toast(error.message, true);
            throw error;
        }
    }

    async function openForSession(sessionId) {
        if (!sessionId) throw new Error('请先选择一条采集记录');
        showAnalysisDialog();
        $('analysis-session-select').value = sessionId;
        return openSession(sessionId);
    }

    function renderSummary() {
        const summary = state.summary;
        const integrity = summary.integrity;
        const metrics = summary.metrics;
        $('analysis-kpis').innerHTML = [
            ['有效样本', Number(integrity.validSamples).toLocaleString(), `${number(integrity.effectiveSampleRateHz)} Hz`],
            ['记录时长', duration(summary.durationSeconds), `CH${summary.metadata.selectedChannel || 2}`],
            ['可用 epoch', `${number(integrity.usableEpochPercent, 1)}%`, `${integrity.epochs - integrity.rejectedEpochs}/${integrity.epochs}`],
            ['Seq 缺口', Number(integrity.seqGaps).toLocaleString(), `无效行 ${integrity.invalidRows}`],
            ['50Hz 干扰', `${number(metrics.interference50HzRmsUv)} µV`, '原始信号 RMS'],
        ].map(item => `<article class="analysis-metric"><span>${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></article>`).join('');
        $('analysis-quality-body').innerHTML = [
            ['滤波 RMS', `${number(metrics.filteredRmsUv)} µV`],
            ['滤波峰峰值', `${number(metrics.filteredPeakToPeakUv)} µV`],
            ['1–99% 稳健幅度', `${number(metrics.robustRangeUv)} µV`],
            ['原始绝对中位偏置', `${number(metrics.rawAbsoluteMedianUv)} µV`],
            ['分钟基线变化范围', `${number(metrics.baselineRangeUv)} µV`],
            ['ADC 削波样本', Number(integrity.clippingSamples).toLocaleString()],
            ['严重伪迹 epoch', `${integrity.rejectedEpochs}/${integrity.epochs}`],
        ].map(item => `<tr><th>${item[0]}</th><td>${item[1]}</td></tr>`).join('');
        $('analysis-band-body').innerHTML = Object.values(metrics.bandPowers).map(band =>
            `<tr><th>${escapeHtml(band.label)}</th><td>${number(band.absolute, 4)} µV²</td><td>${number(band.relativePercent, 2)}%</td></tr>`).join('');
        renderSegments();
        renderPhaseMetrics();
        renderYasa();
        const warnings = summary.warnings || [];
        $('analysis-warnings').hidden = warnings.length === 0;
        $('analysis-warnings').textContent = warnings.join('\n');
        $('analysis-wave-title').textContent = `CH${summary.metadata.selectedChannel || 2} · ${state.source === 'raw' ? '原始' : '滤波后'}波形`;
        document.querySelectorAll('#analysis-source-toggle button').forEach(button => button.classList.toggle('active', button.dataset.source === state.source));
    }

    function renderYasa() {
        const stateLabel = $('analysis-yasa-state');
        const summaryNode = $('analysis-yasa-summary');
        const body = $('analysis-yasa-stage-body');
        const warningsNode = $('analysis-yasa-warnings');
        const filesNode = $('analysis-yasa-files');
        if (!state.yasa) {
            stateLabel.textContent = state.yasaRunning ? '运行中…' : '尚未运行';
            summaryNode.textContent = state.yasaRunning
                ? '正在调用 Python YASA；原始 EDF 保持不变。'
                : '选择采集记录后，点击右上角“YASA 离线复核”运行独立分期。';
            body.innerHTML = '<tr><td colspan="4"><div class="empty-state">尚未生成 YASA 结果</div></td></tr>';
            warningsNode.hidden = true;
            warningsNode.textContent = '';
            filesNode.textContent = '';
            return;
        }
        const result = state.yasa;
        const overlap = result.overlapWithRealtime || {};
        const compared = Number(overlap.comparedEpochs || 0);
        const overlapText = compared
            ? `${number(overlap.agreementPercent, 1)}%（${compared} 个重合 epoch）`
            : '无实时结果可对照';
        stateLabel.textContent = `已完成 · YASA ${escapeHtml(result.yasaVersion || '--')}`;
        summaryNode.innerHTML = [
            ['有效 epoch', Number(result.epochCount || 0).toLocaleString(), '每个 epoch 30 秒'],
            ['记录时长', duration(result.durationSeconds), `${number(result.sampleRateHz)} Hz`],
            ['与实时结果一致率', overlapText, '仅作描述性对照'],
            ['输出文件', '2 个', 'summary.json + epochs.csv'],
        ].map(item => `<article class="analysis-yasa-stat"><span>${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></article>`).join('');
        const labels = { W: 'Wake', N1: 'N1', N2: 'N2', N3: 'N3', REM: 'REM' };
        body.innerHTML = Object.keys(labels).map(stage => `<tr>
            <th>${labels[stage]} <small>(${stage})</small></th>
            <td>${Number(result.stageCounts?.[stage] || 0).toLocaleString()}</td>
            <td>${duration(Number(result.stageCounts?.[stage] || 0) * 30)}</td>
            <td>${number(result.stagePercent?.[stage], 1)}%</td>
        </tr>`).join('');
        const warnings = result.warnings || [];
        warningsNode.hidden = warnings.length === 0;
        warningsNode.textContent = warnings.join('\n');
        const files = result.outputFiles || {};
        filesNode.textContent = files.summaryJson && files.epochsCsv
            ? `结果已保存：${files.summaryJson}；${files.epochsCsv}`
            : '';
    }

    async function runYasaStaging() {
        if (!state.summary) throw new Error('请先打开一条采集记录');
        const sessionId = state.summary.metadata?.id || $('analysis-session-select').value;
        state.yasa = null;
        state.yasaRunning = true;
        renderYasa();
        setLoading(true, '运行 Python YASA 离线分期…', 12);
        try {
            const result = await window.desktopAPI.runYasaStaging(sessionId);
            if (!result?.ok) throw new Error(result?.error || 'YASA 未返回有效结果');
            state.yasa = result;
            renderYasa();
            toast(`YASA 分期完成：${result.epochCount} 个 epoch`);
        } catch (error) {
            $('analysis-yasa-state').textContent = '运行失败';
            $('analysis-yasa-summary').textContent = error.message;
            $('analysis-yasa-warnings').hidden = false;
            $('analysis-yasa-warnings').textContent = error.message;
            toast(`YASA 离线分期失败：${error.message}`, true);
        } finally {
            state.yasaRunning = false;
            setLoading(false);
            if (state.yasa) renderYasa();
        }
    }

    function renderSegments() {
        const segments = state.summary.segments || [];
        $('analysis-segments').innerHTML = segments.length ? segments.map((segment, index) => `<div class="analysis-segment" data-index="${index}">
            <span class="segment-source">${segment.source === 'event-log' ? '日志识别' : '手工'}</span>
            <label>光通道<select class="segment-channel"><option value="1" ${segment.channel===1?'selected':''}>CH1</option><option value="2" ${segment.channel===2?'selected':''}>CH2</option></select></label>
            <label>前段开始 s<input class="segment-pre" type="number" min="0" step="0.1" value="${number(segment.preStartSec,3)}"></label>
            <label>刺激开始 s<input class="segment-start" type="number" min="0" step="0.1" value="${number(segment.startSec,3)}"></label>
            <label>刺激结束 s<input class="segment-end" type="number" min="0" step="0.1" value="${number(segment.endSec,3)}"></label>
            <label>后段结束 s<input class="segment-post" type="number" min="0" step="0.1" value="${number(segment.postEndSec,3)}"></label>
            <button type="button" class="remove-segment" title="删除区间">×</button>
        </div>`).join('') : '<div class="empty-state">未找到完整光刺激事件，可点击“添加区间”手工标注。</div>';
    }

    function renderPhaseMetrics() {
        const rows = [];
        for (let index = 0; index < (state.summary.phaseMetrics || []).length; index++) {
            const segment = state.summary.phaseMetrics[index];
            for (const phaseId of ['before', 'during', 'after']) {
                const phase = segment.phases[phaseId];
                const label = { before: '刺激前', during: '刺激中', after: '刺激后' }[phaseId];
                const bands = phase.bandPowers;
                rows.push(`<tr><td>#${index+1} CH${segment.channel}</td><th>${label}</th><td>${number(phase.durationSeconds,1)}s</td><td>${number(phase.rmsUv)}µV</td><td>${number(phase.robustRangeUv)}µV</td><td>${number(bands.delta.relativePercent,1)}%</td><td>${number(bands.theta.relativePercent,1)}%</td><td>${number(bands.alpha.relativePercent,1)}%</td><td>${number(bands.beta.relativePercent,1)}%</td><td>${number(bands.gamma.relativePercent,1)}%</td><td>${number(bands.stimulus40.relativePercent,2)}%</td></tr>`);
            }
        }
        $('analysis-phase-body').innerHTML = rows.join('') || '<tr><td colspan="11"><div class="empty-state">暂无刺激阶段统计</div></td></tr>';
    }

    function readSegments() {
        return Array.from(document.querySelectorAll('.analysis-segment')).map((row, index) => ({
            id: state.summary.segments[index]?.id || `manual-${Date.now()}-${index}`,
            source: state.summary.segments[index]?.source || 'manual',
            channel: Number(row.querySelector('.segment-channel').value),
            preStartSec: Number(row.querySelector('.segment-pre').value),
            startSec: Number(row.querySelector('.segment-start').value),
            endSec: Number(row.querySelector('.segment-end').value),
            postEndSec: Number(row.querySelector('.segment-post').value),
        }));
    }

    async function applySegments() {
        if (!state.analysisId) return;
        setLoading(true, '重新计算刺激阶段…', 80);
        try {
            const updated = await window.desktopAPI.updateAnalysisSegments(state.analysisId, readSegments());
            state.summary = { analysisId: state.analysisId, ...updated };
            renderSummary();
            await requestViewport();
            toast('刺激阶段指标已重新计算');
        } finally { setLoading(false); }
    }

    async function requestViewport() {
        if (!state.analysisId || !state.summary) return;
        const canvas = $('analysis-canvas');
        const serial = ++state.requestSerial;
        $('analysis-canvas-loading').hidden = false;
        const result = await window.desktopAPI.requestAnalysisViewport({
            analysisId: state.analysisId, source: state.source,
            startSample: state.startSample, endSample: state.endSample,
            pixelWidth: Math.max(100, Math.floor(canvas.clientWidth - 72)),
        });
        if (serial !== state.requestSerial) return;
        state.viewport = result;
        $('analysis-canvas-loading').hidden = true;
        drawViewport();
    }

    function spectrogramColor(value) {
        const stops = [
            [8, 24, 38], [23, 70, 112], [17, 139, 149],
            [112, 190, 118], [244, 205, 76], [214, 69, 53],
        ];
        const scaled = Math.max(0, Math.min(1, value)) * (stops.length - 1);
        const index = Math.min(stops.length - 2, Math.floor(scaled));
        const fraction = scaled - index;
        return stops[index].map((component, channel) => Math.round(component + (stops[index + 1][channel] - component) * fraction));
    }

    async function requestSpectrogram() {
        if (!state.analysisId || !state.summary) return;
        const serial = ++state.spectrogramSerial;
        $('spectrogram-loading').hidden = false;
        try {
            const result = await window.desktopAPI.requestAnalysisSpectrogram({
                analysisId: state.analysisId,
                source: state.source,
                windowSeconds: Number($('spectrogram-window').value),
                maxHz: Number($('spectrogram-max-hz').value),
                maxTimeBins: 720,
            });
            if (serial !== state.spectrogramSerial) return;
            state.spectrogram = result;
            drawSpectrogram();
        } catch (error) {
            if (serial === state.spectrogramSerial) toast(`时频分析失败：${error.message}`, true);
        } finally {
            if (serial === state.spectrogramSerial) $('spectrogram-loading').hidden = true;
        }
    }

    function drawSpectrogram() {
        const canvas = $('spectrogram-canvas');
        const context = canvas.getContext('2d');
        const ratio = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        const width = rect.width, height = rect.height;
        context.fillStyle = '#0b1722'; context.fillRect(0, 0, width, height);
        const result = state.spectrogram;
        if (!result?.timeBins || !result?.frequencyBins) return;
        const left = 52, right = 18, top = 14, bottom = 30;
        const plotW = Math.max(1, width - left - right), plotH = Math.max(1, height - top - bottom);
        const offscreen = document.createElement('canvas');
        offscreen.width = result.timeBins;
        offscreen.height = result.frequencyBins;
        const offscreenContext = offscreen.getContext('2d');
        const image = offscreenContext.createImageData(result.timeBins, result.frequencyBins);
        const span = Math.max(1e-9, result.colorMaxDb - result.colorMinDb);
        for (let timeIndex = 0; timeIndex < result.timeBins; timeIndex++) {
            for (let frequencyIndex = 0; frequencyIndex < result.frequencyBins; frequencyIndex++) {
                const db = result.powerDb[timeIndex * result.frequencyBins + frequencyIndex];
                const [red, green, blue] = spectrogramColor((db - result.colorMinDb) / span);
                const row = result.frequencyBins - 1 - frequencyIndex;
                const offset = (row * result.timeBins + timeIndex) * 4;
                image.data[offset] = red; image.data[offset + 1] = green; image.data[offset + 2] = blue; image.data[offset + 3] = 255;
            }
        }
        offscreenContext.putImageData(image, 0, 0);
        context.imageSmoothingEnabled = true;
        context.drawImage(offscreen, left, top, plotW, plotH);
        context.strokeStyle = 'rgba(255,255,255,.22)'; context.fillStyle = '#c6d2d9'; context.font = '10px Segoe UI';
        for (let index = 0; index <= 5; index++) {
            const frequency = result.maxHz * index / 5;
            const y = top + plotH - index * plotH / 5;
            context.beginPath(); context.moveTo(left, y); context.lineTo(left + plotW, y); context.stroke();
            context.fillText(`${number(frequency, 0)} Hz`, 5, y + 3);
        }
        const endTime = result.times[result.times.length - 1] || state.summary.durationSeconds;
        for (let index = 0; index <= 6; index++) {
            const seconds = endTime * index / 6;
            const x = left + index * plotW / 6;
            context.fillText(`${number(seconds, 1)}s`, x - 10, height - 9);
        }
        $('spectrogram-detail').textContent = `STFT · ${number(result.windowSeconds, 2)} s Hann 窗 · 75% 重叠 · ${result.timeBins} 时间窗`;
    }

    function setupSpectrogram() {
        const canvas = $('spectrogram-canvas');
        $('spectrogram-refresh').addEventListener('click', () => requestSpectrogram());
        $('spectrogram-window').addEventListener('change', () => requestSpectrogram());
        $('spectrogram-max-hz').addEventListener('change', () => requestSpectrogram());
        canvas.addEventListener('pointermove', event => {
            if (!state.spectrogram?.timeBins) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.max(0, Math.min(1, (event.clientX - rect.left - 52) / Math.max(1, rect.width - 70)));
            const y = Math.max(0, Math.min(1, (event.clientY - rect.top - 14) / Math.max(1, rect.height - 44)));
            const timeIndex = Math.min(state.spectrogram.timeBins - 1, Math.round(x * (state.spectrogram.timeBins - 1)));
            const frequencyIndex = Math.min(state.spectrogram.frequencyBins - 1, Math.round((1 - y) * (state.spectrogram.frequencyBins - 1)));
            const db = state.spectrogram.powerDb[timeIndex * state.spectrogram.frequencyBins + frequencyIndex];
            $('spectrogram-cursor').textContent = `${number(state.spectrogram.times[timeIndex], 2)} s · ${number(state.spectrogram.frequencies[frequencyIndex], 2)} Hz · ${number(db, 1)} dB/Hz`;
        });
        canvas.addEventListener('pointerleave', () => { $('spectrogram-cursor').textContent = '--'; });
        new ResizeObserver(() => { if (state.spectrogram) drawSpectrogram(); }).observe(canvas);
    }

    function visibleYRange() {
        const viewport = state.viewport;
        let minimum = Number(viewport?.minimum);
        let maximum = Number(viewport?.maximum);
        if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return [-1, 1];
        if (maximum - minimum < 1e-6) { minimum -= .5; maximum += .5; }
        const center = (minimum + maximum) / 2 + state.yOffset;
        const half = (maximum - minimum) * .58 / state.yZoom;
        return [center - half, center + half];
    }

    function drawViewport() {
        const canvas = $('analysis-canvas');
        const context = canvas.getContext('2d');
        const ratio = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = Math.max(1, Math.round(rect.width * ratio));
        canvas.height = Math.max(1, Math.round(rect.height * ratio));
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        const width = rect.width, height = rect.height;
        context.fillStyle = '#fbfdfe'; context.fillRect(0, 0, width, height);
        if (!state.viewport) return;
        const left = 58, right = 16, top = 18, bottom = 34;
        const plotW = width-left-right, plotH = height-top-bottom;
        context.strokeStyle = '#dfe7eb'; context.lineWidth = 1;
        for (let index=0; index<=6; index++) { const x=left+index*plotW/6; context.beginPath(); context.moveTo(x,top); context.lineTo(x,top+plotH); context.stroke(); }
        for (let index=0; index<=5; index++) { const y=top+index*plotH/5; context.beginPath(); context.moveTo(left,y); context.lineTo(left+plotW,y); context.stroke(); }
        const sampleRate = state.summary.sampleRateHz;
        const [yMin,yMax] = visibleYRange();
        const yFor = value => top+(yMax-value)*plotH/(yMax-yMin);
        const secondsStart = state.startSample/sampleRate;
        const secondsEnd = state.endSample/sampleRate;
        for (const segment of state.summary.segments || []) {
            const start = Math.max(secondsStart,segment.startSec), end=Math.min(secondsEnd,segment.endSec);
            if (end<=start) continue;
            const x=left+(start-secondsStart)/(secondsEnd-secondsStart)*plotW;
            const w=(end-start)/(secondsEnd-secondsStart)*plotW;
            context.fillStyle='rgba(231,77,60,.10)'; context.fillRect(x,top,w,plotH);
            context.strokeStyle='rgba(231,77,60,.55)'; context.beginPath(); context.moveTo(x,top); context.lineTo(x,top+plotH); context.moveTo(x+w,top); context.lineTo(x+w,top+plotH); context.stroke();
        }
        context.strokeStyle = state.source==='raw' ? '#1769e0' : '#008f72'; context.fillStyle = state.source==='raw' ? 'rgba(23,105,224,.14)' : 'rgba(0,143,114,.15)'; context.lineWidth=1.8; context.lineJoin='round'; context.lineCap='round';
        if (state.viewport.mode==='line') {
            context.beginPath(); state.viewport.samples.forEach((value,index)=>{const x=left+index*plotW/Math.max(1,state.viewport.samples.length-1),y=yFor(value);if(index)context.lineTo(x,y);else context.moveTo(x,y);}); context.stroke();
        } else {
            const count=state.viewport.lows.length; context.beginPath(); state.viewport.highs.forEach((value,index)=>{const x=left+index*plotW/Math.max(1,count-1),y=yFor(value);if(index)context.lineTo(x,y);else context.moveTo(x,y);});
            for(let index=count-1;index>=0;index--)context.lineTo(left+index*plotW/Math.max(1,count-1),yFor(state.viewport.lows[index])); context.closePath();context.fill();context.stroke();
        }
        context.fillStyle='#5e717c';context.font='11px Segoe UI';
        context.fillText(`${number(yMax,1)} µV`,4,top+4);context.fillText(`${number(yMin,1)} µV`,4,top+plotH);
        for(let index=0;index<=6;index++){const seconds=secondsStart+index*(secondsEnd-secondsStart)/6;const x=left+index*plotW/6;context.fillText(`${number(seconds,1)}s`,x-12,height-10);}
        $('analysis-window-label').textContent=`视窗 ${number(secondsStart,2)}–${number(secondsEnd,2)} s · ${Number(state.endSample-state.startSample).toLocaleString()} 点`;
    }

    function setupCanvas() {
        const canvas = $('analysis-canvas');
        canvas.addEventListener('contextmenu', event => event.preventDefault());
        canvas.addEventListener('wheel', event => {
            if (!state.summary) return;
            event.preventDefault();
            if (event.ctrlKey) {
                state.yZoom = Math.max(.1,Math.min(100,state.yZoom*Math.exp(-event.deltaY*.002)));
                drawViewport(); return;
            }
            const total=state.summary.integrity.validSamples,current=state.endSample-state.startSample;
            const next=Math.max(state.summary.sampleRateHz,Math.min(total,current*Math.exp(event.deltaY*.0015)));
            const rect=canvas.getBoundingClientRect(),anchor=Math.max(0,Math.min(1,(event.clientX-rect.left-58)/Math.max(1,rect.width-74)));
            const sample=state.startSample+anchor*current;
            state.startSample=Math.max(0,Math.min(total-next,sample-anchor*next));state.endSample=state.startSample+next;requestViewport();
        },{passive:false});
        canvas.addEventListener('pointerdown',event=>{if(event.button!==2||!state.summary)return;state.drag={x:event.clientX,y:event.clientY,start:state.startSample,end:state.endSample,yOffset:state.yOffset};canvas.setPointerCapture(event.pointerId);canvas.parentElement.classList.add('dragging');});
        canvas.addEventListener('pointermove',event=>{
            if(state.drag){const rect=canvas.getBoundingClientRect(),count=state.drag.end-state.drag.start,delta=(event.clientX-state.drag.x)/Math.max(1,rect.width-74)*count;const total=state.summary.integrity.validSamples;state.startSample=Math.max(0,Math.min(total-count,state.drag.start-delta));state.endSample=state.startSample+count;const range=visibleYRange();state.yOffset=state.drag.yOffset+(event.clientY-state.drag.y)/Math.max(1,rect.height-52)*(range[1]-range[0]);requestViewport();return;}
            if(!state.viewport)return;const rect=canvas.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(event.clientX-rect.left-58)/Math.max(1,rect.width-74)));const sample=state.startSample+ratio*(state.endSample-state.startSample);const [min,max]=visibleYRange();const yRatio=Math.max(0,Math.min(1,(event.clientY-rect.top-18)/Math.max(1,rect.height-52)));$('analysis-cursor-label').textContent=`${number(sample/state.summary.sampleRateHz,2)} s · ${number(max-yRatio*(max-min),2)} µV`;
        });
        const finish=event=>{if(!state.drag)return;state.drag=null;canvas.parentElement.classList.remove('dragging');try{canvas.releasePointerCapture(event.pointerId);}catch{}};
        canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);
        canvas.addEventListener('dblclick',()=>{if(!state.summary)return;state.startSample=0;state.endSample=state.summary.integrity.validSamples;state.yZoom=1;state.yOffset=0;requestViewport();});
        new ResizeObserver(()=>{if(state.summary)requestViewport();}).observe(canvas);
    }

    function setupEvents() {
        $('analysis-open-button').addEventListener('click',()=>openSession($('analysis-session-select').value).catch(()=>{}));
        $('analysis-dialog-close').addEventListener('click',()=>closeAnalysisDialog().catch(error=>toast(error.message,true)));
        const dialog = $('analysis-dialog');
        if (dialog) {
            dialog.addEventListener('cancel', event => {
                event.preventDefault();
                closeAnalysisDialog().catch(error=>toast(error.message,true));
            });
            dialog.addEventListener('click', event => {
                if (event.target === dialog) closeAnalysisDialog().catch(error=>toast(error.message,true));
            });
        }
        $('analysis-yasa-button').addEventListener('click',()=>runYasaStaging().catch(()=>{}));
        $('analysis-export-button').addEventListener('click',async()=>{try{setLoading(true,'生成 PDF 与数据附件…',92);const result=await window.desktopAPI.exportAnalysisReport(state.analysisId);if(result)toast(`报告已导出：${result.pdfPath}`);}catch(error){toast(error.message,true);}finally{setLoading(false);}});
        $('analysis-source-toggle').addEventListener('click',event=>{const button=event.target.closest('[data-source]');if(!button||button.dataset.source===state.source)return;state.source=button.dataset.source;renderSummary();requestViewport();requestSpectrogram();});
        $('analysis-add-segment').addEventListener('click',()=>{if(!state.summary)return;const middle=(state.startSample+state.endSample)/2/state.summary.sampleRateHz;const length=Math.min(60,Math.max(1,state.summary.durationSeconds/10));state.summary.segments.push({id:`manual-${Date.now()}`,channel:1,preStartSec:Math.max(0,middle-length),startSec:middle,endSec:Math.min(state.summary.durationSeconds,middle+length),postEndSec:Math.min(state.summary.durationSeconds,middle+length*2),source:'manual'});renderSegments();});
        $('analysis-segments').addEventListener('click',event=>{const button=event.target.closest('.remove-segment');if(!button)return;const row=button.closest('.analysis-segment');state.summary.segments.splice(Number(row.dataset.index),1);renderSegments();});
        $('analysis-apply-segments').addEventListener('click',()=>applySegments().catch(error=>toast(error.message,true)));
        setupCanvas();
        setupSpectrogram();
        window.desktopAPI.onAnalysisProgress(progress=>{if(!state.analysisId||progress.analysisId!==state.analysisId)return;setLoading(true,progress.detail||progress.phase,progress.percent);});
    }

    function init() {
        if (state.initialized) return;
        state.initialized=true;setupEvents();
    }

    window.BrainLumeAnalysisUi = Object.freeze({ init, setSessions, openSession, openForSession, closeAnalysisDialog });
}());
