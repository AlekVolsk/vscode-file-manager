// @ts-check
'use strict';

const fs = require('fs');
const { Config } = require('./config');
const { Platform } = require('./platform');

class MountTable {
    /**
     * Whether changes in `dirPath` have to be found by polling: the file system does not report them to a watcher.
     * Read from /proc/mounts on every call, since shares come and go.
     * @param {string} dirPath
     * @returns {boolean}
     */
    static requiresPolling(dirPath) {
        if (Platform.kind === 'win') {
            return dirPath.startsWith('\\\\');
        }
        if (Platform.kind !== 'linux') {
            return false;
        }
        const fileSystem = MountTable.#fileSystemOf(dirPath);
        return Config.POLLED_FILE_SYSTEMS.has(fileSystem) || fileSystem.startsWith('fuse.');
    }

    /**
     * @param {string} dirPath
     * @returns {string}
     */
    static #fileSystemOf(dirPath) {
        let mounts;
        try {
            mounts = fs.readFileSync('/proc/mounts', 'utf8');
        } catch {
            return '';
        }
        let bestMountPoint = '';
        let bestFileSystem = '';
        for (const line of mounts.split('\n')) {
            const fields = line.split(' ');
            if (fields.length < 3) {
                continue;
            }
            const mountPoint = MountTable.#unescapeMountField(fields[1]);
            const covers = mountPoint === '/'
                || dirPath === mountPoint
                || dirPath.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`);
            if (covers && mountPoint.length >= bestMountPoint.length) {
                bestMountPoint = mountPoint;
                bestFileSystem = fields[2];
            }
        }
        return bestFileSystem;
    }

    /**
     * /proc/mounts writes space, tab, newline and backslash as three-digit octal escapes.
     * @param {string} field
     * @returns {string}
     */
    static #unescapeMountField(field) {
        return field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    }
}

module.exports.MountTable = MountTable;
