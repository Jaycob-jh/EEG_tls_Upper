'use strict';
// Copy the local, tested YASA dependencies together with their Python runtime.
// A copied virtualenv alone keeps an absolute link to the build machine.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function bundlePython(project, resources) {
    const source = path.join(project, '.venv-yasa/bin/python');
    try { await fs.access(source); } catch { return null; }
    const info = JSON.parse(execFileSync(source, ['-I', '-c',
        'import sys,sysconfig,json;print(json.dumps(dict(base=sys.base_prefix,executable=sys.executable,stdlib=sysconfig.get_path("stdlib"),packages=sysconfig.get_path("purelib"),version=f"{sys.version_info.major}.{sys.version_info.minor}")))'], { encoding: 'utf8' }));
    const root = path.join(resources, '.venv-yasa');
    const filter = p => !p.split(path.sep).some(n => n === '__pycache__' || n === '.DS_Store') && !p.endsWith('.pyc');
    await fs.mkdir(path.join(root, 'bin'), { recursive: true });
    await fs.mkdir(path.join(root, 'lib'), { recursive: true });
    await fs.copyFile(await fs.realpath(source), path.join(root, 'bin/python'));
    await fs.chmod(path.join(root, 'bin/python'), 0o755);
    const stdlib = path.join(root, 'lib', `python${info.version}`);
    await fs.cp(info.stdlib, stdlib, { recursive: true, dereference: true,
        filter: p => filter(p) && !path.relative(info.stdlib, p).split(path.sep).includes('site-packages') });
    await fs.cp(info.packages, path.join(stdlib, 'site-packages'), { recursive: true, dereference: true, filter });
    const libs = path.join(info.base, 'lib');
    for (const entry of await fs.readdir(libs)) {
        if (entry.endsWith('.dylib')) await fs.copyFile(path.join(libs, entry), path.join(root, 'lib', entry));
    }
    // The wheel otherwise searches only Homebrew/MacPorts locations for OpenMP.
    const lightgbm = path.join(stdlib, 'site-packages/lightgbm/lib');
    const lightgbmLibrary = path.join(lightgbm, 'lib_lightgbm.dylib');
    await fs.copyFile(path.join(libs, 'libomp.dylib'), path.join(lightgbm, 'libomp.dylib'));
    execFileSync('install_name_tool', ['-add_rpath', '@loader_path', lightgbmLibrary]);
    execFileSync('codesign', ['--force', '--sign', '-', lightgbmLibrary]);
    const check = JSON.parse(execFileSync(path.join(root, 'bin/python'), ['-I', '-c',
        'import sys,json,yasa,mne,numpy;print(json.dumps(dict(prefix=sys.prefix,base=sys.base_prefix,yasa=yasa.__version__,mne=mne.__version__,numpy=numpy.__version__)))'], { encoding: 'utf8', timeout: 90000 }));
    if (path.resolve(check.prefix) !== path.resolve(root) || path.resolve(check.base) !== path.resolve(root)) {
        throw new Error('Bundled Python still depends on the build machine prefix');
    }
    console.log(`Bundled Python ${info.version}, YASA ${check.yasa}`);
    return { version: info.version, yasa: check.yasa, mne: check.mne, numpy: check.numpy, isolatedPrefixVerified: true };
}

module.exports = { bundlePython };
