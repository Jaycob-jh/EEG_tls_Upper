'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { versionFamily } = require('../src/storage-paths');

async function hashes(root) {
    const result = {};
    async function visit(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`Cannot migrate a symbolic link: ${file}`);
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile()) result[path.relative(root, file)] = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
        }
    }
    await visit(root);
    return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
async function exists(file) { try { await fs.access(file); return true; } catch (e) { if (e.code==='ENOENT') return false; throw e; } }
function rebase(value, source, destination) {
    if (typeof value === 'string') return value === source ? destination : value.startsWith(source + path.sep) ? destination + value.slice(source.length) : value;
    if (Array.isArray(value)) return value.map(v=>rebase(v,source,destination));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebase(v,source,destination)]));
    return value;
}
async function separateRecordings({ sourceRoot, destinationRoot, archiveRoot, version }) {
    const source = path.resolve(sourceRoot), destination = path.resolve(destinationRoot), archive = path.resolve(archiveRoot);
    if (source===destination || destination.startsWith(source+path.sep) || archive===source || archive.startsWith(source+path.sep)) throw new Error('Migration locations must be separate');
    const family = versionFamily(version), selected = [], kept = [];
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const from = path.join(source, entry.name), metadataFile = path.join(from,'session.json');
        if (!await exists(metadataFile)) continue;
        const metadata = JSON.parse(await fs.readFile(metadataFile,'utf8'));
        if (metadata.status==='recording') throw new Error('Stop all recordings before migration');
        let recordFamily;try { recordFamily=versionFamily(metadata.appVersion); } catch { recordFamily=null; }
        if (recordFamily!==family) { kept.push(metadata.id);continue; }
        const to=path.join(destination,entry.name), backup=path.join(archive,entry.name);
        if (await exists(to) || await exists(backup)) throw new Error(`Migration destination already exists: ${entry.name}`);
        selected.push({from,to,backup,id:metadata.id});
    }
    // Complete preflight before changing any recording.
    await fs.mkdir(destination,{recursive:true});await fs.mkdir(archive,{recursive:true});
    const moved=[];
    for (const record of selected) {
        const staging=record.to+'.migrating-'+crypto.randomUUID();let placed=false,archived=false;
        try {
            const originalHashes=await hashes(record.from);
            await fs.cp(record.from,staging,{recursive:true,errorOnExist:true,force:false});
            if (JSON.stringify(originalHashes)!==JSON.stringify(await hashes(staging))) throw new Error('Copied recording checksum mismatch');
            for (const file of Object.keys(originalHashes).filter(f=>f.endsWith('.json'))) {
                const target=path.join(staging,file);let data;
                try { data=JSON.parse(await fs.readFile(target,'utf8')); } catch { continue; }
                const updated=rebase(data,record.from,record.to);
                if (file==='session.json') updated.directory=record.to;
                if (JSON.stringify(updated)!==JSON.stringify(data)) await fs.writeFile(target,JSON.stringify(updated,null,2)+'\n');
            }
            const finalHashes=await hashes(staging);
            await fs.rename(staging,record.to);placed=true;
            await fs.rename(record.from,record.backup);archived=true;
            if (JSON.stringify(originalHashes)!==JSON.stringify(await hashes(record.backup))) throw new Error('Archived original checksum mismatch');
            if (JSON.stringify(finalHashes)!==JSON.stringify(await hashes(record.to))) throw new Error('Final recording checksum mismatch');
            moved.push({...record,originalHashes,finalHashes});
        } catch (error) {
            if (!archived) await fs.rm(placed?record.to:staging,{recursive:true,force:true});
            throw error;
        }
    }
    return { family,source,destination,archive,kept,moved };
}
module.exports={separateRecordings,hashes};
