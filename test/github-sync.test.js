'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GithubSync = require('../src/github-sync');

test('GitHub EDF archive defaults to the linked private repository and stable date path', () => {
    const config = GithubSync.normalizeGithubConfig({});
    assert.equal(config.repository, 'Jaycob-jh/EEG_tls_Upper');
    assert.equal(config.branch, 'main');
    assert.equal(config.directory, 'data/edf');
    assert.equal(config.autoUploadStimulated, true);
    assert.equal(GithubSync.buildEdfArchivePath({ id: 'session:one', startedAt: '2026-09-03T01:02:03+08:00' }, config), 'data/edf/2026-09-03/session_one.edf');
    assert.deepEqual(GithubSync.buildSessionArchivePaths({ id: 'session:one', startedAt: '2026-09-03T01:02:03+08:00' }, config), {
        edf: 'data/edf/2026-09-03/session_one.edf',
        events: 'data/edf/2026-09-03/session_one.events.jsonl',
    });
});

test('GitHub configuration validation rejects malformed or unsafe destinations', () => {
    assert.deepEqual(GithubSync.validateGithubConfig({ repository: 'not-a-repository', branch: 'main', directory: 'data/edf' }), ['GitHub 仓库必须是 owner/repository 格式']);
    assert.ok(GithubSync.validateGithubConfig({ repository: 'owner/repo', branch: '../main', directory: 'data/edf' }).includes('GitHub 分支名无效'));
    assert.ok(GithubSync.validateGithubConfig({ repository: 'owner/repo', branch: 'main', directory: '../edf' }).includes('GitHub 数据目录无效'));
});

test('GitHub content API paths encode repository and EDF path segments without exposing tokens', () => {
    const path = GithubSync.contentApiPath('owner/repo', 'data/edf/2026-09-03/session one.edf');
    assert.equal(path, '/repos/owner/repo/contents/data/edf/2026-09-03/session%20one.edf');
    assert.equal(Object.keys(GithubSync.DEFAULT_GITHUB_CONFIG).includes('token'), false);
    assert.equal(GithubSync.hasStimulationEvents([
        { action: 'session_started' }, { action: 'light_started' }, { action: 'light_stopped' },
    ]), true);
    assert.equal(GithubSync.hasStimulationEvents([{ action: 'sleep_stimulus_shadow_triggered' }]), true);
    assert.equal(GithubSync.hasPhysicalStimulationEvents([{ action: 'sleep_stimulus_shadow_triggered' }]), false);
    assert.equal(GithubSync.hasPhysicalStimulationEvents([{ action: 'light_started' }]), true);
});

test('GitHub upload status is normalized and bounded for UI persistence', () => {
    const status = GithubSync.normalizeUploadStatus({
        status: 'failed', repository: 'owner/repo', path: 'data/edf/a.edf',
        files: [{ kind: 'edf', path: 'data/edf/a.edf', bytes: '10' }, { kind: 'events', path: 'data/edf/a.events.jsonl' }],
        attempts: '2', error: 'x'.repeat(500),
    });
    assert.equal(status.attempts, 2);
    assert.equal(status.error.length, 300);
    assert.equal(status.repository, 'owner/repo');
    assert.equal(status.files.length, 2);
    assert.equal(status.files[0].bytes, 10);
    assert.equal(status.files[1].kind, 'events');
});

test('records UI and IPC expose history upload without broadening the upload scope', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.match(html, /id="github-history-button"[^>]*>同步前几天数据/);
    assert.match(html, /events\.jsonl/);
    assert.match(app, /getGithubHistoryCandidates/);
    assert.match(app, /uploadGithubHistory/);
    assert.match(main, /github-sync:history-candidates/);
    assert.match(main, /github-sync:upload-history/);
    assert.match(main, /recording\.eventsPath/);
    assert.match(preload, /getGithubHistoryCandidates/);
    assert.match(preload, /uploadGithubHistory/);
    assert.match(main, /自动 EDF 归档只允许私有 GitHub 仓库/);
});
