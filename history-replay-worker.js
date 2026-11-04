'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const {runBatch}=require('./src/history-replay');
let cancelled=false;
const children=new Set();
parentPort.on('message',message=>{if(message==='cancel'){cancelled=true;for(const child of children)child.kill('SIGTERM');}});
runBatch({...workerData,isCancelled:()=>cancelled,children},progress=>parentPort.postMessage({type:'progress',progress}))
    .then(report=>parentPort.postMessage({type:'done',output:report.output,cancelled:report.cancelled,records:report.files.length,hours:report.recordedHours,seconds:report.elapsedSeconds,failures:report.files.filter(r=>r.result==='failed').length}))
    .catch(error=>parentPort.postMessage({type:'error',error:error.message}))
    .finally(()=>parentPort.close());
