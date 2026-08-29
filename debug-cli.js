'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const COMMANDS = new Set(['discover', 'status', 'read-registers', 'config-eeg', 'start-eeg', 'stop-all', 'raw']);
function numberOption(value, name, min, max) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return parsed;
}
function parseArgs(argv) {
    const command = argv[0];
    if (!COMMANDS.has(command)) throw new Error(`command must be one of: ${Array.from(COMMANDS).join(', ')}`);
    const output = { command };
    for (let index = 1; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--impedance') output.impedance = true;
        else if (arg === '--channel') output.channel = numberOption(argv[++index], 'channel', 1, 8);
        else if (arg === '--seconds') output.seconds = numberOption(argv[++index], 'seconds', 1, 3600);
        else if (arg === '--addr') output.addr = numberOption(argv[++index], 'addr', 0, 255);
        else if (arg === '--func') output.func = numberOption(argv[++index], 'func', 0, 255);
        else if (arg === '--stat') output.stat = numberOption(argv[++index], 'stat', 0, 255);
        else if (arg === '--data') output.data = Array.from((argv[++index] || '').replace(/\s+/g, '').match(/.{1,2}/g) || [], value => numberOption(`0x${value}`, 'data byte', 0, 255));
        else throw new Error(`unknown option: ${arg}`);
    }
    if (command === 'config-eeg' || command === 'start-eeg') output.channel ??= 2;
    if (command === 'start-eeg') output.seconds ??= 3;
    if (command === 'raw' && (output.addr == null || output.func == null || output.stat == null)) throw new Error('raw requires --addr, --func and --stat');
    return output;
}
function printError(error) { process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: error.message } })}\n`); }

if (require.main === module) {
    let request;
    try { request = parseArgs(process.argv.slice(2)); } catch (error) { printError(error); process.exitCode = 2; }
    if (request) {
        const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
        const electron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
        const child = spawn(electron, ['.', '--debug-cli', `--debug-command=${encoded}`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let output = ''; child.stdout.on('data', chunk => { output += chunk; });
        child.on('close', code => { process.stdout.write(output || `${JSON.stringify({ ok: false, error: { code: 'NO_DEBUG_RESULT', message: `debug process exited with code ${code}` } })}\n`); process.exitCode = code || 0; });
    }
}

module.exports = { parseArgs };
