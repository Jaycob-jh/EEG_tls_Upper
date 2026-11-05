'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(failStart=false) {
    const state={connected:true,lightRunning:{1:false,2:false},sleepStimulusProtocol:{enabled:true},manualLightChannel:null};
    const calls=[],timers=[];
    const context=vm.createContext({state,Date,Number,
        manualStimulusSourceAvailable:()=>true,
        requireClient:()=>{if(!state.connected)throw Error('disconnected')},withLightLease:fn=>fn(),
        preemptSleepStimulus:async()=>{calls.push('preempt');state.sleepStimulusActiveChannel=null;state.lightRunning={}},
        disableSleepStimulus:async()=>{state.sleepStimulusProtocol.enabled=false;calls.push('disable-auto')},
        configureLight:async(ch,cfg)=>calls.push(['configure',ch,cfg.durationMs]),
        startLight:async ch=>{calls.push(['start',ch]);if(failStart)throw Error('start failed');state.lightRunning[ch]=true},
        stopLight:async ch=>{calls.push(['stop',ch]);state.lightRunning[ch]=false},
        setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){},
        renderStimulusSources(){},renderSimpleWorkflow(){},preferLightMode:mode=>{state.preferredLightMode=mode},audit:async()=>{},runUiTask:fn=>fn(),
    });
    const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
    vm.runInContext(source.slice(source.indexOf('    function validateManualLightConfig('),source.indexOf('    async function runUiTask(')),context);
    return {state,calls,timers,context};
}
const config={frequencyHz:40,powerPercent:5,durationMs:720000};

test('manual light works without EEG collection and explicitly disarms automatic triggering',async()=>{
    const h=harness();
    await h.context.startManualLight(1,config);
    assert.equal(h.state.sleepStimulusProtocol.enabled,false);
    assert.equal(h.state.manualLightChannel,1);
    assert.deepEqual(h.calls.slice(0,3),['disable-auto',['configure',1,720000],['start',1]]);
    await h.context.stopManualLight(2);
    assert.deepEqual(h.calls.at(-1),['stop',1]);
    assert.equal(h.state.manualLightChannel,null);
    assert.equal(h.state.sleepStimulusProtocol.enabled,false);
});
test('manual start failure issues a stop rather than leaving a partial start unhandled',async()=>{
    const h=harness(true);
    await assert.rejects(h.context.startManualLight(3,config));
    assert.deepEqual(h.calls.at(-1),['stop',3]);
});
test('invalid settings or a disconnected device never start light or disable the current protocol',async()=>{
    const h=harness();
    await assert.rejects(h.context.startManualLight(1,{...config,durationMs:Infinity}));
    h.state.connected=false;
    await assert.rejects(h.context.startManualLight(1,config));
    assert.equal(h.calls.length,0);
    assert.equal(h.state.sleepStimulusProtocol.enabled,true);
});
test('manual duration timeout stops the active channel',async()=>{
    const h=harness();await h.context.startManualLight(2,config);
    h.timers[0]();await new Promise(setImmediate);
    assert.deepEqual(h.calls.at(-1),['stop',2]);
    assert.equal(h.state.manualLightChannel,null);
});
