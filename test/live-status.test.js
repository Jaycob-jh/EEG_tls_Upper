'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../src/live-status');
const now = 1000000;
function fixture(extra = {}) { return { connected: true, eegRunning: true, modelReady: true,
    startedAt: now - 100000, lastSampleAt: now - 20, quality: {ok:true}, lightVerified:true,
    protocol:{enabled:true,shadowMode:false,consecutiveEpochs:15,cooldownMinutes:30},
    prediction:{receivedAt:now-1000,stage:'N2',probabilities:[0,0,.9,.1,0],quality:{ok:true},stimulusControlEligible:true}, ...extra }; }
test('disconnected device never presents old sleep or light state as current',()=>{
    const s=project(fixture({connected:false,lightRunning:true,activeUntil:now+50000}),now);
    assert.match(s.light,/未知/); assert.doesNotMatch(s.light,/剩余/);
    assert.equal(s.probability,'--');assert.equal(s.live,false);
});
test('stream interruption hides outdated predictions within seconds',()=>{
    const s=project(fixture({lastSampleAt:now-4000}),now);
    assert.match(s.signal,/中断/);assert.equal(s.probability,'--');assert.equal(s.live,false);
});
test('before first data frame status does not claim data reception',()=>{
    const s=project(fixture({lastSampleAt:null,startedAt:now-1000,quality:null,prediction:null}),now);
    assert.equal(s.live,false);assert.equal(s.signal,'等待脑电数据');
});
test('stale prediction and bad quality are distinct from normal sleep scoring',()=>{
    assert.equal(project(fixture({prediction:{receivedAt:now-70000}}),now).probability,'--');
    assert.match(project(fixture({quality:{ok:false,reason:'raw_saturation'}}),now).automation,/质量异常/);
});
test('verified light countdown and cooldown count down with the clock',()=>{
    const s=fixture({lightRunning:true,activeUntil:now+119600,lastTriggeredAt:now-60000});
    assert.match(project(s,now).light,/2分0秒/);
    assert.match(project(s,now+1000).light,/1分59秒/);
    assert.match(project({...s,lightRunning:false},now).automation,/等待下次允许开灯/);
});

test('target probability and waiting state follow the selected stages, not a fixed N3 label',()=>{
    const s=fixture();s.protocol.targetStages=['N2','REM'];
    const view=project(s,now);
    assert.equal(view.probabilityLabel,'目标分期概率');
    assert.equal(view.probability,'N2 90.0% · REM 0.0%');
    assert.match(view.automation,/等待 N2 \/ REM/);
});
