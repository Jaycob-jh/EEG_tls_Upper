'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Sleep=require('../src/realtime-sleep'),Post=require('../src/sleep-stage-postprocess');
const {simulate,makePrediction,DEFAULT_PROTOCOL}=require('../src/history-replay');
test('accelerated replay uses source time for cooldown and simulates both lights without hardware commands',()=>{
    const row=(epochIndex,time)=>({epochIndex,observedEndMs:time,stage:'N3',candidateStage:'N3',confidence:.9,candidateConfidence:.9,probabilities:[0,0,0,.9,.1],quality:{ok:true},controlEligible:true,stimulusControlEligible:true});
    const result=simulate([row(0,0),row(1,30000),row(60,1800000)],{...DEFAULT_PROTOCOL,consecutiveEpochs:1});
    assert.equal(result.triggers.length,2);assert.deepEqual(result.triggers[0].channels,[1,2]);assert.equal(result.hardwareCommandsSent,0);
    assert.equal(result.triggers[1].seconds,1800);
});
test('a missing-data epoch interrupts consecutive replay trigger counting',()=>{
    const row=i=>({epochIndex:i,observedEndMs:(i+1)*30000,stage:'N3',candidateStage:'N3',confidence:.9,candidateConfidence:.9,probabilities:[0,0,0,.9,.1],quality:{ok:true},controlEligible:true,stimulusControlEligible:true});
    const result=simulate([row(0),{skipped:true,epochIndex:1},row(2)],{...DEFAULT_PROTOCOL,consecutiveEpochs:2});assert.equal(result.triggers.length,0);
});
test('replay scoring matches the actual live renderer through N3 entry, exit and bad quality',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');let captured;
    const state={sleepModelReady:true,sleepInferenceGeneration:0,sleepProbabilitySmoothers:{causal:new Sleep.SleepStageSmoother({alpha:.5})},
        sleepN3Postprocessors:{causal:new Post.N3Postprocessor({mode:'causal'})},sleepStimulusProtocol:DEFAULT_PROTOCOL,sleepHistory:[]};
    let modelValues;
    const context=vm.createContext({state,Sleep,SleepPostprocess:Post,
        window:{desktopAPI:{inferSleepStage:async()=>({probabilities:modelValues,stage:modelValues.indexOf(Math.max(...modelValues)),selectedOutputIndex:20})}},
        $:()=>({}),formatTime:()=>'',renderLiveStatus(){},renderSleepProbabilities(){},renderSleepHistory(){},sleepStagePresentation:()=>'',
        audit:async()=>{},handleSleepStimulusResult:async item=>{captured=item;}});
    vm.runInContext(source.slice(source.indexOf('    async function inferSleepEpoch('),source.indexOf('    function handleRealtimeSleepSample(')),context);
    const smoother=new Sleep.SleepStageSmoother({alpha:.5}),post=new Post.N3Postprocessor({mode:'causal'});
    const vectors=[...Array(6).fill([.0025,.0025,.0025,.99,.0025]),...Array(6).fill([.0025,.0025,.99,.0025,.0025])];
    for(let i=0;i<vectors.length;i++){
        modelValues=vectors[i];const input={inferenceMode:'causal',classifiedEpochIndex:i,historyEpochs:21,temporalContext:21,
            contextQualityOk:true,controlEligible:true,targetQuality:{ok:i!==10,reason:i===10?'raw_saturation':'ok',deltaRatio:.5}};
        await context.inferSleepEpoch(input);const replay=makePrediction(input,modelValues,smoother,post);
        for(const key of ['stage','candidateStage','confidence','candidateConfidence','probabilities','controlEligible','stimulusControlEligible','n3Postprocessed'])assert.equal(JSON.stringify(replay[key]),JSON.stringify(captured[key]),`${key} differs at epoch ${i}`);
    }
});
