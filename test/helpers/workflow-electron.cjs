'use strict';
// Run the real application against a disposable profile and document directory.
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog } = require('electron');
const root = process.env.CAOCAO_WORKFLOW_DIR;
if (!root) throw new Error('CAOCAO_WORKFLOW_DIR is required');
for (const dir of ['profile', 'documents', 'app-data']) fs.mkdirSync(path.join(root, dir), { recursive: true });
app.setPath('appData', path.join(root, 'app-data'));
const appendFile = fs.promises.appendFile.bind(fs.promises);
fs.promises.appendFile = async (file, ...args) => {
    const marker = path.join(root, 'fail-next-raw-write');
    if (String(file).startsWith(root) && String(file).endsWith('raw_adc.bin.partial') && fs.existsSync(marker)) {
        fs.unlinkSync(marker);
        throw Object.assign(new Error('模拟磁盘空间不足（测试）'), { code: 'ENOSPC' });
    }
    return appendFile(file, ...args);
};
require(process.env.CAOCAO_WORKFLOW_MAIN || '../../main');
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'profile'));
app.setPath('documents', path.join(root, 'documents'));
app.on('browser-window-created', (_event, window) => {
    window.on('page-title-updated', event => { event.preventDefault(); window.setTitle('软件流程测试（模拟设备）'); });
});
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(root, 'report.pdf') });
// Keep report export inside this disposable workspace.
const { shell } = require('electron');
shell.openPath = async () => '';
process.on('SIGTERM', () => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.quit();
});
