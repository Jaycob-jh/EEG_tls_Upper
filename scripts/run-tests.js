'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const testRoot = path.join(projectRoot, 'test');
const testFiles = fs.readdirSync(testRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => path.join(testRoot, entry.name))
    .sort();

if (testFiles.length === 0) {
    console.error(`未找到测试文件：${testRoot}`);
    process.exitCode = 1;
} else {
    const result = spawnSync(process.execPath, ['--test', ...testFiles], {
        cwd: projectRoot,
        stdio: 'inherit',
    });

    if (result.error) {
        console.error(result.error.stack || result.error.message);
        process.exitCode = 1;
    } else {
        process.exitCode = result.status ?? 1;
    }
}
