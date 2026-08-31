'use strict';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}

function number(value, digits = 2) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--';
}

function duration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value % 3600 / 60);
    const rest = Math.floor(value % 60);
    return hours ? `${hours}h ${minutes}m ${rest}s` : `${minutes}m ${rest}s`;
}

function svgEnvelope(chart, options = {}) {
    const width = 1040;
    const height = options.height || 250;
    const left = 58, right = 18, top = 20, bottom = 34;
    const lows = chart.lows || chart.samples || [];
    const highs = chart.highs || chart.samples || [];
    const values = [...lows, ...highs].filter(Number.isFinite);
    let minimum = values.length ? Math.min(...values) : -1;
    let maximum = values.length ? Math.max(...values) : 1;
    if (maximum - minimum < 1e-9) { minimum -= 1; maximum += 1; }
    const x = index => left + index * (width - left - right) / Math.max(1, lows.length - 1);
    const y = value => top + (maximum - value) * (height - top - bottom) / (maximum - minimum);
    const upper = highs.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    const lower = lows.map((value, index) => `L${x(lows.length - 1 - index).toFixed(1)},${y(lows[lows.length - 1 - index]).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${height}" fill="#fbfdfe"/>
        ${[0, .25, .5, .75, 1].map(step => `<line x1="${left}" x2="${width - right}" y1="${top + step * (height - top - bottom)}" y2="${top + step * (height - top - bottom)}" stroke="#dbe4e9"/>`).join('')}
        <path d="${upper} ${lower} Z" fill="rgba(0,143,114,.18)" stroke="#008f72" stroke-width="1.4"/>
        <text x="4" y="${top + 4}" fill="#526672" font-size="12">${number(maximum, 1)} µV</text>
        <text x="4" y="${height - bottom}" fill="#526672" font-size="12">${number(minimum, 1)} µV</text>
        <text x="${left}" y="${height - 8}" fill="#526672" font-size="12">${escapeHtml(options.startLabel || '记录开始')}</text>
        <text x="${width - right}" y="${height - 8}" text-anchor="end" fill="#526672" font-size="12">${escapeHtml(options.endLabel || '记录结束')}</text>
    </svg>`;
}

function svgSpectrum(phases) {
    const width = 1040, height = 280, left = 58, right = 18, top = 20, bottom = 38;
    const colors = { before: '#1769e0', during: '#e74d3c', after: '#008f72' };
    const labels = { before: '刺激前', during: '刺激中', after: '刺激后' };
    const all = Object.values(phases || {}).flatMap(phase => phase.psd?.power || []).filter(value => value > 0);
    const max = Math.max(1e-12, ...all);
    const min = Math.max(1e-12, max / 1e5);
    const x = frequency => left + frequency / 60 * (width - left - right);
    const y = value => top + (Math.log10(max) - Math.log10(Math.max(min, value))) / (Math.log10(max) - Math.log10(min)) * (height - top - bottom);
    const lines = Object.entries(phases || {}).map(([id, phase]) => {
        const path = (phase.psd?.frequencies || []).map((frequency, index) => frequency > 60 ? '' : `${index ? 'L' : 'M'}${x(frequency).toFixed(1)},${y(phase.psd.power[index]).toFixed(1)}`).join(' ');
        return `<path d="${path}" fill="none" stroke="${colors[id]}" stroke-width="2"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#fbfdfe"/>
        ${[0,10,20,30,40,50,60].map(frequency => `<line x1="${x(frequency)}" x2="${x(frequency)}" y1="${top}" y2="${height-bottom}" stroke="#dbe4e9"/><text x="${x(frequency)}" y="${height-12}" text-anchor="middle" fill="#526672" font-size="12">${frequency}</text>`).join('')}
        ${lines}${Object.keys(colors).map((id, index) => `<line x1="${left + index*110}" x2="${left+20+index*110}" y1="12" y2="12" stroke="${colors[id]}" stroke-width="3"/><text x="${left+26+index*110}" y="16" fill="#334b57" font-size="12">${labels[id]}</text>`).join('')}
        <text x="${width/2}" y="${height-1}" text-anchor="middle" fill="#526672" font-size="12">频率 (Hz)</text></svg>`;
}

function svgBands(phases) {
    const bands = ['delta', 'theta', 'alpha', 'beta', 'gamma', 'stimulus40'];
    const labels = ['Delta', 'Theta', 'Alpha', 'Beta', 'Gamma', '39-41Hz'];
    const colors = { before: '#1769e0', during: '#e74d3c', after: '#008f72' };
    const values = Object.values(phases || {}).flatMap(phase => bands.map(id => phase.bandPowers?.[id]?.relativePercent || 0));
    const maximum = Math.max(10, ...values) * 1.1;
    const width = 1040, height = 280, left = 54, right = 18, top = 20, bottom = 42;
    const plotW = width-left-right, groupW = plotW/bands.length, barW = groupW/5;
    return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#fbfdfe"/>
        ${bands.map((band, bandIndex) => `${Object.keys(colors).map((id, phaseIndex) => { const value=phases?.[id]?.bandPowers?.[band]?.relativePercent||0; const h=value/maximum*(height-top-bottom); return `<rect x="${left+bandIndex*groupW+(phaseIndex+1)*barW}" y="${height-bottom-h}" width="${barW-4}" height="${h}" fill="${colors[id]}"/>`; }).join('')}<text x="${left+(bandIndex+.5)*groupW}" y="${height-16}" text-anchor="middle" fill="#526672" font-size="12">${labels[bandIndex]}</text>`).join('')}
        <text x="8" y="16" fill="#526672" font-size="12">相对功率 %</text></svg>`;
}

function svgEpochs(epochs) {
    const width = 1040, height = 150, left = 48, right = 18, top = 20, bottom = 32;
    const max = Math.max(150, ...epochs.map(epoch => epoch.robustRangeUv || 0));
    const x = index => left + index * (width-left-right) / Math.max(1, epochs.length);
    const y = value => top + (max-value)/max*(height-top-bottom);
    return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="#fbfdfe"/>
        <line x1="${left}" x2="${width-right}" y1="${y(150)}" y2="${y(150)}" stroke="#e74d3c" stroke-dasharray="5 4"/>
        ${epochs.map((epoch,index)=>`<rect x="${x(index)}" y="${y(epoch.robustRangeUv)}" width="${Math.max(1,(width-left-right)/Math.max(1,epochs.length)-1)}" height="${height-bottom-y(epoch.robustRangeUv)}" fill="${epoch.rejected?'#e74d3c':'#18a77b'}"/>`).join('')}
        <text x="6" y="${y(150)+4}" fill="#b4382c" font-size="11">150µV</text><text x="${width/2}" y="${height-8}" text-anchor="middle" fill="#526672" font-size="12">30 秒 epoch</text></svg>`;
}

function metricRow(label, value, note = '') {
    return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td><td>${escapeHtml(note)}</td></tr>`;
}

function buildReportHtml(data) {
    const metadata = data.metadata || {};
    const integrity = data.integrity || {};
    const metrics = data.metrics || {};
    const firstPhases = data.phaseMetrics?.[0]?.phases || {};
    const rejectedPercent = integrity.epochs ? integrity.rejectedEpochs / integrity.epochs * 100 : 0;
    const phaseRows = (data.phaseMetrics || []).map((segment, index) => `<tr><td>${index+1}</td><td>CH${segment.channel}</td><td>${number(segment.startSec,1)}-${number(segment.endSec,1)}s</td><td>${number(segment.phases.before.rmsUv)} / ${number(segment.phases.during.rmsUv)} / ${number(segment.phases.after.rmsUv)}</td><td>${number(segment.phases.during.changeFromBeforePercent.stimulus40,1)}%</td></tr>`).join('');
    const sleep = data.onlineSleepMetrics || {};
    const sleepLabels = { W: 'Wake（W）', N1: 'N1', N2: 'N2', N3: 'N3', REM: 'REM' };
    const sleepBouts = sleep.longestBouts || sleep.longestBoutSeconds || {};
    const sleepRows = Object.entries(sleepLabels).map(([stage, label]) => `<tr><th>${label}</th><td>${Number(sleep.stageCounts?.[stage] || 0)}</td><td>${duration(sleep.stageDurationsSeconds?.[stage])}</td><td>${number(sleep.stagePercentages?.[stage], 1)}%</td><td>${duration(sleepBouts[stage])}</td></tr>`).join('');
    const sleepSection = Number(sleep.recordCount) ? `<h2>3. 在线 EEG 睡眠结构</h2><table><thead><tr><th>分期</th><th>可评分 epoch</th><th>时长</th><th>占可评分比例</th><th>最长连续段</th></tr></thead><tbody>${sleepRows}</tbody></table><table>${metricRow('总睡眠时长', duration(sleep.totalSleepSeconds))}${metricRow('睡眠效率', `${number(sleep.sleepEfficiencyPercent, 1)}%`, '仅在可评分 epoch 内计算')}${metricRow('睡眠起点', sleep.sleepOnsetSeconds == null ? '--' : `${number(sleep.sleepOnsetSeconds, 1)} s`, '相对记录开始，不等于熄灯时间')}${metricRow('入睡后清醒 WASO', duration(sleep.wasoSeconds))}${metricRow('阶段转换', Number(sleep.transitionCount || 0))}${metricRow('最长 N3', duration(sleepBouts.N3))}${metricRow('N3 候选 / 确认 / 未通过', `${Number(sleep.n3CandidateEpochs || 0)} / ${Number(sleep.n3ConfirmedEpochs || 0)} / ${Number(sleep.n3SuppressedEpochs || 0)}`)}${metricRow('质量拒绝 / 未评分', `${Number(sleep.qualityRejectedEpochs || 0)} / ${Number(sleep.unknownEpochs || 0)}`)}</table><div class="notice">仅基于去重后的在线 EEG 模型输出；不是 PSG 或 YASA 金标准，质量拒绝与 UNKNOWN 不计入结构统计。</div>` : '<h2>3. 在线 EEG 睡眠结构</h2><div class="notice">该会话没有可评分的在线 EEG 分期结果。</div>';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
        @page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:"Microsoft YaHei","Segoe UI",sans-serif;color:#1c303a;font-size:11px;margin:0}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;border-bottom:2px solid #1769e0;padding-bottom:5px;margin:22px 0 10px}h3{font-size:13px;margin:14px 0 6px}.muted{color:#657680}.notice{padding:9px 12px;background:#fff6df;border-left:3px solid #e5a800;margin:10px 0}.chart{border:1px solid #dbe4e9;margin:8px 0 12px;break-inside:avoid}.chart svg{display:block;width:100%}table{border-collapse:collapse;width:100%;margin:7px 0 12px;break-inside:avoid}th,td{border:1px solid #dbe4e9;padding:6px;text-align:left}th{background:#f2f6f8}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:10px 0}.kpi{border:1px solid #dbe4e9;padding:9px}.kpi strong{display:block;font-size:16px;color:#1769e0}.page-break{break-before:page}.footer{margin-top:24px;color:#657680;border-top:1px solid #dbe4e9;padding-top:8px}</style></head><body>
        <h1>BrainLume EEG 数据分析报告</h1><div class="muted">生成时间：${escapeHtml(data.generatedAt)} · 会话：${escapeHtml(metadata.planName || '手动采集')} · CH${escapeHtml(metadata.selectedChannel || 2)}</div>
        <div class="notice">本报告仅用于研究和数据质量评估，不构成医疗诊断，也不等同于正式睡眠分期。</div>
        <div class="kpis"><div class="kpi"><span>有效样本</span><strong>${Number(integrity.validSamples||0).toLocaleString()}</strong></div><div class="kpi"><span>记录时长</span><strong>${number(data.durationSeconds/60,1)} min</strong></div><div class="kpi"><span>可用 epoch</span><strong>${number(integrity.usableEpochPercent,1)}%</strong></div><div class="kpi"><span>Seq 缺口</span><strong>${Number(integrity.seqGaps||0).toLocaleString()}</strong></div></div>
        <h2>1. 全记录波形</h2><div class="chart" data-chart="overview">${svgEnvelope(data.charts.overview,{endLabel:`${number(data.durationSeconds/60,1)} min`})}</div>
        <h2>2. 数据质量</h2><table>${metricRow('实际采样率',`${number(integrity.effectiveSampleRateHz,2)} Hz`)}${metricRow('滤波 RMS',`${number(metrics.filteredRmsUv)} µV`)}${metricRow('稳健幅度范围',`${number(metrics.robustRangeUv)} µV`)}${metricRow('峰峰值',`${number(metrics.filteredPeakToPeakUv)} µV`)}${metricRow('原始绝对中位偏置',`${number(metrics.rawAbsoluteMedianUv)} µV`)}${metricRow('分钟基线变化范围',`${number(metrics.baselineRangeUv)} µV`)}${metricRow('50Hz 干扰',`${number(metrics.interference50HzRmsUv)} µV RMS`)}${metricRow('严重伪迹 epoch',`${integrity.rejectedEpochs||0}/${integrity.epochs||0}`,`${number(rejectedPercent,1)}%`)}</table>
        <div class="chart" data-chart="epochs">${svgEpochs(data.epochs||[])}</div>
        ${sleepSection}
        <h2 class="page-break">4. 原始与滤波波形</h2><h3>原始波形</h3><div class="chart" data-chart="raw">${svgEnvelope(data.charts.comparison.raw,{startLabel:`${number(data.charts.comparison.startSec,1)} s`,endLabel:`${number(data.charts.comparison.startSec+10,1)} s`})}</div><h3>零相位 0.5–45Hz + 50Hz 陷波</h3><div class="chart" data-chart="filtered">${svgEnvelope(data.charts.comparison.filtered,{startLabel:`${number(data.charts.comparison.startSec,1)} s`,endLabel:`${number(data.charts.comparison.startSec+10,1)} s`})}</div>
        <h2>5. 光刺激前、中、后对比</h2>${data.phaseMetrics?.length?`<div class="chart" data-chart="spectrum">${svgSpectrum(firstPhases)}</div><div class="chart" data-chart="bands">${svgBands(firstPhases)}</div><table><thead><tr><th>序号</th><th>通道</th><th>刺激区间</th><th>前/中/后 RMS (µV)</th><th>39–41Hz 中期变化</th></tr></thead><tbody>${phaseRows}</tbody></table>`:'<div class="notice">该会话没有完整的光刺激开始/停止事件，未生成阶段对比。</div>'}
        <h2>6. 结论边界</h2><p>分析使用一条双极 EEG 导联（两枚互为参考电极）。频带变化可能同时受到生理响应、刺激电路耦合、运动伪迹和时间进程影响，不能单独解释为临床疗效或自然睡眠阶段变化。</p>
        <div class="footer">曹操 v0.3.1 · 原始数据文件：${escapeHtml(data.metadata?.directory||'会话目录')}</div>
    </body></html>`;
}

function epochsCsv(epochs) {
    return ['epoch,start_sec,end_sec,rms_uv,robust_range_uv,rejected', ...(epochs || []).map(epoch =>
        [epoch.index, epoch.startSec, epoch.endSec, epoch.rmsUv, epoch.robustRangeUv, epoch.rejected ? 1 : 0].join(','))].join('\n') + '\n';
}

function phaseMetricsCsv(segments) {
    const header = 'segment,channel,source,phase,start_sec,end_sec,rms_uv,peak_to_peak_uv,robust_range_uv,delta_pct,theta_pct,alpha_pct,beta_pct,gamma_pct,stimulus40_pct';
    const rows = [];
    for (let index = 0; index < (segments || []).length; index++) for (const phaseId of ['before','during','after']) {
        const segment = segments[index]; const phase = segment.phases[phaseId]; const bands = phase.bandPowers;
        rows.push([index+1,segment.channel,segment.source,phaseId,phase.startSec,phase.endSec,phase.rmsUv,phase.peakToPeakUv,phase.robustRangeUv,
            bands.delta.relativePercent,bands.theta.relativePercent,bands.alpha.relativePercent,bands.beta.relativePercent,bands.gamma.relativePercent,bands.stimulus40.relativePercent].join(','));
    }
    return [header, ...rows].join('\n') + '\n';
}

module.exports = { buildReportHtml, epochsCsv, phaseMetricsCsv };
