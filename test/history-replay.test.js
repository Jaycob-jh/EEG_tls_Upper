'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Sleep=require('../src/realtime-sleep'),Post=require('../src/sleep-stage-postprocess');
const {simulate,compareN3Votes,makePrediction,DEFAULT_PROTOCOL}=require('../src/history-replay');
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
        sleepN3Postprocessors:{causal:new Post.N3Postprocessor({mode:'causal'})},sleepStimulusProtocol:DEFAULT_PROTOCOL,n3VoteTrial:new Sleep.N3VoteTrial(),sleepHistory:[]};
    let modelValues;
    const context=vm.createContext({state,Sleep,SleepPostprocess:Post,
        window:{desktopAPI:{inferSleepStage:async()=>({probabilities:modelValues,stage:modelValues.indexOf(Math.max(...modelValues)),selectedOutputIndex:20})}},
        $:()=>({}),formatTime:()=>'',renderLiveStatus(){},renderSleepProbabilities(){},renderSleepHistory(){},sleepStagePresentation:()=>'',
        audit:async()=>{},handleSleepStimulusResult:async item=>{captured=item;}});
    vm.runInContext(source.slice(source.indexOf('    async function inferSleepEpoch('),source.indexOf('    function handleRealtimeSleepSample(')),context);
    const smoother=new Sleep.SleepStageSmoother({alpha:.5}),post=new Post.N3Postprocessor({mode:'causal'});
    const trial=new Sleep.N3VoteTrial();
    const vectors=[...Array(6).fill([.0025,.0025,.0025,.99,.0025]),...Array(6).fill([.0025,.0025,.99,.0025,.0025])];
    for(let i=0;i<vectors.length;i++){
        modelValues=vectors[i];const input={inferenceMode:'causal',classifiedEpochIndex:i,historyEpochs:21,temporalContext:21,
            observedAt:(i+1)*30000,contextQualityOk:true,controlEligible:true,targetQuality:{ok:i!==10,reason:i===10?'raw_saturation':'ok',deltaRatio:.5}};
        await context.inferSleepEpoch(input);const replay=makePrediction(input,modelValues,smoother,post);
        assert.equal(JSON.stringify(captured.n3VoteTrial), JSON.stringify(trial.evaluate(replay,input.observedAt)));
        for(const key of ['stage','candidateStage','confidence','candidateConfidence','probabilities','controlEligible','stimulusControlEligible','n3Postprocessed'])assert.equal(JSON.stringify(replay[key]),JSON.stringify(captured[key]),`${key} differs at epoch ${i}`);
    }
});

test('N3 shadow replay compares both paths and resets after unusable epochs', () => {
    const row = (epochIndex, deltaRatio = .6) => ({
        epochIndex, observedEndMs: (epochIndex + 1) * 30_000, inferenceMode: 'causal',
        stage: 'N3', probabilities: [0, 0, .2, .8, 0],
        quality: { ok: true, deltaRatio }, stimulusControlEligible: true,
    });
    const cnnOnly = compareN3Votes([row(0), row(1), row(2, null), row(3)]);
    assert.equal(cnnOnly.cnnHits.length, 1);
    assert.equal(cnnOnly.voteHits.length, 0);
    const both = compareN3Votes([row(0), row(1), { ...row(2), skipped: true },
        ...[3, 4, 5, 6].map(index => row(index))]);
    assert.deepEqual(both.voteHits.map(hit => hit.epochIndex), [6]);
    assert.equal(both.hardwareCommandsSent, 0);

    const rows = [0, 1, 2, 3].map(index => row(index));
    const start = Date.parse('2026-11-08T00:00:00Z');
    const lightEvents = [{ action: 'light_started', channel: 1, time: start + 65_000 }];
    const lit = compareN3Votes(rows, { startedAt: new Date(start), recordedTimeline: true, lightEvents });
    assert.equal(lit.cnnHits.length, 0);
    assert.equal(lit.voteHits.length, 0);
    assert.ok(compareN3Votes(rows, { lightEvents }).unavailable);
});
