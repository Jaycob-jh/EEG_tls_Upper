'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { packager } = require('@electron/packager');
const { bundlePython } = require('./package-python');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

function argument(name, fallback = '') {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseArgs() {
    const platform = argument('--platform', process.platform);
    const arch = argument('--arch', process.arch === 'ia32' ? 'ia32' : process.arch);
    const output = argument('--out', path.join(PROJECT_ROOT, 'dist'));
    const allowedPlatforms = new Set(['win32', 'darwin']);
    const allowedArchitectures = new Set(['x64', 'arm64']);
    if (!allowedPlatforms.has(platform)) throw new Error(`仅支持 Windows 或 macOS：${platform}`);
    if (!allowedArchitectures.has(arch)) throw new Error(`仅支持 x64 或 arm64：${arch}`);
    if (platform === 'win32' && arch !== 'x64') throw new Error('当前 Windows 成品固定为 x64');
    if (platform === 'darwin' && arch !== 'arm64') throw new Error('当前 macOS 成品固定为 Apple Silicon arm64');
    if (platform === 'darwin' && (process.platform !== 'darwin' || process.arch !== 'arm64')) {
        throw new Error('macOS arm64 成品必须在 Apple Silicon Mac 上构建');
    }
    return { platform, arch, output: path.resolve(output) };
}

function shouldIgnore(targetPlatform, relativePath) {
    const value = String(relativePath || '');
    const isAbsolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
    const relative = isAbsolute ? path.relative(PROJECT_ROOT, value) : value.replace(/^[/\\]+/, '');
    const normalized = `/${relative.replaceAll('\\', '/')}`;
    if (/^\/(artifacts|Data|dist|release|test|iOS|android|analysis|\.git|\.github|\.venv-yasa)(\/|$)/i.test(normalized)) return true;
    if (/(^|\/)(__pycache__|\.DS_Store)(\/|$)|\.pyc$/i.test(normalized)) return true;
    if (/^\/scripts\/(analyze-recorded-night|compare-watch-night)\.py$/i.test(normalized)) return true;
    if (/^\/node_modules\.backup[^/]*(\/|$)/i.test(normalized)) return true;
    if (targetPlatform === 'win32' && /\/node_modules\/onnxruntime-node\/bin\/napi-v6\/(darwin|linux)(\/|$)/i.test(normalized)) return true;
    if (targetPlatform === 'darwin' && /\/node_modules\/onnxruntime-node\/bin\/napi-v6\/(linux|win32)(\/|$)/i.test(normalized)) return true;
    return false;
}

async function main() {
    const { platform, arch, output } = parseArgs();
    const icon = platform === 'darwin' ? path.join(PROJECT_ROOT, 'assets', 'cao-cao-original.icns') : undefined;
    const options = {
        dir: PROJECT_ROOT,
        name: PACKAGE.productName,
        productName: PACKAGE.productName,
        platform,
        arch,
        out: output,
        overwrite: true,
        prune: true,
        asar: false,
        appBundleId: platform === 'darwin' ? 'com.caocao.eeg' : undefined,
        icon,
        ...(platform === 'darwin' ? { extendInfo: {
            NSBluetoothAlwaysUsageDescription: '连接 BrainLume 脑电设备，接收脑电数据并控制光照。',
            NSBluetoothPeripheralUsageDescription: '连接 BrainLume 脑电设备，接收脑电数据并控制光照。',
        } } : {}),
        ignore: filePath => shouldIgnore(platform, filePath),
        ...(process.env.BRAINLUME_ELECTRON_ZIP_DIR
            ? { electronZipDir: path.resolve(process.env.BRAINLUME_ELECTRON_ZIP_DIR) }
            : {}),
    };
    await fsp.mkdir(output, { recursive: true });
    console.log(`Packaging ${PACKAGE.productName} ${PACKAGE.version} for ${platform}-${arch}`);
    console.log(`Output: ${output}`);
    const appPaths = await packager(options);
    const packagedPath = appPaths[0];
    if (!packagedPath || !fs.existsSync(packagedPath)) throw new Error('Electron 打包完成但未找到输出目录');

    // @electron/packager returns the target output directory on macOS;
    // the signable bundle is the .app nested inside that directory.
    const appPath = platform === 'darwin'
        ? (packagedPath.endsWith('.app')
            ? packagedPath
            : path.join(packagedPath, `${PACKAGE.productName}.app`))
        : packagedPath;
    if (!fs.existsSync(appPath)) throw new Error(`Electron 打包完成但未找到应用包：${appPath}`);

    let executablePath;
    if (platform === 'win32') executablePath = path.join(appPath, `${PACKAGE.productName}.exe`);
    else executablePath = appPath;
    if (!fs.existsSync(executablePath)) throw new Error(`未找到目标启动文件：${executablePath}`);
    const bundledPython = platform === 'darwin'
        ? await bundlePython(PROJECT_ROOT, path.join(appPath, 'Contents/Resources/app')) : null;

    const manifest = {
        productName: PACKAGE.productName,
        version: PACKAGE.version,
        platform,
        arch,
        host: { platform: process.platform, arch: process.arch, node: process.version, os: os.release() },
        appPath,
        executablePath,
        asar: false,
        nativeRuntime: 'onnxruntime-node filtered for target platform',
        bundledPython,
        sourceCommit: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })(),
        builtAt: new Date().toISOString(),
    };
    // macOS code signing seals the bundle's Contents directory and rejects
    // arbitrary files placed beside Contents at the .app root.
    const manifestPath = platform === 'darwin'
        ? path.join(appPath, 'Contents', 'Resources', 'build-manifest.json')
        : path.join(appPath, 'build-manifest.json');
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // Sign after every bundle file has been written; otherwise the manifest
    // added above makes macOS report an unsealed application bundle.
    if (platform === 'darwin') {
        execFileSync('codesign', ['--deep', '--force', '--sign', '-', executablePath], { stdio: 'inherit' });
    }

    console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
    console.error(`Packaging failed: ${error.stack || error.message}`);
    process.exitCode = 1;
});
