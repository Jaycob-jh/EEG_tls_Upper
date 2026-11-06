'use strict';

const { compareEdf } = require('../src/anysleep-comparison');

async function main() {
    const [edfPath, outputRoot, python, assetsDir] = process.argv.slice(2);
    if (!edfPath || !outputRoot) {
        throw new Error('用法：node scripts/compare-anysleep.js <CH2.edf> <输出目录> [Python 路径] [AnySleep 资产目录]');
    }
    const result = await compareEdf({ edfPath, outputRoot, python, assetsDir }, text => console.log(text));
    console.log(JSON.stringify({ files: result.files, stats: result.stats, cached: !!result.cached,
        n3Mvp: result.n3Mvp ? { counts: result.n3Mvp.counts, files: result.n3Mvp.files } : null }));
    if (result.n3MvpError) {
        console.error(result.n3MvpError);
        process.exitCode = 2;
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
