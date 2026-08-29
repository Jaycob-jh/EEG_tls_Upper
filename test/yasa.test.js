const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(projectRoot, relative), 'utf8');

test('analysis page exposes the independent YASA verification entry point', () => {
    const html = read('src/index.html');
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
