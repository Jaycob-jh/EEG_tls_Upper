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
    assert.match(html, /保存截图/);
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
    assert.match(css, /\.analysis-window-content\s*\{/);
});
