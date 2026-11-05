'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
exports.run=async ({page,connect,until,step,screenshot,output,root})=>{
    const observations=[];
    async function size(target,width,height){await target.call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});}
    async function measure(target,label){
        const result=await target.evaluate(`(()=>{const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';const bounds=e=>{const r=e.getBoundingClientRect();return {id:e.id,text:e.textContent.trim().slice(0,35),x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}};return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,clippedButtons:[...document.querySelectorAll('button')].filter(visible).filter(e=>e.getBoundingClientRect().right>innerWidth+1||e.getBoundingClientRect().left<0).map(bounds),save:document.querySelector('#sleep-stimulus-settings-dialog[open] #sleep-stimulus-save')?bounds(document.querySelector('#sleep-stimulus-save')):null,cards:[...document.querySelectorAll('.workflow-step')].map(bounds)}})()`);
        observations.push({label,...result});console.log(`GUI ${label}: ${JSON.stringify(result)}`);await screenshot(target,label);
        assert.equal(result.overflow,false,`${label}: page overflow`);
        assert.deepEqual(result.clippedButtons,[],`${label}: clipped buttons`);
        if(result.save) assert.ok(result.save.y>=0&&result.save.y+result.save.h<=result.height,`${label}: save button off screen`);
    }
    for(const [width,height]of [[1480,920],[1100,720],[1280,800]]){
        await size(page,width,height);
        await page.evaluate(`document.querySelector('[data-page="device"]').click(); document.querySelector('.workspace').scrollTop=0`);
        await measure(page,`device-${width}`);
        await page.evaluate(`document.querySelector('#simple-n3-settings').click()`);
        await measure(page,`auto-settings-${width}`);
        await page.evaluate(`document.querySelector('#sleep-stimulus-settings-dialog').close();document.querySelector('#simple-manual-light').click()`);
        await measure(page,`manual-${width}`);
        await page.evaluate(`document.querySelector('#manual-stimulus-settings-dialog').close();document.querySelector('[data-page="realtime"]').click()`);
        await measure(page,`realtime-${width}`);
        await page.evaluate(`document.querySelector('[data-page="records"]').click(); document.querySelector('.workspace').scrollTop=0`);
        await measure(page,`records-${width}`);
    }
    await step('GUI：无设备时也能回放，过程不会改动光照设置或发送命令',async()=>{
        const before=await page.evaluate(`localStorage.getItem('sleepStimulusProtocol')`);
        await page.evaluate(`document.querySelector('#history-replay-start').click()`);
        await until(page,`document.querySelector('#history-replay-status').textContent.includes('已完成')`,30000);
        assert.equal(await page.evaluate(`localStorage.getItem('sleepStimulusProtocol')`),before);
        assert.equal(await page.evaluate(`workflowDevice.commands.length`),0);
        assert.equal(await page.evaluate(`document.querySelector('#history-replay-open').disabled`),false);
    });
    await step('GUI：未连接时参数可编辑，关闭后不会误开灯',async()=>{
        await page.evaluate(`document.querySelector('[data-page="device"]').click();document.querySelector('#simple-n3-settings').click();document.querySelector('#sleep-stimulus-frequency').value='40';document.querySelector('#sleep-stimulus-settings-dialog').close()`);
        assert.equal(await page.evaluate(`workflowDevice.commands.length`),0);
    });
    await step('GUI：每个主页面滚动后仍可找到全部停止',async()=>{
        for(const name of ['device','realtime','records','debug']){
            await page.evaluate(`document.querySelector('[data-page="${name}"]').click(); document.querySelector('.workspace').scrollTop=99999`);
            assert.equal(await page.evaluate(`(()=>{const r=document.querySelector('#safe-stop-button').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth})()`),true);
        }
    });
    await step('GUI：非法参数不会保存，保存与取消的结果清楚',async()=>{
        await page.evaluate(`document.querySelector('[data-page="device"]').click();document.querySelector('#simple-n3-settings').click()`);
        assert.equal(await page.evaluate(`document.querySelector('#sleep-stimulus-enabled').getClientRects().length`),0);
        const before=await page.evaluate(`localStorage.getItem('sleepStimulusProtocol')`);
        await page.evaluate(`document.querySelector('#sleep-stimulus-duration').value='0';document.querySelector('#sleep-stimulus-save').click()`);
        await until(page,`document.querySelector('#sleep-settings-feedback').dataset.error==='true'`);
        assert.equal(await page.evaluate(`localStorage.getItem('sleepStimulusProtocol')`),before);
        assert.equal(await page.evaluate(`document.querySelector('#sleep-stimulus-settings-dialog').open`),true);
        await page.evaluate(`document.querySelector('#sleep-stimulus-duration').value='10';document.querySelector('#sleep-stimulus-frequency').value='40';document.querySelector('#sleep-stimulus-save').click()`);
        await until(page,`document.querySelector('#sleep-stimulus-settings-dialog').open===false`);
        assert.equal(await page.evaluate(`JSON.parse(localStorage.getItem('sleepStimulusProtocol')).frequencyHz`),40);
        assert.match(await page.evaluate(`document.querySelector('#simple-n3-parameters').textContent`),/每次 10 秒/);
        await page.evaluate(`document.querySelector('#simple-n3-settings').click();document.querySelector('#sleep-stimulus-frequency').value='41';document.querySelector('#sleep-stimulus-cancel').click();document.querySelector('#simple-n3-settings').click()`);
        assert.equal(await page.evaluate(`document.querySelector('#sleep-stimulus-frequency').value`),'40');
        for(let i=0;i<8;i++) await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        assert.equal(await page.evaluate(`document.activeElement.closest('dialog')?.id`),'sleep-stimulus-settings-dialog');
        await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await until(page,`document.querySelector('#sleep-stimulus-settings-dialog').open===false`);
        assert.equal(await page.evaluate(`workflowDevice.commands.length`),0);
    });
    // Reuse only synthetic recordings made by the software workflow test.
    const previous=JSON.parse(fs.readFileSync(process.env.CAOCAO_GUI_SEED_RESULTS || path.join(root,'artifacts/workflow-check-20261104/results.json'),'utf8'));
    const seed=previous.results.find(item=>item.detail?.directory)?.detail?.directory;
    if(seed&&fs.existsSync(seed)){
        const sessionsRoot=(await page.evaluate(`window.desktopAPI.getPaths()`)).sessions;
        const destination=path.join(sessionsRoot,'gui-synthetic-record');
        fs.cpSync(seed,destination,{recursive:true});
        const metadata=JSON.parse(fs.readFileSync(path.join(destination,'session.json'),'utf8'));
        const other=path.join(sessionsRoot,'gui-other-record');
        fs.cpSync(seed,other,{recursive:true});
        fs.writeFileSync(path.join(other,'session.json'),JSON.stringify({...metadata,id:'gui-other-record',planName:'另一条测试记录',rows:1000}));
        fs.writeFileSync(path.join(other,'raw_adc.bin'),fs.readFileSync(path.join(other,'raw_adc.bin')).subarray(0,16000));
        fs.writeFileSync(path.join(other,'events.jsonl'),'');
        await page.evaluate(`window.desktopAPI.openAnalysisWindow(${JSON.stringify(metadata.id)})`);
        const analysis=await connect('/src/analysis.html');
        await until(analysis,`document.querySelector('#analysis-workspace').hidden===false`,30000);
        await step('GUI：已保存的 YASA 结果会自动显示，明细默认收起',async()=>{
            assert.match(await analysis.evaluate(`document.querySelector('#analysis-yasa-state').textContent`),/已保存/);
            assert.equal(await analysis.evaluate(`document.querySelector('.online-staging-section').open`),false);
            assert.doesNotMatch(await analysis.evaluate(`document.querySelector('#analysis-kpis').innerText`),/60\.0秒/);
        });
        for(const [width,height]of [[1380,900],[960,680]]){await size(analysis,width,height);await measure(analysis,`analysis-${width}`);}
        await step('GUI：YASA 确实重新计算，运行时按钮禁止重复点击',async()=>{
            await analysis.evaluate(`document.querySelector('#analysis-yasa-button').click()`);
            await until(analysis,`document.querySelector('#analysis-yasa-state').textContent.includes('运行中')`);
            assert.equal(await analysis.evaluate(`document.querySelector('#analysis-yasa-button').disabled`),true);
            assert.equal(await analysis.evaluate(`document.querySelector('#analysis-session-select').disabled`),true);
            assert.equal(await analysis.evaluate(`document.querySelector('#analysis-export-button').disabled`),true);
            await until(analysis,`/已完成|运行失败/.test(document.querySelector('#analysis-yasa-state').textContent)`,60000);
            assert.match(await analysis.evaluate(`document.querySelector('#analysis-yasa-state').textContent`),/已完成/);
            await screenshot(analysis,'yasa-gui-result');
        });
        await step('GUI：切换记录自动分析，不会带入上一条的 YASA 结果',async()=>{
            await analysis.evaluate(`document.querySelector('#analysis-session-select').value='gui-other-record';document.querySelector('#analysis-session-select').dispatchEvent(new Event('change'))`);
            await until(analysis,`document.querySelector('#analysis-workspace').hidden===false && document.querySelector('#analysis-kpis').innerText.includes('1,000')`);
            assert.equal(await analysis.evaluate(`document.querySelector('#analysis-yasa-state').textContent`),'尚未运行');
            assert.equal(await analysis.evaluate(`document.querySelector('#analysis-yasa-button').disabled`),true);
            assert.match(await analysis.evaluate(`document.querySelector('#analysis-yasa-summary').textContent`),/不足 30 秒/);
            const error=await analysis.evaluate(`window.desktopAPI.runYasaStaging('gui-other-record').then(()=>'',e=>e.message)`);
            assert.match(error,/不足 30 秒/);
        });
        await page.call('Target.closeTarget',{targetId:analysis.id});
    }
    fs.writeFileSync(path.join(output,'gui-observations.json'),JSON.stringify(observations,null,2));
};
