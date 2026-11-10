'use strict';
// Read-only, causal replay of saved EEG. This module has no device connection
// or light-command path. Trigger records are simulations on a virtual clock.
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const readline=require('node:readline');
const {spawn}=require('node:child_process');
const SDK=require('./vendor/BrainLume_Lib');
const Sleep=require('./realtime-sleep');
const Post=require('./sleep-stage-postprocess');
const Integrity=require('./sleep-model-integrity');
const {readEdf}=require('./edf');
const {decodeRawRecords}=require('./raw-recording');
const {parseCsvLine}=require('./analysis-core');
const STAGES=Sleep.STAGES;
const DEFAULT_PROTOCOL={enabled:true,shadowMode:true,targetStages:['N3'],n3TriggerMode:'probability',
    minN3Probability:.7,minN3Confidence:.8,minConfidence:.8,consecutiveEpochs:15,
    lightChannel:3,frequencyHz:40,powerPercent:5,durationSeconds:720,cooldownMinutes:30};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const json=async(file,fallback=null)=>{try{return JSON.parse(await fsp.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
async function writeJson(file,value){await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,JSON.stringify(value,null,2));}

async function inventory(root){
    const records=[];
    for(const entry of await fsp.readdir(root,{withFileTypes:true})){
        if(!entry.isDirectory())continue;
        const directory=path.join(root,entry.name),metadata=await json(path.join(directory,'session.json'));
        if(!metadata)continue;
        const names=metadata.rawDataFile?['raw_adc.bin','raw_adc.bin.partial']:['eeg_raw.csv','eeg_raw.edf','eeg_raw.csv.partial','eeg_raw.edf.partial'];
        const source=names.map(n=>path.join(directory,n)).find(p=>fs.existsSync(p));
        records.push({directory,metadata,source:source||null});
    }
    return records.sort((a,b)=>String(a.metadata.startedAt).localeCompare(String(b.metadata.startedAt)));
}

async function eventSummary(directory){
    const counts={},gaps=[],lightEvents=[];let crc=0;
    const file=path.join(directory,'events.jsonl');if(!fs.existsSync(file))return {counts,gaps,crc,lightEvents};
    for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
        let e;try{e=JSON.parse(line);}catch{continue;}
        counts[e.action]=(counts[e.action]||0)+1;
        if (e.action === 'light_started' || e.action === 'light_stopped') {
            lightEvents.push({ action: e.action, channel: e.channel, time: Date.parse(e.ts) });
        }
        if(e.action==='eeg_seq_gap')gaps.push({seq:e.seq,gapSamples:e.gapSamples,ts:e.ts});
        if(e.action==='protocol_error'&&/crc|校验/i.test(String(e.error||e.errorName||'')))crc++;
    }
    return {counts,gaps,crc,lightEvents};
}

async function loadRecording(record){
    const {metadata:m,source}=record;
    if(!source)throw Error('原始数据文件缺失');
    const bytes=await fsp.readFile(source),fingerprint=hash(Buffer.concat([bytes,Buffer.from(JSON.stringify(m))]));
    const warnings=[];
    if(source.includes('raw_adc.bin')){
        const d=decodeRawRecords(bytes,m.adcScale);
        return {...d,rate:Number(m.sampleRateHz||250),fingerprint,warnings,timeline:'recorded',source};
    }
    if(/\.csv(?:\.partial)?$/.test(source)){
        const lines=bytes.toString('utf8').split(/\r?\n/),header=parseCsvLine(lines.shift().replace(/^\uFEFF/,''));
        const columns=Object.fromEntries(header.map((n,i)=>[n,i]));const values=[],rawCodes=[],sequences=[],elapsedMs=[],gaps=[];
        for(const line of lines){if(!line.trim())continue;const f=parseCsvLine(line),code=Number(f[columns.raw_code]),uv=Number(f[columns.voltage_uv]);
            if(!Number.isFinite(uv)||!Number.isFinite(code))throw Error('原始 CSV 包含无效脑电数值');
            values.push(uv);rawCodes.push(code);sequences.push(Number(f[columns.seq]));elapsedMs.push(Number(f[columns.elapsed_us])/1000);gaps.push(Math.max(0,Number(f[columns.seq_gap])||0));}
        return {values:Float64Array.from(values),rawCodes:Int32Array.from(rawCodes),sequences:Uint16Array.from(sequences),elapsedMs:Float64Array.from(elapsedMs),gaps,rate:Number(m.sampleRateHz||250),fingerprint,warnings,timeline:'recorded',source};
    }
    const edf=await readEdf(source,0);
    const count=Number.isFinite(Number(m.rows))?Math.min(Math.max(0,Number(m.rows)),edf.values.length):edf.values.length;
    const values=edf.values.subarray(0,count);
    warnings.push('旧 EDF 只有 16 位精度；原始 ADC 细节不能恢复。','旧 EDF 缺少逐样本时间和序号；回放时刻是文件内时间，不能当作精确钟表时间。');
    return {values,rate:edf.sampleRateHz,fingerprint,warnings,timeline:'sample_order_only',source};
}

function makePrediction(input,result,smoother,postprocessor){
    const smooth=smoother.update(result),modelStage=STAGES[smooth.stageIndex],quality=input.targetQuality||input.centerQuality;
    const post=postprocessor.update({epochIndex:input.classifiedEpochIndex,rawStage:modelStage,rawProbabilities:smooth.probabilities,
        quality,deltaRatio:quality.deltaRatio,contextReady:input.historyEpochs>=input.temporalContext&&input.contextQualityOk===true,
        contextQualityOk:input.contextQualityOk===true,controlEligible:input.controlEligible===true});
    return {epochIndex:input.classifiedEpochIndex,stage:post.stage||modelStage,modelStage,candidateStage:post.candidateStage||modelStage,
        confidence:post.confidence,candidateConfidence:post.candidateConfidence,probabilities:smooth.probabilities,rawProbabilities:Array.from(result),
        quality,controlEligible:modelStage==='N3'?post.controlEligible===true:input.controlEligible===true&&quality.ok===true,
        stimulusControlEligible:input.controlEligible===true&&quality.ok===true,n3Postprocessed:post.n3Status==='trusted',n3Status:post.n3Status,
        historyEpochs:input.historyEpochs};
}

function simulate(predictions,protocol){
    const p=Sleep.normalizeStimulusProtocol({...protocol,enabled:true,shadowMode:true});
    const errors=Sleep.validateStimulusProtocol(p);if(errors.length)throw Error(errors.join('；'));
    const gate=new Sleep.SleepStageStimulusGate(p),triggers=[],reasons={};
    for(const row of predictions){
        if(row.skipped){gate.reject('missing_data');continue;}
        const probabilityN3=p.n3TriggerMode==='probability'&&p.targetStages.includes('N3')&&(row.candidateStage==='N3'||row.stage==='N3');
        if(!(probabilityN3?row.stimulusControlEligible:row.controlEligible)){gate.reject('control_ineligible');reasons.control_ineligible=(reasons.control_ineligible||0)+1;continue;}
        const now=row.observedEndMs;
        const decision=gate.evaluate(row,now);const reason=decision.triggered?'triggered':decision.reason;reasons[reason]=(reasons[reason]||0)+1;
        if(decision.triggered)triggers.push({epochIndex:row.epochIndex,seconds:now/1000,stage:decision.stage,
            channels:p.lightChannel===3?[1,2]:[p.lightChannel],durationSeconds:p.durationSeconds,frequencyHz:p.frequencyHz,
            powerPercent:p.powerPercent,hardwareCommandsSent:0,kind:'simulation_only'});
    }
    return {protocol:p,triggers,reasons,hardwareCommandsSent:0};
}

function compareN3Votes(predictions, options = {}) {
    const lightEvents = options.lightEvents || [];
    const sessionStart = Date.parse(options.startedAt);
    if (lightEvents.length && (!options.recordedTimeline || !Number.isFinite(sessionStart)
        || lightEvents.some(event => !Number.isFinite(event.time)))) {
        return { unavailable: '有光照记录，但无法与脑电片段对齐' };
    }
    const lightIntervals = [];
    const active = new Map();
    for (const event of lightEvents) {
        const time = event.time - sessionStart;
        if (event.action === 'light_started') {
            if (!active.has(event.channel)) active.set(event.channel, time);
        } else if (active.has(event.channel)) {
            lightIntervals.push([active.get(event.channel), time]);
            active.delete(event.channel);
        }
    }
    for (const start of active.values()) lightIntervals.push([start, Infinity]);

    const trial = new Sleep.N3VoteTrial();
    const cnnHits = [];
    const voteHits = [];
    const reasons = {};
    for (const row of predictions) {
        const end = row.observedEndMs;
        const lightOn = lightIntervals.some(([start, stop]) => start <= end && stop >= end - 30_000);
        const decision = trial.evaluate(lightOn ? { ...row, lightChannels: [1] } : row, end);
        if (!decision) continue;
        const hit = { epochIndex: row.epochIndex, seconds: end / 1000,
            n3Probability: decision.n3Probability, deltaRatio: decision.deltaRatio };
        if (decision.cnn.triggered) cnnHits.push(hit);
        if (decision.vote.triggered) voteHits.push(hit);
        const reason = decision.vote.triggered ? 'triggered' : decision.vote.reason;
        reasons[reason] = (reasons[reason] || 0) + 1;
    }
    return { profile: Sleep.N3_VOTE_PROFILE, cnnHits, voteHits, reasons, hardwareCommandsSent: 0 };
}

async function inferAll(data,model,ort,onProgress=()=>{},isCancelled=()=>false,mode='causal'){
    if(data.rate!==250)throw Error(`当前实时回放要求 250 Hz，该记录为 ${data.rate} Hz`);
    const filter=new SDK.filters.EegFilterBank(250,1,SDK.filters.MODEL_TRAINING_PRESET,{initialization:'zero',implementation:'direct2t'});
    const pipeline=new Sleep.RealtimeSleepPipeline({inputRateHz:250,modelRateHz:100,epochSeconds:30,temporalContext:21,qualityWarmupSeconds:5});
    const smoother=new Sleep.SleepStageSmoother({alpha:.5}),post=new Post.N3Postprocessor({mode});
    const predictions=[],qualityCounts={};let previousSeq=null,duplicates=0,missing=0,nonmonotonic=0,lastTime=-Infinity;
    for(let index=0;index<data.values.length;index++){
        if(index%7500===0&&isCancelled())throw Error('回放已停止');
        let gap=0;
        if(data.sequences){const seq=data.sequences[index];if(previousSeq!=null){const delta=(seq-previousSeq+65536)%65536;if(delta===0)duplicates++;else if(delta<32768)gap=delta-1;}previousSeq=seq;}
        if(data.gaps)gap=data.gaps[index];missing+=gap;
        const recordedTime=data.elapsedMs?.[index];if(Number.isFinite(recordedTime)){if(recordedTime<lastTime)nonmonotonic++;lastTime=recordedTime;}
        const rawCode=data.rawCodes?.[index]??Math.max(-8388608,Math.min(8388607,Math.round(data.values[index]*24*8388608/4.5e6)));
        const epoch=pipeline.push(filter.process(0,data.values[index]),{rawCode,seqGap:gap});if(!epoch)continue;
        qualityCounts[epoch.quality.reason]=(qualityCounts[epoch.quality.reason]||0)+1;
        const observedEndMs=Number.isFinite(recordedTime)?recordedTime:epoch.totalEpochs*30000;
        if(epoch.gapSamples){predictions.push({epochIndex:epoch.totalEpochs-1,skipped:true,quality:epoch.quality,observedEndMs});continue;}
        const input=mode==='center'?pipeline.inferenceInput():pipeline.onlineInferenceInput();if(!input)continue;
        const feeds={eeg:new ort.Tensor('float32',Float32Array.from(input.eeg),[1,21,1,3000]),
            epoch_index:new ort.Tensor('float32',Float32Array.from(input.epochIndex),[1,21,1]),
            epoch_cycle_index:new ort.Tensor('float32',Float32Array.from(input.epochCycleIndex),[1,21,5])};
        const result=await model.run(feeds);const checked=Integrity.inspectRuntimeOutputs(result);if(!checked.ok)throw Error('模型输出校验失败');
        const raw=Array.from(result.prob.data).slice(input.outputIndex*5,input.outputIndex*5+5),sum=raw.reduce((s,v)=>s+v,0);
        predictions.push({...makePrediction(input,raw.map(v=>v/sum),smoother,post),observedEndMs});
        if(epoch.totalEpochs%120===0)onProgress({epochs:epoch.totalEpochs,seconds:index/250});
    }
    return {predictions,qualityCounts,duplicates,missing,nonmonotonic,incompleteSamples:pipeline.current.length};
}

async function runYasa(record,output,rootDir,options={}){
    if(!(Number(record.metadata.rows)>=Number(record.metadata.sampleRateHz||250)*30))return {skipped:true,reason:'不足 30 秒'};
    const executable=process.env.BRAINLUME_PYTHON||path.join(rootDir,'.venv-yasa',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    return new Promise(resolve=>{
        const child=spawn(executable,['-B',path.join(rootDir,'python/yasa_offline_staging.py'),'--session-dir',record.directory,'--output-dir',output],{stdio:['ignore','pipe','pipe'],env:{...process.env,NUMBA_CACHE_DIR:path.join(path.dirname(output),'numba-cache')}});let stdout='',stderr='';
        options.children?.add(child);
        const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
        child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
        child.on('error',e=>{clearTimeout(timer);options.children?.delete(child);resolve({error:e.message});});
        child.on('close',code=>{clearTimeout(timer);options.children?.delete(child);const lines=stdout.trim().split('\n');let value;for(const line of lines.reverse()){try{value=JSON.parse(line);break;}catch{}}
            resolve(code===0&&value?.ok?value:{error:value?.error||stderr.trim().slice(-1500)||`YASA 退出码 ${code}`});});
    });
}

async function runBatch(options,onProgress=()=>{}){
    const rootDir=options.rootDir||path.resolve(__dirname,'..'),sessionsRoot=path.resolve(options.sessionsRoot),output=path.resolve(options.output);
    const cacheRoot=path.join(path.dirname(output),'cache');await fsp.mkdir(output,{recursive:true});
    const isCancelled=options.isCancelled||(()=>false);
    const records=await inventory(sessionsRoot),ort=require('onnxruntime-node');
    const verified=await Integrity.createValidatedSession({rootDir},file=>ort.InferenceSession.create(file,{executionProviders:['cpu'],graphOptimizationLevel:'all',intraOpNumThreads:1}));
    const pipelineHash=hash(Buffer.concat(['src/history-replay.js','src/realtime-sleep.js','src/sleep-stage-postprocess.js','src/vendor/BrainLume_Lib.js','python/yasa_offline_staging.py'].map(p=>fs.readFileSync(path.join(rootDir,p)))));
    const signature=hash(Buffer.from(JSON.stringify({pipelineHash,model:verified.assetReport.actualHashes})));
    const protocol=Sleep.normalizeStimulusProtocol({...DEFAULT_PROTOCOL,...options.protocol,enabled:true,shadowMode:true});
    const report={createdAt:new Date().toISOString(),sessionsRoot,output,signature,model:verified.assetReport.actualHashes,protocol,
        hardwareCommandsSent:0,files:[],watch:options.watchComparison||null,limitations:['回放验证数据处理和触发规则，不能验证真实光照效果。','实时结果只使用已到达的样本；YASA 可使用完整记录，二者分开统计。','旧 EDF 的精度损失和丢失时刻不能凭回放恢复。','手表是另一套算法的估计，不是人工睡眠标签；这里只比较同次记录的汇总。']};
    const started=Date.now();
    try{for(let i=0;i<records.length;i++){
        if(isCancelled())break;
        const record=records[i],t=Date.now();onProgress({index:i,total:records.length,sessionId:record.metadata.id,phase:'read'});
        const item={id:record.metadata.id,startedAt:record.metadata.startedAt,endedAt:record.metadata.endedAt,status:record.metadata.status,directory:record.directory};
        try{
            if(record.metadata.status==='recording'){item.result='skipped';item.error='正在采集，停止采集后再回放';report.files.push(item);continue;}
            const events=await eventSummary(record.directory),data=await loadRecording(record);item.source=data.source;item.samples=data.values.length;item.seconds=data.values.length/data.rate;
            item.timeline=data.timeline;item.warnings=[...data.warnings];item.events={counts:events.counts,recordedGapEvents:events.gaps.length,loggedCrcErrors:events.crc};
            if(events.gaps.length&&data.timeline==='sample_order_only')item.warnings.push('日志记录过断档，但旧 EDF 没有缺口位置；触发结果只是假设样本连续时的推演。');
            const fingerprint=hash(Buffer.from(signature+data.fingerprint+hash(await fsp.readFile(path.join(record.directory,'events.jsonl')).catch(()=>Buffer.alloc(0)))));
            const cachedDir=path.join(cacheRoot,fingerprint),cached=await json(path.join(cachedDir,'replay.json'));
            const replay=cached||await inferAll(data,verified.session,ort,progress=>onProgress({index:i,total:records.length,phase:'replay',...progress}),isCancelled);
            if(!cached)await writeJson(path.join(cachedDir,'replay.json'),replay);item.cacheHit=Boolean(cached);
            item.quality=replay.qualityCounts;item.duplicates=replay.duplicates;item.knownMissingSamples=replay.missing;item.nonmonotonicTimestamps=replay.nonmonotonic;
            item.replay=simulate(replay.predictions,protocol);
            item.n3Review=simulate(replay.predictions,{...protocol,targetStages:['N3']});
            item.n3VoteTrial = compareN3Votes(replay.predictions, {
                startedAt: record.metadata.startedAt, lightEvents: events.lightEvents,
                recordedTimeline: data.timeline === 'recorded' && !replay.nonmonotonic,
            });
            item.stages=Object.fromEntries([...STAGES,'UNKNOWN'].map(s=>[s,0]));let longest=0,run=0,previous=null;item.maxN3Probability=0;
            for(const row of replay.predictions){if(row.skipped){run=0;item.stages.UNKNOWN++;continue;}item.stages[row.stage]=(item.stages[row.stage]||0)+1;item.maxN3Probability=Math.max(item.maxN3Probability,row.probabilities[3]);
                if(row.quality.ok&&row.stimulusControlEligible&&row.probabilities[3]>=protocol.minN3Probability){run=previous===row.epochIndex-1?run+1:1;}else run=0;longest=Math.max(longest,run);previous=row.epochIndex;}
            item.longestEligibleN3Run=longest;item.incompleteSamples=replay.incompleteSamples;
            const perRecord=path.join(output,record.metadata.id);await writeJson(path.join(perRecord,'replay.json'),{...item,predictions:replay.predictions});
            const columns=['epochIndex','observedEndMs','stage','candidateStage','confidence','N3_probability','quality','controlEligible'];
            await fsp.writeFile(path.join(perRecord,'epochs.csv'),'\uFEFF'+columns.join(',')+'\n'+replay.predictions.map(r=>[r.epochIndex,r.observedEndMs,r.stage||'UNKNOWN',r.candidateStage||'',r.confidence??'',r.probabilities?.[3]??'',r.quality?.reason||'',r.stimulusControlEligible===true].join(',')).join('\n'));
            onProgress({index:i,total:records.length,sessionId:item.id,phase:'yasa'});
            const savedYasa=await json(path.join(cachedDir,'yasa/yasa_summary.json'));
            if(isCancelled())break;
            item.yasa=savedYasa?.ok?savedYasa:await runYasa(record,path.join(cachedDir,'yasa'),rootDir,options);
            if(isCancelled())break;
            if(item.yasa?.ok)await writeJson(path.join(perRecord,'yasa_summary.json'),item.yasa);
            item.result=data.values.length===0?'empty':item.seconds<30?'short':'ok';
        }catch(error){item.result='failed';item.error=error.stack||error.message;}
        item.elapsedSeconds=(Date.now()-t)/1000;report.files.push(item);
        await writeJson(path.join(output,'results.json'),report);onProgress({index:i+1,total:records.length,phase:'record_complete',sessionId:item.id,result:item.result});
    }}finally{await verified.session.release();}
    report.elapsedSeconds=(Date.now()-started)/1000;report.recordedHours=report.files.reduce((sum,x)=>sum+(x.seconds||0),0)/3600;
    report.cancelled=isCancelled();report.finished=!report.cancelled;await writeJson(path.join(output,'results.json'),report);
    await fsp.writeFile(path.join(output,'report.html'),buildReport(report));
    if(!report.cancelled)await writeJson(path.join(path.dirname(output),'latest.json'),{output,createdAt:report.createdAt});
    return report;
}

function buildReport(report){
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const p=report.protocol;
    const counts={ok:'已回放',empty:'空记录',short:'不足30秒',skipped:'已跳过',failed:'失败'};
    const rows=report.files.map(r=>`<tr><td>${esc(r.startedAt?.replace('T',' ').slice(0,19))}</td><td>${((r.seconds||0)/60).toFixed(1)}</td><td>${counts[r.result]||'未完成'}</td><td>${((r.maxN3Probability||0)*100).toFixed(1)}%</td><td>${r.longestEligibleN3Run??'--'}</td><td>${r.replay?.triggers.length??'--'}</td><td>${r.n3Review?.triggers.length??'--'}</td><td title="${esc(r.n3VoteTrial?.unavailable || '')}">${r.n3VoteTrial?.cnnHits ? `${r.n3VoteTrial.cnnHits.length} / ${r.n3VoteTrial.voteHits.length}` : '--'}</td><td>${r.yasa?.ok?((r.yasa.stageCounts?.N3||0)/2).toFixed(1):esc(r.yasa?.reason||r.yasa?.error||'未完成')}</td><td><details><summary>查看</summary><p>${esc((r.warnings||[]).join(' '))}</p><p>${esc(r.error||'')}</p><a href="${esc(r.id)}/epochs.csv">逐片段结果</a></details></td></tr>`).join('');
    const watchRows=(report.watch?.sessions||[]).filter(w=>w.status==='available').map(w=>{
        const r=report.files.find(x=>x.id===w.id);if(!r)return '';
        return `<tr><td>${esc(r.startedAt?.replace('T',' ').slice(0,16))}</td><td>${Number(w.stageMinutes.AsleepDeep||0).toFixed(1)}</td><td>${r.yasa?.ok?((r.yasa.stageCounts?.N3||0)/2).toFixed(1):'--'}</td><td>${r.n3Review?.triggers.length??'--'}</td></tr>`;
    }).join('');
    const short=report.files.filter(r=>['short','empty'].includes(r.result)).length;
    const watch=watchRows?`<h2>同一时段：手表与脑电</h2><p>只比较有记录覆盖的时段。手表深睡与脑电 N3 来自不同算法，不能据此计算准确率。</p><table><tr><th>记录开始</th><th>手表深睡（分钟）</th><th>YASA N3（分钟）</th><th>实时回放 N3 命中</th></tr>${watchRows}</table>`:'';
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>历史脑电回放</title><style>body{font:15px/1.7 system-ui;margin:32px;color:#18303a;background:#f4f7fa}h1{font-size:26px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:10px;border:1px solid #d9e2e9;text-align:left}th{position:sticky;top:0;background:#eaf1fa}details{max-width:300px}small,p{color:#596b76}.notice{padding:14px;background:#fff5df}.table-wrap{overflow:auto}</style><h1>历史脑电回放</h1><p>${report.files.length} 条记录 · ${report.recordedHours.toFixed(2)} 小时数据 · 本次用时 ${report.elapsedSeconds.toFixed(1)} 秒</p><p>${report.files.filter(r=>r.seconds>=30).length} 条达到 30 秒；${short} 条不足 30 秒或为空。${report.cancelled?'本次提前停止，仅显示已完成部分。':''}</p><p>本次测试方案：${esc(p.targetStages.join(' / '))}；N3 概率至少 ${Math.round(p.minN3Probability*100)}%（选中 N3 时）；连续 ${p.consecutiveEpochs} 个 30 秒片段；${p.lightChannel===3?'两个光源一起':`光源 ${p.lightChannel}`}，${p.frequencyHz} Hz、${p.powerPercent}%、每次 ${p.durationSeconds/60} 分钟，启动间隔 ${p.cooldownMinutes} 分钟。仅模拟，不开灯。</p><div class="notice">${report.limitations.map(esc).join('<br>')}<br>“命中”表示满足回放规则，不代表真实睡眠准确率。N3 最高概率包含质量不合格的片段；是否达标还要看质量与连续次数。旧 EDF 的命中时刻不能直接对应钟表时间。N3 双路对照使用 CNN 50%、慢波占比 50%、连续 4 段。</div><div class="table-wrap"><table><thead><tr><th>开始时间</th><th>数据分钟</th><th>状态</th><th>N3 最高概率</th><th>N3 最长连续达标</th><th>本次方案命中</th><th>仅选 N3 时命中</th><th>N3 模拟：CNN / 双路</th><th>YASA N3 分钟</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></div>${watch}</html>`;
}
module.exports={DEFAULT_PROTOCOL,inventory,eventSummary,loadRecording,makePrediction,simulate,compareN3Votes,inferAll,runBatch,buildReport};
