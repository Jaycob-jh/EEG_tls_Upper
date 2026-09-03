'use strict';

const DEFAULT_GITHUB_CONFIG = Object.freeze({
    repository: 'Jaycob-jh/EEG_tls_Upper',
    branch: 'main',
    directory: 'data/edf',
    // The requested behavior is enabled by default, but it remains dormant
    // until the user stores a GitHub token and passes the private-repository
    // connection check.
    autoUploadStimulated: true,
});

const MAX_CONTENT_API_BYTES = 95 * 1024 * 1024;

function safePart(value, fallback = 'session') {
    return String(value || fallback)
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 100) || fallback;
}

function normalizeRepository(value) {
    const source = String(value || '').trim()
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/\.git\/?$/i, '')
        .replace(/^\/+|\/+$/g, '');
    const match = /^([^/]+)\/([^/]+)$/.exec(source);
    return match ? `${match[1]}/${match[2]}` : DEFAULT_GITHUB_CONFIG.repository;
}

function parseRepository(value) {
    const repository = normalizeRepository(value);
    const match = /^([^/]+)\/([^/]+)$/.exec(repository);
    if (!match) throw new RangeError('GitHub 仓库必须是 owner/repository 格式');
    return { repository, owner: match[1], name: match[2] };
}

function normalizeBranch(value) {
    const branch = String(value || DEFAULT_GITHUB_CONFIG.branch).trim();
    if (!branch || branch.length > 200 || branch.startsWith('-') || branch.includes('..') || /[\u0000-\u001F~^:?*\\[\\]\\\\]/.test(branch)) {
        return DEFAULT_GITHUB_CONFIG.branch;
    }
    return branch;
}

function normalizeDirectory(value) {
    const directory = String(value || DEFAULT_GITHUB_CONFIG.directory).trim()
        .replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!directory || directory.split('/').some(part => !part || part === '.' || part === '..')) {
        return DEFAULT_GITHUB_CONFIG.directory;
    }
    return directory.split('/').map(part => safePart(part, 'data')).join('/');
}

function normalizeGithubConfig(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        repository: normalizeRepository(source.repository || source.repo),
        branch: normalizeBranch(source.branch),
        directory: normalizeDirectory(source.directory),
        autoUploadStimulated: source.autoUploadStimulated !== false,
    };
}

function validateGithubConfig(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const config = normalizeGithubConfig(value);
    const errors = [];
    const rawRepository = String(source.repository || source.repo || '').trim()
        .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '');
    if (!/^[-a-zA-Z0-9_.]+\/[-a-zA-Z0-9_.]+$/.test(rawRepository)) {
        errors.push('GitHub 仓库必须是 owner/repository 格式');
    }
    const rawBranch = String(source.branch || DEFAULT_GITHUB_CONFIG.branch).trim();
    if (!rawBranch || rawBranch.length > 200 || rawBranch.startsWith('-') || rawBranch.includes('..') || /[\u0000-\u001F~^:?*\[\]\\]/.test(rawBranch)) {
        errors.push('GitHub 分支名无效');
    }
    const rawDirectory = String(source.directory || DEFAULT_GITHUB_CONFIG.directory).trim().replace(/\\/g, '/');
    if (!rawDirectory || rawDirectory.split('/').some(part => !part || part === '.' || part === '..')) {
        errors.push('GitHub 数据目录无效');
    }
    if (!config.repository || !config.directory) errors.push('GitHub 存档配置不能为空');
    return errors;
}

function redactGithubConfig(value = {}) {
    const config = normalizeGithubConfig(value);
    return { ...config };
}

function sessionDatePart(session = {}) {
    const source = String(session.startedAt || '').trim();
    const isoDate = /^(\d{4}-\d{2}-\d{2})/.exec(source)?.[1];
    if (isoDate) return isoDate;
    const parsed = Date.parse(source);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
    return 'undated';
}

function buildEdfArchivePath(session = {}, config = DEFAULT_GITHUB_CONFIG) {
    const normalized = normalizeGithubConfig(config);
    const sessionId = safePart(session.id, 'session');
    return `${normalized.directory}/${sessionDatePart(session)}/${sessionId}.edf`;
}

function buildSessionArchivePaths(session = {}, config = DEFAULT_GITHUB_CONFIG) {
    const normalized = normalizeGithubConfig(config);
    const sessionId = safePart(session.id, 'session');
    const directory = `${normalized.directory}/${sessionDatePart(session)}`;
    return {
        edf: `${directory}/${sessionId}.edf`,
        events: `${directory}/${sessionId}.events.jsonl`,
    };
}

function isStimulationEvent(event = {}) {
    const action = String(event.action || '');
    return action === 'light_started'
        || action === 'sleep_stimulus_triggered'
        || action === 'sleep_stimulus_shadow_triggered';
}

function hasStimulationEvents(events = []) {
    return Array.isArray(events) && events.some(isStimulationEvent);
}

function isPhysicalStimulationEvent(event = {}) {
    return String(event.action || '') === 'light_started';
}

function hasPhysicalStimulationEvents(events = []) {
    return Array.isArray(events) && events.some(isPhysicalStimulationEvent);
}

function contentApiPath(repository, archivePath) {
    const { owner, name } = parseRepository(repository);
    const encodedPath = String(archivePath || '').split('/').map(encodeURIComponent).join('/');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}`;
}

function normalizeUploadStatus(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const files = Array.isArray(source.files) ? source.files.map(file => ({
        kind: file?.kind === 'events' ? 'events' : 'edf',
        path: file?.path ? String(file.path).slice(0, 500) : null,
        fileUrl: file?.fileUrl ? String(file.fileUrl).slice(0, 1000) : null,
        bytes: Number.isFinite(Number(file?.bytes)) ? Number(file.bytes) : null,
    })).filter(file => file.path) : null;
    return {
        status: String(source.status || 'not_configured'),
        repository: source.repository ? normalizeRepository(source.repository) : null,
        path: source.path ? String(source.path).slice(0, 500) : null,
        files,
        eventsExpected: source.eventsExpected === true,
        eventsMissing: source.eventsMissing === true,
        branch: source.branch ? normalizeBranch(source.branch) : null,
        queuedAt: source.queuedAt || null,
        startedAt: source.startedAt || null,
        completedAt: source.completedAt || null,
        attempts: Number.isFinite(Number(source.attempts)) ? Number(source.attempts) : 0,
        commitUrl: source.commitUrl ? String(source.commitUrl).slice(0, 1000) : null,
        fileUrl: source.fileUrl ? String(source.fileUrl).slice(0, 1000) : null,
        error: source.error ? String(source.error).slice(0, 300) : null,
    };
}

module.exports = {
    DEFAULT_GITHUB_CONFIG,
    MAX_CONTENT_API_BYTES,
    safePart,
    normalizeRepository,
    parseRepository,
    normalizeGithubConfig,
    validateGithubConfig,
    redactGithubConfig,
    buildEdfArchivePath,
    buildSessionArchivePaths,
    isStimulationEvent,
    hasStimulationEvents,
    isPhysicalStimulationEvent,
    hasPhysicalStimulationEvents,
    contentApiPath,
    normalizeUploadStatus,
};
