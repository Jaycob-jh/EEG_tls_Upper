'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(overrides={}) {
    const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
    const state={connected:false,eegRunning:false,sleepModelReady:true,realtimeEnabled:true,
        stimulusControlMode:'model',sleepStimulusProtocol:{enabled:false,shadowMode:false,targetStages:['N3'],lightChannel:1,
            frequencyHz:40,powerPercent:5,durationSeconds:720,minN3Probability:.7,consecutiveEpochs:15,cooldownMinutes:30},lightRunning:{},...overrides};
    const elements=new Map();
    const context=vm.createContext({state,
        $:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id)},
        modelStimulusSourceAvailable:()=>state.stimulusControlMode!=='manual',
        localStorage:{setItem(){}},resetRealtimeSleep(){},renderStimulusSources(){},renderLiveStatus(){},
        applySleepStimulusProtocol:p=>(state.sleepStimulusProtocol=p),setSleepStimulusStatus(){},
        planEngine:{getRelativeStatus:()=>null},audit:async()=>{},
        disableSleepStimulus:async()=>{state.sleepStimulusProtocol.enabled=false},
    });
    vm.runInContext(source.slice(source.indexOf('    function renderSimpleWorkflow('),source.indexOf('    function updateConnectionUi(')),context);
    vm.runInContext(source.slice(source.indexOf('    function sleepStimulusTriggerSummary('),source.indexOf('    function renderStimulusModeCard(')),context);
    return {state,context,elements};
}

test('simple N3 button cannot arm before EEG collection, or while a manual output is running',async()=>{
    const {state,context}=harness();
    await assert.rejects(context.toggleSimpleN3());
    assert.equal(state.sleepStimulusProtocol.enabled,false);
    state.connected=true;
    await assert.rejects(context.toggleSimpleN3());
    state.eegRunning=true;state.lightRunning[1]=true;
    await assert.rejects(context.toggleSimpleN3());
    assert.equal(state.sleepStimulusProtocol.enabled,false);
});

test('one-click N3 arming preserves saved exposure parameters and never sends a light command',async()=>{
    const {state,context}=harness({connected:true,eegRunning:true});
    const saved={...state.sleepStimulusProtocol};
    await context.toggleSimpleN3();
    assert.equal(state.sleepStimulusProtocol.enabled,true);
    for(const key of ['lightChannel','frequencyHz','powerPercent','durationSeconds','minN3Probability','consecutiveEpochs','cooldownMinutes','shadowMode']) {
        assert.equal(state.sleepStimulusProtocol[key],saved[key]);
    }
    await context.toggleSimpleN3();
    assert.equal(state.sleepStimulusProtocol.enabled,false);
});

test('arming from home preserves non-N3 target selection',async()=>{
    const h=harness({connected:true,eegRunning:true});
    h.state.sleepStimulusProtocol.targetStages=['N2','REM'];
    await h.context.toggleSimpleN3();
    assert.deepEqual(h.state.sleepStimulusProtocol.targetStages,['N2','REM']);
    assert.equal(h.state.sleepStimulusProtocol.enabled,true);
});

test('home light card prioritizes manual output and returns to explicit automatic-off status',()=>{
    const {state,context,elements}=harness({connected:true,eegRunning:true,manualLightChannel:3,manualLightUntil:Date.now()+600000,lightRunning:{1:true,2:true}});
    context.renderSimpleWorkflow();
    assert.equal(elements.get('simple-n3-status').textContent,'手动光照中');
    assert.match(elements.get('simple-n3-parameters').textContent,/两个光源.*剩余.*自动触发未开启/);
    assert.doesNotMatch(elements.get('simple-n3-parameters').textContent,/目标|12 分钟/);
    state.manualLightChannel=null;state.lightRunning={1:false,2:false};
    context.renderSimpleWorkflow();
    assert.equal(elements.get('simple-n3-status').textContent,'自动光照未开启');
});

test('manual selection survives stopping, requires no EEG, and automatic selection preserves targets',()=>{
    const {state,context,elements}=harness({connected:true,eegRunning:false});
    for(const [id,value]of Object.entries({'home-light-channel':'3','home-light-frequency':'40','home-light-power':'5','home-light-duration':'600'}))context.$(id).value=value;
    context.preferLightMode('manual');
    assert.equal(elements.get('simple-light-title').textContent,'手动光照');
    assert.equal(elements.get('simple-n3-toggle').textContent,'开始手动光照');
    assert.equal(elements.get('simple-n3-toggle').disabled,false);
    assert.match(elements.get('simple-n3-parameters').textContent,/600 秒/);
    state.sleepStimulusProtocol.targetStages=['N2','REM'];
    context.preferLightMode('automatic');
    assert.equal(elements.get('simple-light-title').textContent,'分期自动光照');
    assert.match(elements.get('simple-n3-parameters').textContent,/N2 \/ REM/);
    assert.equal(elements.get('simple-n3-toggle').disabled,true);
    assert.deepEqual(state.sleepStimulusProtocol.targetStages,['N2','REM']);
    state.sleepStimulusProtocol.enabled=true;context.preferLightMode('manual');
    assert.equal(context.selectedLightMode(),'automatic');
});

test('home automatic light card shows the saved probability and consecutive count while off',()=>{
    const {state,context,elements}=harness({connected:true,eegRunning:true});
    Object.assign(state.sleepStimulusProtocol,{n3TriggerMode:'probability',minN3Probability:.6,consecutiveEpochs:5});
    context.renderSimpleWorkflow();
    assert.match(elements.get('simple-n3-parameters').textContent,/N3 概率 ≥ 60%.*连续 5 段/);
    assert.equal(elements.get('simple-n3-status').textContent,'自动光照未开启');
    assert.equal(elements.get('simple-n3-toggle').textContent,'开启自动光照');
});
