'use strict';
const path=require('node:path');
const os=require('node:os');
const fs=require('node:fs');
const {runBatch}=require('../src/history-replay');
const Storage=require('../src/storage-paths');
const defaults=Storage.dataPaths(path.join(os.homedir(),'Documents'),require('../package.json').version);
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:fallback;};
const sessionsRoot=arg('--sessions-root',defaults.sessions);
const output=arg('--output',path.join(defaults.root,'analysis/history-replay',new Date().toISOString().replace(/[:.]/g,'-')));
const protocolFile=arg('--protocol-file','');
runBatch({sessionsRoot,output,protocol:protocolFile?JSON.parse(fs.readFileSync(protocolFile)):undefined},p=>process.stdout.write(JSON.stringify(p)+'\n'))
    .then(r=>{console.log(JSON.stringify({output,files:r.files.length,hours:r.recordedHours,elapsedSeconds:r.elapsedSeconds,failed:r.files.filter(x=>x.result==='failed').map(x=>({id:x.id,error:x.error}))}));if(r.files.some(x=>x.result==='failed'))process.exitCode=1;})
    .catch(e=>{console.error(e.stack);process.exitCode=1;});
