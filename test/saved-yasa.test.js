'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {readSavedYasaResult}=require('../src/saved-yasa');
test('saved YASA results reopen only for the same complete recording and use its current file paths',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'caocao-yasa-cache-'));
    try{
        const directory=path.join(root,'analysis/yasa');await fs.mkdir(directory,{recursive:true});
        const metadata={id:'night-a',status:'completed',rows:7500,sampleRateHz:250,rawDataFile:'raw_adc.bin',rawRecordBytes:16};
        const result={ok:true,sessionId:'night-a',epochCount:1,durationSeconds:30,outputFiles:{summaryJson:'/old/path',epochsCsv:'/old/path'}};
        await fs.writeFile(path.join(root,'raw_adc.bin'),Buffer.alloc(7500*16));
        await fs.writeFile(path.join(directory,'yasa_epochs.csv'),'stage\nW\n');
        await fs.writeFile(path.join(directory,'yasa_summary.json'),JSON.stringify(result));
        const saved=await readSavedYasaResult(root,metadata);
        assert.equal(saved.sessionId,'night-a');assert.equal(saved.outputFiles.epochsCsv,path.join(directory,'yasa_epochs.csv'));
        assert.equal(await readSavedYasaResult(root,{...metadata,id:'night-b'}),null);
        assert.equal(await readSavedYasaResult(root,{...metadata,status:'recording'}),null);
        assert.equal(await readSavedYasaResult(root,{...metadata,rows:15000}),null);
        await fs.writeFile(path.join(directory,'yasa_summary.json'),JSON.stringify({...result,durationSeconds:60,epochCount:2}));
        // A 59.6-second EDF used to be padded to 60 seconds and falsely
        // accepted as a two-epoch result because of the one-second tolerance.
        assert.equal(await readSavedYasaResult(root,{...metadata,rawDataFile:undefined,rows:14900}),null);
        await fs.writeFile(path.join(directory,'yasa_summary.json'),'broken');
        assert.equal(await readSavedYasaResult(root,metadata),null);
    }finally{await fs.rm(root,{recursive:true,force:true});}
});
