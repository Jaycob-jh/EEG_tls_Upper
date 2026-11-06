'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const Storage=require('../src/storage-paths');const {separateRecordings}=require('../scripts/separate-version-data');
test('different release families use separate data and Chromium profiles; patch updates retain their family',()=>{
    assert.notEqual(Storage.profilePath('/profiles','0.5.1'),Storage.profilePath('/profiles','0.6.1'));
    assert.notEqual(Storage.dataPaths('/docs','0.5.1').root,Storage.dataPaths('/docs','0.6.1').root);
    assert.deepEqual(Storage.dataPaths('/docs','0.6.1'),Storage.dataPaths('/docs','0.6.2'));
    assert.throws(()=>Storage.versionFamily('../legacy'));
});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'caocao-separate-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const sourceRoot=path.join(root,'old'),destinationRoot=path.join(root,'new'),archiveRoot=path.join(root,'backup');await fs.mkdir(sourceRoot);return {root,sourceRoot,destinationRoot,archiveRoot,version:'0.6.1'};}
async function record(options,id,version,status='completed'){const d=path.join(options.sourceRoot,id);await fs.mkdir(d);await fs.writeFile(path.join(d,'session.json'),JSON.stringify({id,appVersion:version,status,directory:d}));await fs.writeFile(path.join(d,'raw_adc.bin'),Buffer.from([1,2,3,4]));return d;}
test('migration selects only matching-version records, preserves original bytes in backup and updates new paths',async t=>{
    const o=await fixture(t);const old=await record(o,'legacy','0.5.1');const current=await record(o,'current','0.6.0');const original=await fs.readFile(path.join(current,'session.json'));
    const result=await separateRecordings(o);assert.equal(result.moved.length,1);assert.equal(result.kept.length,1);
    assert.equal((await fs.stat(old)).isDirectory(),true);await assert.rejects(fs.stat(current),{code:'ENOENT'});
    assert.deepEqual(await fs.readFile(path.join(o.archiveRoot,'current/session.json')),original);
    assert.deepEqual(await fs.readFile(path.join(o.destinationRoot,'current/raw_adc.bin')),Buffer.from([1,2,3,4]));
    assert.equal(JSON.parse(await fs.readFile(path.join(o.destinationRoot,'current/session.json'))).directory,path.join(o.destinationRoot,'current'));
});
test('migration refuses active recordings before moving anything',async t=>{const o=await fixture(t);const first=await record(o,'a','0.6.0');await record(o,'z','0.5.1','recording');await assert.rejects(separateRecordings(o),/Stop all/);assert.equal((await fs.stat(first)).isDirectory(),true);});
test('migration preflights destination collisions without overwriting files',async t=>{const o=await fixture(t);const first=await record(o,'a','0.6.0');await record(o,'z','0.6.0');await fs.mkdir(path.join(o.destinationRoot,'z'),{recursive:true});await assert.rejects(separateRecordings(o),/already exists/);assert.equal((await fs.stat(first)).isDirectory(),true);});
