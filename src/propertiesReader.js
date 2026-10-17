// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Platform } = require('./platform');
const { I18n } = require('./i18n');

/**
 * @typedef {object} EntryProperties
 * @property {string} name
 * @property {string} location
 * @property {'folder' | 'file' | 'link' | 'other'} kind
 * @property {string | null} linkTarget
 * @property {boolean} linkBroken
 * @property {'folder' | 'file' | 'other' | null} linkTargetKind
 * @property {number | null} size        bytes of a file; for a folder its content is counted separately
 * @property {number | null} birthtime
 * @property {number} mtime
 * @property {number} atime
 * @property {number | null} ctime       POSIX change of metadata; Windows has no such time
 * @property {number | null} mode
 * @property {string | null} owner
 * @property {number | null} winAttributes
 */

/**
 * What the properties dialog shows of entries, read without walking into folders.
 */
class PropertiesReader {
    #windowsShell;

    /**
     * @param {import('./windowsShell').WindowsShell | null} windowsShell
     */
    constructor(windowsShell) {
        this.#windowsShell = windowsShell;
    }

    /**
     * @param {string} dir
     * @param {string[]} names
     * @returns {Promise<EntryProperties[]>}
     */
    async describe(dir, names) {
        const attributes = this.#windowsShell
            ? await this.#windowsShell.readAttributes(dir).catch(() => null)
            : null;
        return Promise.all(names.map((name) => this.#describeOne(dir, name, attributes)));
    }

    /**
     * @param {string} dir
     * @param {string} name
     * @param {Map<string, number> | null} attributes
     * @returns {Promise<EntryProperties>}
     */
    async #describeOne(dir, name, attributes) {
        const fullPath = path.join(dir, name);
        const stats = await fs.promises.lstat(fullPath);
        const isLink = stats.isSymbolicLink();
        /** @type {string | null} */
        let linkTarget = null;
        /** @type {'folder' | 'file' | 'other' | null} */
        let linkTargetKind = null;
        let linkBroken = false;
        if (isLink) {
            linkTarget = await fs.promises.readlink(fullPath).catch(() => null);
            const target = await fs.promises.stat(fullPath).catch(() => null);
            linkBroken = target === null;
            linkTargetKind = target ? PropertiesReader.#kindOf(target) : null;
        }
        const isWindows = Platform.kind === 'win';
        return {
            name,
            location: dir,
            kind: isLink ? 'link' : PropertiesReader.#kindOf(stats),
            linkTarget,
            linkBroken,
            linkTargetKind,
            size: stats.isFile() ? stats.size : null,
            birthtime: stats.birthtimeMs > 0 ? stats.birthtimeMs : null,
            mtime: stats.mtimeMs,
            atime: stats.atimeMs,
            ctime: isWindows ? null : stats.ctimeMs,
            mode: isWindows ? null : stats.mode,
            owner: isWindows ? null : PropertiesReader.#ownerOf(stats),
            winAttributes: attributes?.get(name) ?? null,
        };
    }

    /**
     * @param {fs.Stats} stats
     * @returns {'folder' | 'file' | 'other'}
     */
    static #kindOf(stats) {
        if (stats.isDirectory()) {
            return 'folder';
        }
        return stats.isFile() ? 'file' : 'other';
    }

    /**
     * Node knows the name of the current user only; others are shown by their numbers.
     * @param {fs.Stats} stats
     * @returns {string}
     */
    static #ownerOf(stats) {
        const user = os.userInfo();
        const owner = stats.uid === user.uid ? `${user.username} (${stats.uid})` : String(stats.uid);
        return I18n.t('properties.ownerGroup', { owner, group: stats.gid });
    }
}

module.exports.PropertiesReader = PropertiesReader;
