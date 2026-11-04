'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Sleep=require('../src/realtime-sleep');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const Postprocess=require('../src/sleep-stage-postprocess');
const row=(stage,epochIndex,confidence=.9)=>({stage,candidateStage:stage,epochIndex,confidence,candidateConfidence:confidence,
    probabilities:Sleep.STAGES.map(s=>s===stage?confidence:(1-confidence)/4),quality:{ok:true}});

test('W, N1, N2 and REM each trigger only when selected and above the common threshold',()=>{
    for(const stage of ['W','N1','N2','REM']) {
        const gate=new Sleep.SleepStageStimulusGate({enabled:true,targetStages:[stage],minConfidence:.8,consecutiveEpochs:2});
        assert.equal(gate.evaluate(row(stage,0,.7),0).reason,'low_confidence');
        assert.equal(gate.evaluate(row(stage,1),30000).triggered,false);
        assert.equal(gate.evaluate(row(stage,2),60000).triggered,true);
    }
});
test('multi-select means any selected stage can trigger but different stages cannot combine their counts',()=>{
    const gate=new Sleep.SleepStageStimulusGate({enabled:true,targetStages:['N2','REM'],minConfidence:.8,consecutiveEpochs:3,cooldownMinutes:30});
    gate.evaluate(row('N2',0),0);gate.evaluate(row('N2',1),30000);
    assert.equal(gate.evaluate(row('REM',2),60000).matchedCount,1);
    assert.equal(gate.evaluate(row('REM',3),90000).triggered,false);
    assert.equal(gate.evaluate(row('REM',4),120000).triggered,true);
    assert.equal(gate.evaluate(row('N2',5),150000).reason,'cooldown');
});
test('unselected N3 never substitutes for the configured target; empty selection is invalid',()=>{
    const gate=new Sleep.SleepStageStimulusGate({enabled:true,targetStages:['N2'],consecutiveEpochs:1});
    assert.equal(gate.evaluate(row('N3',0),0).reason,'stage_not_selected');
    assert.ok(Sleep.validateStimulusProtocol({targetStages:[]}).length);
});

test('N3 exit hysteresis never borrows the high probability of another stage to trigger N3',()=>{
    const gate=new Sleep.SleepStageStimulusGate({enabled:true,targetStages:['N3'],minN3Probability:.7,consecutiveEpochs:1});
    assert.equal(gate.evaluate({stage:'N3',candidateStage:'N2',candidateConfidence:.99,confidence:.0025,
        probabilities:[.0025,.0025,.99,.0025,.0025],epochIndex:22,quality:{ok:true}},100000).triggered,false);
});

test('leaving confirmed N3 retains the new stage probability instead of resetting it to zero',()=>{
    const processor=new Postprocess.N3Postprocessor({mode:'causal'});
    let result;
    for(let i=0;i<4;i++) result=processor.update({epochIndex:i,rawStage:'N3',rawProbabilities:[.0025,.0025,.0025,.99,.0025],quality:{ok:true},contextReady:true,contextQualityOk:true,controlEligible:true});
    assert.equal(result.stage,'N3');
    for(let i=4;i<6;i++) result=processor.update({epochIndex:i,rawStage:'N2',rawProbabilities:[.0025,.0025,.99,.0025,.0025],quality:{ok:true},contextReady:true,contextQualityOk:true,controlEligible:true});
    assert.equal(result.stage,'N2');
    assert.ok(result.confidence>.98);
});

test('history displays the probability of its displayed stage during a transition',()=>{
    const context=vm.createContext({Sleep});
    const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
    vm.runInContext(source.slice(source.indexOf('    function sleepHistoryProbability('),source.indexOf('    function sleepStimulusProtocolFromForm(')),context);
    assert.equal(context.sleepHistoryProbability({stage:'N3',candidateStage:'N2',candidateConfidence:.99,
        probabilities:[.0025,.0025,.99,.0025,.0025]}),'0.3%');
});

test('saving a different target preserves the running duration and shared cooldown',()=>{
    const old={enabled:true,targetStages:['N2'],minConfidence:.8,consecutiveEpochs:1,durationSeconds:720,cooldownMinutes:30};
    const gate=new Sleep.SleepStageStimulusGate(old);
    const firedAt=Date.now()-60000;
    gate.evaluate(row('N2',0),firedAt);
    const state={sleepStimulusGate:gate,sleepStimulusProtocol:old};
    const context=vm.createContext({Sleep,state,saveSleepStimulusProtocol(){},renderSleepStimulusProtocol(){}});
    const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
    vm.runInContext(source.slice(source.indexOf('    function applySleepStimulusProtocol('),source.indexOf('    async function disableSleepStimulus(')),context);
    context.applySleepStimulusProtocol({...old,targetStages:['REM']});
    assert.equal(gate.lastTriggeredAt,firedAt);
    assert.equal(gate.activeUntil,firedAt+720000);
    assert.equal(gate.matchedCount,0);
    assert.deepEqual(Array.from(gate.protocol.targetStages),['REM']);
});
