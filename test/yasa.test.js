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
});
