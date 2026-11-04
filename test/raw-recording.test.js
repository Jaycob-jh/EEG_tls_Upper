'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeRawRecords, decodeRawRecords } = require('../src/raw-recording');
const { digitalFromMicrovolts, microvoltsFromDigital } = require('../src/edf');
const Sleep = require('../src/realtime-sleep');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EdfWriter, readEdf } = require('../src/edf');

test('recording start, batched append and stop save the exact raw stream alongside EDF', async () => {
    const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'caocao-raw-integration-'));
    try {
        const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
        const code=source.slice(source.indexOf('async function startRecording('),source.indexOf('async function listSessions('));
        const context=vm.createContext({
            fs,fsp:fs.promises,path,Buffer,crypto:require('node:crypto'),EdfWriter,encodeRawRecords,
            activeRecordings:new Map(),ensureDataDirectories:async()=>({sessions:root}),
            localFileStamp:()=> 'fixture',safeFilePart:x=>x,nowIso:()=>new Date().toISOString(),
            writeJsonAtomic:(p,v)=>fs.promises.writeFile(p,JSON.stringify(v)),
            prepareAutomaticGithubUpload:async()=>({status:'not_applicable'}),
        });
        vm.runInContext(code,context);
        const session=await context.startRecording({id:'raw-roundtrip',rawStorageVersion:1,sampleRateHz:250});
        const rows=Array.from({length:255},(_,i)=>({rawCode:i-128,seq:i,elapsedMs:i*4+.25}));
        await context.appendRecordingSamples(session.id,rows.slice(0,128));
        await context.appendRecordingSamples(session.id,rows.slice(128));
        await context.stopRecording(session.id);
        const metadata=JSON.parse(await fs.promises.readFile(path.join(session.directory,'session.json')));
        const raw=decodeRawRecords(await fs.promises.readFile(path.join(session.directory,metadata.rawDataFile)));
        assert.equal(metadata.rows,255);
        assert.deepEqual(Array.from(raw.rawCodes),rows.map(r=>r.rawCode));
        assert.deepEqual(Array.from(raw.elapsedMs),rows.map(r=>r.elapsedMs));
        assert.equal((await readEdf(path.join(session.directory,'eeg_raw.edf'))).values.length,500);
        assert.equal(metadata.edfPaddedSamples,245);
        const workerSource=fs.readFileSync(path.join(__dirname,'../analysis-worker.js'),'utf8');
        const workerContext=vm.createContext({fs,fsp:fs.promises,path,readEdf,decodeRawRecords,eventSequenceGapCount:()=>0});
        vm.runInContext(workerSource.slice(workerSource.indexOf('async function loadEdf('),workerSource.indexOf('function sliceBySeconds(')),workerContext);
        const loaded=await workerContext.loadEdf(session.directory,metadata,[]);
        assert.deepEqual(Array.from(loaded.values),Array.from(raw.values));
        assert.equal(loaded.edfPath,path.join(session.directory,'raw_adc.bin'));
    } finally { await fs.promises.rm(root,{recursive:true,force:true}); }
});

test('all ADC bits, sequence wrap and timestamps survive binary roundtrip', () => {
    const codes = [-8388608, -8388607, -1000, -1, 0, 1, 1000, 8388606, 8388607];
    const rows = codes.map((rawCode, i) => ({ rawCode, seq: (65533 + i) % 65536, elapsedMs: 4*i+.123 }));
    const bytes = encodeRawRecords(rows), restored = decodeRawRecords(bytes);
    assert.equal(bytes.length, rows.length*16);
    assert.deepEqual(Array.from(restored.rawCodes),codes);
    assert.deepEqual(Array.from(restored.sequences),rows.map(r=>r.seq));
    assert.deepEqual(Array.from(restored.elapsedMs),rows.map(r=>r.elapsedMs));
    assert.equal(restored.values[5],4.5e6/(24*8388608));
});

test('small EEG variations survive raw storage even when EDF quantization loses them', () => {
    const rows = [1,2,3].map(rawCode=>({rawCode,seq:rawCode,elapsedMs:rawCode*4}));
    const restored=decodeRawRecords(encodeRawRecords(rows));
    assert.equal(new Set(restored.values).size,3);
    const edf=Array.from(restored.values,v=>microvoltsFromDigital(digitalFromMicrovolts(v,-187500,187500),-187500,187500));
    assert.equal(new Set(edf).size,1);
});

test('invalid ADC codes and partial binary records fail visibly', () => {
    assert.throws(()=>encodeRawRecords([{rawCode:8388608,seq:0,elapsedMs:0}]));
    assert.throws(()=>decodeRawRecords(Buffer.alloc(15)));
});

test('N3 hits separated by a skipped epoch do not count as consecutive', () => {
    const gate=new Sleep.SleepStageStimulusGate({enabled:true,minN3Probability:.7,consecutiveEpochs:2});
    const row=epochIndex=>({epochIndex,stage:'N3',confidence:.9,probabilities:[0,0,0,.9,.1],quality:{ok:true}});
    assert.equal(gate.evaluate(row(1),30000).triggered,false);
    assert.equal(gate.evaluate(row(3),90000).triggered,false);
    assert.equal(gate.evaluate(row(4),120000).triggered,true);
});
