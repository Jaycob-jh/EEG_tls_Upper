'use strict';
// Real Electron UI, IPC, ONNX, recording files and analysis; simulated Bluetooth only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { decodeRawRecords } = require('../src/raw-recording');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caocao-workflow-run-'));
let executable = process.env.CAOCAO_WORKFLOW_APP;
let isolatedApp = null;
if (!executable) {
    assert.equal(process.platform, 'darwin', 'This workflow runner currently requires macOS');
    // Keep the app bundle path short for macOS helper-process launch paths.
    isolatedApp = path.join(fs.mkdtempSync('/tmp/caocao-workflow-app-'), 'Workflow.app');
    const packaged = process.env.CAOCAO_WORKFLOW_BUNDLE || path.join(root, 'dist/曹操-darwin-arm64/曹操.app');
    console.log('正在准备独立测试环境…');
    const copied = spawnSync('/bin/cp', ['-cR', packaged, isolatedApp], { encoding: 'utf8' });
    if (copied.status !== 0) throw Error(copied.stderr);
    const resources = path.join(isolatedApp, 'Contents/Resources/app');
    const metadata = JSON.parse(fs.readFileSync(path.join(resources, 'package.json'), 'utf8'));
    metadata.main = 'workflow-entry.cjs';
    fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(resources, 'workflow-entry.cjs'), `require(${JSON.stringify(path.join(root, 'test/helpers/workflow-electron.cjs'))});\n`);
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', isolatedApp], { encoding: 'utf8' });
    if (signed.status !== 0) throw Error(signed.stderr);
    executable = path.join(isolatedApp, 'Contents/MacOS/曹操');
}
const port = Number(process.env.CAOCAO_WORKFLOW_PORT || 9339);
const results = [], connections = [], exceptions = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: { ...process.env,
        ...(isolatedApp && !process.env.CAOCAO_WORKFLOW_MAIN ? { CAOCAO_WORKFLOW_MAIN: path.join(isolatedApp, 'Contents/Resources/app/main.js') } : {}),
        CAOCAO_WORKFLOW_DIR: output }, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
child.on('error', error => { logs += `\nLaunch failed: ${error.stack}`; });
async function targets() { return (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
async function connect(fragment) {
    let target;
    for (let i = 0; i < 600; i++) {
        try { target = (await targets()).find(tab => tab.url.includes(fragment)); } catch { /* booting */ }
        if (target) break;
        await wait(100);
    }
    assert.ok(target, `Missing page ${fragment}`);
    const socket = new WebSocket(target.webSocketDebuggerUrl), pending = new Map(); let sequence = 0;
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
        if (!message.id) return;
        const request = pending.get(message.id); if (!request) return;
        pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
        for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('Debug target closed'));}
        pending.clear();
    });
    function call(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 60000);
            pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async function evaluate(expression) {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result?.value;
    }
    const page = { id:target.id, call, evaluate, close: () => socket.close() }; connections.push(page);
    await call('Runtime.enable'); return page;
}
async function until(page, expression, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await page.evaluate(expression)) return; await wait(50); }
    throw new Error(`Timed out waiting for ${expression}`);
}
async function step(name, run) {
    const start = Date.now();
    try { const detail = await run(); results.push({ name, ok: true, ms: Date.now() - start, detail }); console.log(`PASS ${name}`); return detail; }
    catch (error) { results.push({ name, ok: false, ms: Date.now() - start, error: error.stack }); console.log(`FAIL ${name}: ${error.message}`); throw error; }
}
async function screenshot(page, name) {
    const result = await page.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'));
}
async function configure(page, { shadow = true, stage = 'N3', consecutive = 2 } = {}) {
    await page.evaluate(`(() => {
        document.querySelector('[data-page="device"]').click(); document.querySelector(document.querySelector('#simple-light-title').textContent === '手动光照' ? '#simple-manual-light' : '#simple-n3-settings').click();
        for(const input of document.querySelectorAll('#target-stage-selector input')) input.checked = (input.id==='sleep-stimulus-n3-enabled' ? 'N3' : input.value) === ${JSON.stringify(stage)};
        for(const [id,value] of Object.entries({'sleep-stimulus-n3-mode':'probability','sleep-stimulus-n3-probability':'70','sleep-stimulus-other-confidence':'70','sleep-stimulus-consecutive':${JSON.stringify(String(consecutive))},'sleep-stimulus-channel':'1','sleep-stimulus-frequency':'40','sleep-stimulus-power':'5','sleep-stimulus-duration':'1','sleep-stimulus-cooldown':'1'})) document.getElementById(id).value=value;
        document.querySelector('#sleep-stimulus-shadow-mode').checked=${shadow}; document.querySelector('#sleep-stimulus-save').click();
    })()`);
    await until(page, `JSON.parse(localStorage.getItem('sleepStimulusProtocol') || '{}').targetStages?.includes(${JSON.stringify(stage)})`);
    await page.evaluate(`document.querySelector('#sleep-stimulus-settings-dialog').close()`);
}
async function feedEpoch(page, mode = 'normal') {
    const before = await page.evaluate(`document.querySelector('#realtime-epoch').textContent`);
    await page.evaluate(`workflowDevice.feed(7500, ${JSON.stringify(mode)})`);
    await until(page, `document.querySelector('#realtime-epoch').textContent !== ${JSON.stringify(before)}`);
    await until(page, `!/正在判断|正在更新/.test(document.querySelector('#realtime-inference-state').textContent)`);
}
(async () => {
    let page;
    try {
        page = await connect('/src/index.html');
        const injected = fs.readFileSync(path.join(root, 'test/helpers/simulated-bluetooth.js'), 'utf8');
        await until(page, `document.querySelector('#realtime-model')?.textContent === '已就绪'`);
        await page.evaluate(injected);
        if (process.argv.includes('--gui-only')) {
            await require('../test/helpers/gui-review.cjs').run({page,connect,until,step,screenshot,output,root});
            await step('GUI：页面没有未处理异常',async()=>assert.deepEqual(exceptions,[]));
            return;
        }
        await step('未连接时禁止采集和手动开灯', async () => {
            assert.equal(await page.evaluate(`document.querySelector('#eeg-toggle-button').disabled`), true);
            await page.evaluate(`document.querySelector(document.querySelector('#simple-light-title').textContent === '手动光照' ? '#simple-n3-settings' : '#simple-manual-light').click()`);
            assert.equal(await page.evaluate(`document.querySelector('#home-light-start').disabled`), true);
            await page.evaluate(`document.querySelector('#manual-stimulus-settings-dialog').close()`);
        });
        await step('连接模拟设备并确认状态（真实 BLE 传输类和协议解析）', async () => {
            await page.evaluate(`document.querySelector('#connect-button').click()`);
            await until(page, `document.querySelector('#simple-device-status').textContent === '已连接' && document.querySelector('#metric-battery').textContent === '80%'`);
            assert.equal(await page.evaluate(`workflowDevice.commands.filter(c=>c.func===0x12||c.func===0x13).some(c=>c.stat&1)`), false);
        });
        await step('指示灯与电极检测可独立运行，检测结束后恢复采集设置', async () => {
            await page.evaluate(`document.querySelector('#indicator-toggle-button').click()`);
            await until(page, `document.querySelector('#indicator-toggle-button').getAttribute('aria-pressed')==='true'`);
            await page.evaluate(`document.querySelector('#indicator-toggle-button').click()`);
            await until(page, `document.querySelector('#indicator-toggle-button').getAttribute('aria-pressed')==='false'`);
            await page.evaluate(`document.querySelector('#impedance-button').click()`);
            await until(page, `workflowDevice.eeg===true`);
            await page.evaluate(`(async()=>{await workflowDevice.feed(1,'saturated');await workflowDevice.feed(1023);})()`);
            assert.equal(await page.evaluate(`document.querySelector('#metric-impedance').textContent`), '-- kΩ');
            assert.equal(await page.evaluate(`workflowDevice.eeg`), true);
            await page.evaluate(`workflowDevice.feed(1)`);
            await until(page, `!document.querySelector('#impedance-button').disabled && workflowDevice.eeg===false`);
            assert.doesNotMatch(await page.evaluate(`document.querySelector('#metric-impedance').textContent`), /--/);
        });
        await configure(page);
        await step('开始采集，自动光照先以试运行开启', async () => {
            await page.evaluate(`workflowDevice.recordStartSamples=workflowDevice.samples;document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent === '正在采集'`);
            await page.evaluate(`document.querySelector('#simple-n3-toggle').click(); workflowDevice.overrideStage('N3')`);
            await until(page, `document.querySelector('#simple-n3-status').textContent.includes('试运行')`);
        });
        await step('完整数据不足时禁止触发', async () => {
            for (let i = 0; i < 20; i++) { await feedEpoch(page); if(i%5===4)console.log(`模拟脑电已完成 ${i+1} 段`); }
            assert.equal(await page.evaluate(`workflowDevice.commands.some(c=>(c.func===0x12||c.func===0x13)&&(c.stat&1))`), false);
            const sessions = await page.evaluate(`window.desktopAPI.listSessions()`);
            const events = fs.readFileSync(path.join(sessions[0].directory, 'events.jsonl'), 'utf8');
            assert.doesNotMatch(events, /sleep_stimulus_shadow_triggered/);
        });
        await step('满足 N3 条件后试运行记录命中，始终不开灯', async () => {
            await feedEpoch(page); await feedEpoch(page);
            await until(page, `document.querySelector('#sleep-stimulus-status').textContent.includes('试运行达标')`);
            assert.equal(await page.evaluate(`workflowDevice.light[1] || workflowDevice.light[2]`), false);
        });
        await step('N2 也可独立触发模拟光照，并按时停止', async () => {
            await configure(page, { stage: 'N2', shadow: false, consecutive: 1 });
            // A protocol edit intentionally retains the start-to-start interval.
            await page.evaluate(`document.querySelector('#simple-n3-toggle').click()`);
            await page.evaluate(`document.querySelector('#simple-n3-toggle').click(); workflowDevice.overrideStage('N2'); workflowDevice.advance(61000)`);
            await feedEpoch(page);
            // N3's exit confirmation needs another non-N3 epoch.
            await feedEpoch(page);
            await until(page, `workflowDevice.light[1] === true`);
            await until(page, `workflowDevice.light[1] === false`);
        });
        await step('手动开灯关闭自动触发，定时停止后不自动恢复', async () => {
            await page.evaluate(`document.querySelector(document.querySelector('#simple-light-title').textContent === '手动光照' ? '#simple-n3-settings' : '#simple-manual-light').click();document.querySelector('#home-light-channel').value='2';document.querySelector('#home-light-duration').value='1';document.querySelector('#home-light-start').click()`);
            await until(page, `workflowDevice.light[2] === true`);
            assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem('sleepStimulusProtocol')).enabled`), false);
            await until(page, `workflowDevice.light[2] === false`);
            await page.evaluate(`document.querySelector('#manual-stimulus-settings-dialog').close()`);
            assert.equal(await page.evaluate(`document.querySelector('#simple-n3-status').textContent`), '尚未启动');
        });
        await step('两个光源可一起手动启动，定时后都停止', async () => {
            await page.evaluate(`document.querySelector(document.querySelector('#simple-light-title').textContent === '手动光照' ? '#simple-n3-settings' : '#simple-manual-light').click();document.querySelector('#home-light-channel').value='3';document.querySelector('#home-light-duration').value='2';document.querySelector('#home-light-start').click()`);
            await until(page, `workflowDevice.light[1] && workflowDevice.light[2]`);
            await until(page, `document.querySelector('#simple-n3-status').textContent === '手动光照中'`);
            assert.match(await page.evaluate(`document.querySelector('#manual-light-live-state').textContent`), /两个光源/);
            await until(page, `!workflowDevice.light[1] && !workflowDevice.light[2]`);
            await page.evaluate(`document.querySelector('#manual-stimulus-settings-dialog').close()`);
        });
        await step('第二个光源启动失败时，两个都回退为关闭', async () => {
            await page.evaluate(`document.querySelectorAll('.toast').forEach(e=>e.remove());workflowDevice.failStart=2;document.querySelector(document.querySelector('#simple-light-title').textContent === '手动光照' ? '#simple-n3-settings' : '#simple-manual-light').click();document.querySelector('#home-light-start').click()`);
            await until(page, `[...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('Invalid parameter'))`);
            assert.equal(await page.evaluate(`workflowDevice.light[1] || workflowDevice.light[2]`), false);
            await page.evaluate(`workflowDevice.failStart=false;document.querySelector('#manual-stimulus-settings-dialog').close()`);
        });
        await step('模拟开灯失败后回退并显示失败', async () => {
            await page.evaluate(`document.querySelectorAll('.toast').forEach(e=>e.remove());workflowDevice.failStart=true;document.querySelector(document.querySelector('#simple-light-title').textContent === '手动光照' ? '#simple-n3-settings' : '#simple-manual-light').click();document.querySelector('#home-light-start').click()`);
            await until(page, `[...document.querySelectorAll('.toast.error')].some(e=>e.textContent.includes('Invalid parameter'))`);
            assert.equal(await page.evaluate(`workflowDevice.light[1] || workflowDevice.light[2]`), false);
            await page.evaluate(`workflowDevice.failStart=false;document.querySelector('#manual-stimulus-settings-dialog').close()`);
        });
        await step('信号超限、坏包、断档不会成为有效分期', async () => {
            await feedEpoch(page, 'saturated');
            assert.match(await page.evaluate(`document.querySelector('#realtime-health-hint').textContent`), /超出范围/);
            await page.evaluate(`workflowDevice.seq=(workflowDevice.seq+50)&65535`);
            await feedEpoch(page, 'corrupt');
            assert.equal(await page.evaluate(`workflowDevice.light[1] || workflowDevice.light[2]`), false);
        });
        await step('停止命令被拒绝时保持记录打开，允许重试', async () => {
            const previous = await page.evaluate(`(async()=>(await window.desktopAPI.listSessions())[0].id)()`);
            await page.evaluate(`workflowDevice.failStopEeg=true;document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent==='停止未确认'`);
            assert.equal(await page.evaluate(`workflowDevice.eeg`), true);
            const current = await page.evaluate(`window.desktopAPI.listSessions()`);
            assert.equal(current[0].id, previous); assert.equal(current[0].status, 'recording');
            await page.evaluate(`workflowDevice.failStopEeg=false`);
        });
        await step('停止后保存完整原始数据，样本和时间可核对', async () => {
            await page.evaluate(`document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent === '未开始'`);
            const sessions = await page.evaluate(`window.desktopAPI.listSessions()`), session = sessions[0];
            await until(page, `(async()=> (await window.desktopAPI.listSessions())[0].status==='completed')()`);
            const saved = JSON.parse(fs.readFileSync(path.join(session.directory, 'session.json')));
            const raw = decodeRawRecords(fs.readFileSync(path.join(session.directory, 'raw_adc.bin')));
            assert.equal(raw.rawCodes.length, await page.evaluate(`workflowDevice.samples - workflowDevice.recordStartSamples - workflowDevice.corruptedFrames`));
            assert.equal(saved.rows, raw.rawCodes.length);
            assert.equal(raw.elapsedMs[0], 4);
            const sentSamples = await page.evaluate(`workflowDevice.samples`);
            assert.equal(raw.rawCodes.at(-1), Math.round(1800 * Math.sin(2*Math.PI*1.2*((sentSamples-1)/250)) + 450 * Math.sin(2*Math.PI*10*((sentSamples-1)/250))));
            assert.ok(fs.statSync(path.join(session.directory, 'eeg_raw.edf')).size > 512);
            return { id: session.id, directory: session.directory, rows: saved.rows };
        });
        await step('记录分析区分采集时结果、回看结果和重新分期', async () => {
            const sessions = await page.evaluate(`window.desktopAPI.listSessions()`);
            await page.evaluate(`window.desktopAPI.openAnalysisWindow(${JSON.stringify(sessions[0].id)})`);
            const analysis = await connect('/src/analysis.html');
            await until(analysis, `document.querySelector('#analysis-workspace').hidden===false`, 30000);
            assert.match(await analysis.evaluate(`document.body.innerText`), /采集时的分期/);
            assert.match(await analysis.evaluate(`document.body.innerText`), /重新分期结果（YASA）/);
            await screenshot(analysis, 'record-analysis');
            await analysis.evaluate(`document.querySelector('#analysis-yasa-button').click()`);
            await until(analysis, `/已完成|运行失败/.test(document.querySelector('#analysis-yasa-state').textContent)`, 60000);
            assert.match(await analysis.evaluate(`document.querySelector('#analysis-yasa-state').textContent`), /已完成/);
            const savedYasa = JSON.parse(fs.readFileSync(path.join(sessions[0].directory, 'analysis/yasa/yasa_summary.json'), 'utf8'));
            assert.equal(savedYasa.epochCount, Math.floor(sessions[0].rows / sessions[0].sampleRateHz / 30));
            await analysis.evaluate(`document.querySelector('#analysis-export-button').click()`);
            for (let i=0;i<100&&!fs.existsSync(path.join(output,'report.pdf'));i++) await wait(100);
            assert.ok(fs.statSync(path.join(output, 'report.pdf')).size > 1000);
            assert.equal(await page.evaluate(`workflowDevice.light[1] || workflowDevice.light[2]`), false);
            await screenshot(analysis, 'yasa-result');
            await page.call('Target.closeTarget',{targetId:analysis.id});
        });
        await step('数据中断和断开连接后停用自动触发并保存记录', async () => {
            await page.evaluate(`document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent==='正在采集'`);
            await page.evaluate(`workflowDevice.feed(1000)`);
            await until(page, `document.querySelector('#live-signal').textContent.includes('中断')`, 6000);
            assert.match(await page.evaluate(`document.querySelector('#live-signal').textContent`), /中断/);
            await page.evaluate(`workflowDevice.disconnect()`);
            await until(page, `document.querySelector('#simple-device-status').textContent==='未连接'`);
            await until(page, `(async()=>(await window.desktopAPI.listSessions())[0].status==='interrupted')()`);
            const sessions = await page.evaluate(`window.desktopAPI.listSessions()`);
            assert.equal(sessions[0].status, 'interrupted');
            assert.equal(sessions[0].reason, 'ble_disconnected');
            assert.equal(await page.evaluate(`document.querySelector('#simple-n3-status').textContent`), '尚未启动');
            assert.equal(await page.evaluate(`document.querySelector('#live-n3-probability').textContent`), '--');
        });
        await step('重新连接仍在采集的设备时，可新建记录并再次采集', async () => {
            await page.evaluate(`document.querySelector('#connect-button').click()`);
            await until(page, `document.querySelector('#simple-device-status').textContent==='已连接' && document.querySelector('#metric-battery').textContent==='80%'`);
            assert.equal(await page.evaluate(`document.querySelector('#simple-eeg-status').textContent`), '未开始');
            await page.evaluate(`document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent==='正在采集'`);
            await page.evaluate(`workflowDevice.feed(512);`);
            await page.evaluate(`document.querySelector('#safe-stop-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent==='未开始'`);
            assert.equal(await page.evaluate(`workflowDevice.eeg || workflowDevice.light[1] || workflowDevice.light[2]`), false);
            await until(page, `(async()=>(await window.desktopAPI.listSessions())[0].status==='interrupted')()`);
            assert.equal(await page.evaluate(`(async()=>(await window.desktopAPI.listSessions())[0].rows)()`), 512);
        });
        await step('模拟磁盘写入失败会停止采集、保留失败标记，并可重新采集', async () => {
            await page.evaluate(`document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent==='正在采集'`);
            fs.writeFileSync(path.join(output, 'fail-next-raw-write'), 'test');
            await page.evaluate(`workflowDevice.feed(1024)`);
            await until(page, `workflowDevice.eeg===false && document.querySelector('#simple-eeg-status').textContent==='保存失败'`);
            await until(page, `(async()=>(await window.desktopAPI.listSessions())[0].status==='failed')()`);
            await page.evaluate(`document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `document.querySelector('#simple-eeg-status').textContent==='正在采集'`);
            await page.evaluate(`workflowDevice.feed(1024)`);
            await page.evaluate(`document.querySelector('#eeg-toggle-button').click()`);
            await until(page, `(async()=>(await window.desktopAPI.listSessions())[0].status==='completed')()`);
            assert.equal(await page.evaluate(`(async()=>(await window.desktopAPI.listSessions())[0].rows)()`), 1024);
        });
        if (isolatedApp) await step('运行 YASA 后应用签名仍有效', async () => {
            const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', isolatedApp], { encoding: 'utf8' });
            assert.equal(verified.status, 0, verified.stderr);
        });
        await step('无未捕获的页面异常', async () => assert.deepEqual(exceptions, []));
    } catch (error) {
        console.error(error.stack);
        results.push({ name: '流程运行', ok: false, error: error.stack });
        if (page) {
            try { await screenshot(page, 'failure'); fs.writeFileSync(path.join(output, 'failure.txt'), await page.evaluate(`document.body.innerText`)); } catch { /* context gone */ }
        }
        process.exitCode = 1;
    } finally {
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ output, simulation: true, stageControlOutputsInjected: !process.argv.includes('--gui-only'), results, exceptions, childExitCode: child.exitCode, childSignal: child.signalCode }, null, 2));
        fs.writeFileSync(path.join(output, 'electron.log'), logs);
        for (const page of connections) page.close();
        child.kill('SIGTERM');
        for(let i=0;i<50&&child.exitCode==null;i++) await wait(100);
        if (child.exitCode==null) child.kill('SIGKILL');
        if (isolatedApp) fs.rmSync(isolatedApp, { recursive: true, force: true });
        console.log(`RESULTS ${output}`);
    }
})();
