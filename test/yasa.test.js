const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(projectRoot, relative), 'utf8');

test('analysis page exposes the independent YASA verification entry point', () => {
    const html = read('src/analysis.html');
    const ui = read('src/analysis-ui.js');
    const main = read('main.js');
    const preload = read('preload.js');
    assert.match(html, /id="analysis-yasa-button"/);
    assert.match(html, /YASA 离线睡眠分期复核/);
    assert.match(ui, /window\.desktopAPI\.runYasaStaging/);
    assert.match(main, /ipcMain\.handle\('analysis:yasa'/);
    assert.match(preload, /runYasaStaging/);
});

test('analysis page exposes persisted online staging history for each selected session', () => {
    const html = read('src/analysis.html');
    const ui = read('src/analysis-ui.js');
    const main = read('main.js');
    const preload = read('preload.js');
    const analysisPreload = read('analysis-preload.js');
    assert.match(html, /ONLINE STAGING HISTORY/);
    assert.match(html, /id="analysis-online-staging-body"/);
    assert.match(html, /id="analysis-online-staging-refresh"/);
    assert.match(ui, /loadOnlineStagingHistory/);
    assert.match(ui, /当前因果/);
    assert.match(ui, /中心回顾/);
    assert.match(main, /ipcMain\.handle\('session:staging-history'/);
    assert.match(main, /parseSessionStagingHistory/);
    assert.match(preload, /loadSessionStagingHistory/);
    assert.match(analysisPreload, /loadSessionStagingHistory/);
});

test('analysis page exposes the deduplicated online EEG sleep-structure summary', () => {
    const html = read('src/analysis.html');
    const ui = read('src/analysis-ui.js');
    const worker = read('analysis-worker.js');
    assert.match(html, /ONLINE EEG SLEEP STRUCTURE/);
    assert.match(html, /id="analysis-sleep-structure-body"/);
    assert.match(ui, /function renderSleepStructure/);
    assert.match(ui, /n3CandidateEpochs/);
    assert.match(ui, /n3SuppressedEpochs/);
    assert.match(html, /不是 PSG 或 YASA 金标准/);
    assert.match(worker, /computeOnlineSleepMetrics\(recording\.events\)/);
});

test('YASA integration preserves the raw-data boundary and removes the redundant channel button', () => {
    const html = read('src/index.html');
    const app = read('src/app.js');
    assert.doesNotMatch(html, /configure-channel-button/);
    assert.doesNotMatch(app, /configure-channel-button/);
    assert.match(read('python/yasa_offline_staging.py'), /eeg_raw\.csv/);
    assert.match(read('python/yasa_offline_staging.py'), /analysis\/yasa/);
    assert.match(read('python/yasa_offline_staging.py'), /voltage_uv/);
});

test('YASA uses the project virtual environment before system Python', () => {
    const main = read('main.js');
    const script = read('python/yasa_offline_staging.py');
    const requirements = read('python/requirements-yasa.txt');
    assert.match(main, /\.venv-yasa/);
    assert.match(main, /BRAINLUME_PYTHON/);
    assert.match(main, /const failures = \[\]/);
    assert.match(script, /project_python/);
    assert.match(requirements, /\.venv-yasa\/bin\/python/);
});

test('records page opens a non-modal analysis window and exposes useful native file actions', () => {
    const html = read('src/index.html');
    const analysisHtml = read('src/analysis.html');
    const app = read('src/app.js');
    const ui = read('src/analysis-ui.js');
    const main = read('main.js');
    const css = read('src/styles.css');
    assert.doesNotMatch(html, /data-page="analysis"/);
    assert.doesNotMatch(html, /id="analysis-dialog"/);
    assert.match(analysisHtml, /class="analysis-window-content"/);
    assert.match(analysisHtml, /id="analysis-dialog-close"/);
    assert.doesNotMatch(html, /id="screenshot-button"/);
    assert.match(app, /openAnalysisWindow/);
    assert.match(ui, /async function openForSession\(sessionId\)/);
    assert.match(ui, /closeAnalysisWindow/);
    assert.match(ui, /state\.opening/);
    assert.match(main, /function configureApplicationMenu()/);
    assert.match(main, /analysis-window:open/);
    assert.match(main, /label: '隐藏当前窗口'/);
    assert.match(main, /accelerator: 'Command\+H'/);
    assert.match(main, /if \(window\) window\.hide\(\)/);
    assert.doesNotMatch(main, /parent:\s*mainWindow/);
    assert.match(main, /role: 'windowMenu'/);
    assert.match(main, /for \(const window of windows\) window\.show\(\)/);
    assert.match(main, /modal: false/);
    assert.match(main, /analysis-preload\.js/);
    assert.match(read('analysis-preload.js'), /analysis:viewport/);
    assert.match(main, /打开数据目录/);
    assert.match(main, /导出当前分析报告/);
    assert.match(main, /保存当前页面截图/);
    assert.match(css, /\.analysis-window-content\s*\{/);
});

test('analysis loading state exposes an inline progress bar in the empty view', () => {
    const html = read('src/analysis.html');
    const ui = read('src/analysis-ui.js');
    const css = read('src/styles.css');
    assert.match(html, /id="analysis-empty-progress"/);
    assert.match(html, /id="analysis-empty-progress-bar"/);
    assert.match(ui, /function updateEmptyState/);
    assert.match(ui, /analysis-empty-percent/);
    assert.match(css, /\.analysis-empty-progress\s*\{/);
    assert.match(css, /\.analysis-empty\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
    assert.match(ui, /function hideEmptyState/);
    assert.match(ui, /hideEmptyState\(\)/);
});

test('analysis completion waits for the result transfer before showing 100 percent', () => {
    const worker = read('analysis-worker.js');
    const main = read('main.js');
    const ui = read('src/analysis-ui.js');
    assert.match(worker, /progress\('complete', 96/);
    assert.match(worker, /includeEpochs: payload\.includeEpochs !== false/);
    assert.match(worker, /includeSpectra: payload\.includeSpectra !== false/);
    assert.match(main, /includeEpochs: false/);
    assert.match(main, /includeSpectra: false/);
    assert.match(ui, /载入分析结果/);
    assert.match(ui, /分析结果返回较慢/);
});

test('home schedule wording separates daily execution, immediate runs and manual impedance checks', () => {
    const html = read('src/index.html');
    const app = read('src/app.js');
    assert.match(html, /下次执行/);
    assert.match(html, /立即运行选择（不改变每日调度）/);
    assert.match(html, /手动检测阻抗/);
    assert.match(app, /function formatScheduledDateTime/);
    assert.match(app, /来源：\$\{escapeHtml\(dailySource\(next\.plan\)\)\}/);
});
