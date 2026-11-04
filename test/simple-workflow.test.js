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
        localStorage:{setItem(){}},resetRealtimeSleep(){},renderStimulusSources(){},
        applySleepStimulusProtocol:p=>(state.sleepStimulusProtocol=p),setSleepStimulusStatus(){},
        planEngine:{getRelativeStatus:()=>null},audit:async()=>{},
        disableSleepStimulus:async()=>{state.sleepStimulusProtocol.enabled=false},
    });
    vm.runInContext(source.slice(source.indexOf('    function renderSimpleWorkflow('),source.indexOf('    function updateConnectionUi(')),context);
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
