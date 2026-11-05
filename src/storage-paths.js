'use strict';
const path = require('node:path');

function versionFamily(version) {
    const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(String(version));
    if (!match) throw new Error('Invalid application version');
    return `v${Number(match[1])}.${Number(match[2])}`;
}
function profilePath(appData, version) {
    return path.join(appData, `caocao-desktop-${versionFamily(version)}`);
}
function dataPaths(documents, version) {
    const root = path.join(documents, '曹操', versionFamily(version));
    return { root, plans: path.join(root, 'plans.json'), sessions: path.join(root, 'sessions'), logs: path.join(root, 'logs') };
}
module.exports = { versionFamily, profilePath, dataPaths };
