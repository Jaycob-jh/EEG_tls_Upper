(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const models = { anysleep: 'AnySleep 原流程', anysleepDetrended: 'AnySleep 去漂移', yasa: 'YASA', caocao: '曹操中心' };
    const colors = { W: '#b0b9c2', N1: '#9dc8de', N2: '#397ea5', N3: '#5644b6', REM: '#168577',
        '不可判读/未确认': '#eceef2', 'N3 分歧': '#c34459' };
    const current = $('anysleep-current');
    const choose = $('anysleep-edf');
    const canvas = $('anysleep-timeline');
    const status = $('anysleep-status');
    const mode = $('anysleep-n3-mode');
    const mvpFilter = $('n3-mvp-filter');
    const mvpStates = { candidate: 'N3 候选', review: '待复核', insufficient: '质量或上下文不足', no_alert: '未提示 N3' };
    const mvpLabels = {
        edf_rail: 'EDF 触及量程', raw_flat: '原始波形长平线', raw_step: '原始电位突跳',
        hp_large_peak: '高通后峰值过大', center_unavailable: '中心回放上下文不足', caocao_quality: '曹操质量未通过',
        insufficient_slow: '高幅慢波不足 6 秒', detrended_not_n3: '去漂移版未判 N3',
        uncorroborated: '无其他模型互证', slow_and_models: '慢波和模型相互支持',
        quality_warning: '有质量提醒，保留待复核',
        drift_dominant: '基线漂移占优', input_clipped: '模型输入发生限幅',
    };
    let lastResult = null;
    let running = false;

    function clock(seconds) {
        const time = Math.max(0, Math.floor(seconds));
        return [Math.floor(time / 3600), Math.floor(time / 60) % 60, time % 60]
            .map(value => String(value).padStart(2, '0')).join(':');
    }

    function draw() {
        const width = Math.floor(canvas.getBoundingClientRect().width);
        if (!lastResult || width < 200) return;
        const ratio = window.devicePixelRatio || 1;
        const height = 162;
        canvas.width = Math.floor(width * ratio);
        canvas.height = Math.floor(height * ratio);
        const ctx = canvas.getContext('2d');
        ctx.scale(ratio, ratio);
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);

        const rows = lastResult.rows;
        const duration = rows.at(-1).endSec;
        const startX = Math.ceil(Math.max(...Object.values(models).map(label => ctx.measureText(label).width))) + 20;
        const plotWidth = width - startX - 24;
        const x = seconds => startX + plotWidth * seconds / duration;
        for (const [index, [key, label]] of Object.entries(models).entries()) {
            const y = 22 + index * 27;
            ctx.fillStyle = '#425164';
            ctx.fillText(label, 7, y + 12);
            // Draw each continuous stage as a single rectangle, without seams between equal epochs.
            for (let first = 0; first < rows.length;) {
                const label = rows[first][key];
                let stop = first + 1;
                while (stop < rows.length && rows[stop][key] === label) stop += 1;
                const left = x(rows[first].startSec);
                ctx.fillStyle = colors[label] || colors['不可判读/未确认'];
                ctx.fillRect(left, y, x(rows[stop - 1].endSec) - left, 16);
                first = stop;
            }
        }
        ctx.fillStyle = colors['N3 分歧'];
        for (const interval of lastResult.comparisons[mode.value].intervals) {
            ctx.fillRect(x(interval.startSec), 10, x(interval.endSec) - x(interval.startSec) + 0.3, 5);
        }
        ctx.fillStyle = '#425164';
        for (let tick = 0; tick <= 4; tick += 1) {
            const seconds = duration * tick / 4;
            ctx.textAlign = tick === 0 ? 'left' : tick === 4 ? 'right' : 'center';
            ctx.fillText(clock(seconds), x(seconds), 149);
        }
    }

    function show(result) {
        lastResult = result;
        const { stats, source } = result;
        const unconfirmed = result.rows.filter(row => row.caocaoCandidate === 'N3' && !row.caocao && row.caocaoQuality === 'ok').length;
        const wakeText = key => {
            const wake = stats.stageCounts[key].W;
            return wake + ' / ' + stats.epochCount + ' 段' + (wake === stats.epochCount ? '（全 W）' : '');
        };
        const uv = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' µV';
        status.textContent = (result.cached ? '已读取本地结果 · ' : '已完成 · ') + source.name;
        $('anysleep-summary').textContent = 'AnySleep 清醒（W）：原流程 ' + wakeText('anysleep')
            + ' · 去漂移 ' + wakeText('anysleepDetrended') + '。'
            + (unconfirmed ? '曹操另有 ' + unconfirmed + ' 个质量合格但未确认为 N3 的候选。' : '');
        $('anysleep-scales').textContent = '缩放尺度：原流程 ' + uv(result.preprocessing.original.scaleUv)
            + ' · 去漂移 ' + uv(result.preprocessing.detrended.scaleUv) + '。时间从 EDF 起点算起。'
            + (source.gapEvents > 0 ? '原采集存在丢帧。' : '');
        $('anysleep-files').textContent = '逐段 CSV：' + result.files.epochsCsv + ' · N3 区间 CSV：' + result.files.n3Csv;
        $('anysleep-result').hidden = false;
        mode.value = 'detrended';
        mvpFilter.value = 'candidate';
        showComparison();
        showMvp();
    }

    function showMvp() {
        const mvp = lastResult?.n3Mvp;
        const tbody = $('n3-mvp-rows');
        tbody.replaceChildren();
        $('n3-mvp-controls').hidden = $('n3-mvp-table').hidden = !mvp;
        if (!mvp) {
            $('n3-mvp-summary').textContent = lastResult?.n3MvpError || '未生成 MVP 证据，原分期对照仍可查看。';
            $('n3-mvp-files').textContent = '';
            return;
        }
        $('n3-mvp-summary').textContent = Object.entries(mvpStates).map(([key, label]) =>
            label + ' ' + mvp.counts[key] + ' 段').join(' · ');
        const filter = mvpFilter.value;
        const rows = mvp.rows.filter(row => filter === 'all' || row.status === filter
            || (filter === 'flagged' && ['candidate', 'review'].includes(row.status))
            || (filter === 'slow_review' && row.status === 'review' && row.strictSlowSeconds >= mvp.screen.minSlowSeconds));
        for (const row of rows) {
            const tr = tbody.insertRow();
            const modelText = [row.anysleepDetrended, row.yasa, row.caocao].map(label => label || '—').join(' / ');
            const reasons = [...row.reasons, ...row.warnings].map(key => mvpLabels[key] || key).join('、');
            for (const value of [clock(row.startSec) + '–' + clock(row.endSec), mvpStates[row.status], modelText,
                row.strictSlowSeconds.toFixed(2), reasons || '—']) tr.insertCell().textContent = value;
        }
        if (!rows.length) {
            const cell = tbody.insertRow().insertCell();
            cell.colSpan = 5;
            cell.textContent = '没有符合当前筛选的片段。未提示 N3 不等于没有 N3。';
        }
        $('n3-mvp-files').textContent = '逐段证据 CSV：' + mvp.files.csv;
    }

    function showComparison() {
        if (!lastResult) return;
        const { commonEpochs, commonN3Counts, allN3, n3Disagreements, intervals } = lastResult.comparisons[mode.value];
        const n3 = Object.entries(commonN3Counts).map(([key, count]) => models[key] + ' ' + count).join(' · ');
        const key = mode.value === 'detrended' ? 'anysleepDetrended' : 'anysleep';
        const outside = lastResult.rows.filter(row => !row.caocao && (row[key] === 'N3' || row.yasa === 'N3')).length;
        $('anysleep-n3-summary').textContent = '共同可判读 ' + commonEpochs + ' / ' + lastResult.stats.epochCount
            + ' 段。共同片段的 N3 计数：' + n3 + '。一致 N3 ' + allN3
            + ' 段，N3 有分歧 ' + n3Disagreements + ' 段（红条）。'
            + (outside ? '另有 ' + outside + ' 段被 AnySleep 或 YASA 判为 N3，但曹操没有可用结果。' : '');
        const body = $('anysleep-intervals');
        body.replaceChildren();
        for (const interval of intervals.slice().sort((a, b) => b.epochs - a.epochs || a.startSec - b.startSec)) {
            const tr = body.insertRow();
            for (const value of [clock(interval.startSec), clock(interval.endSec),
                clock(interval.endSec - interval.startSec), interval.n3Models.map(key => models[key]).join('、')]) {
                tr.insertCell().textContent = value;
            }
        }
        if (!intervals.length) {
            const cell = body.insertRow().insertCell();
            cell.colSpan = 4;
            cell.textContent = commonEpochs ? '共同可判读的片段没有 N3 分歧。' : '三方没有共同可判读的片段。';
        }
        draw();
    }

    async function run(sessionId) {
        if (running) return;
        running = true;
        current.disabled = choose.disabled = true;
        const previous = status.textContent;
        status.textContent = '准备本机分期对照…';
        try {
            const result = await window.desktopAPI.runAnySleepComparison(sessionId);
            if (result) show(result);
            else status.textContent = previous;
        } catch (error) {
            status.textContent = error.message;
        } finally {
            running = false;
            current.disabled = choose.disabled = false;
        }
    }

    for (const [label, color] of Object.entries(colors)) {
        const node = document.createElement('span');
        const marker = document.createElement('i');
        marker.style.backgroundColor = color;
        node.append(marker, label);
        $('anysleep-legend').append(node);
    }
    current.addEventListener('click', () => {
        const sessionId = $('analysis-session-select').value;
        if (sessionId) void run(sessionId);
        else status.textContent = '请选择采集记录，或使用“打开 EDF 对照”。';
    });
    choose.addEventListener('click', () => { void run(null); });
    mode.addEventListener('change', showComparison);
    mvpFilter.addEventListener('change', showMvp);
    window.desktopAPI.onAnySleepProgress(text => { if (running) status.textContent = text; });
    new ResizeObserver(draw).observe(canvas);
}());
