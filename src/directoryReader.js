// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { Common } = require('./common');
const { Config } = require('./config');
const { Platform } = require('./platform');

/**
 * @typedef {object} Entry
 * @property {string} name
 * @property {boolean} isDir        a folder, a link to a folder or a drive
 * @property {boolean} isLink
 * @property {boolean} isBrokenLink
 * @property {number | null} size   bytes; for a drive its capacity
 * @property {number | null} mtime  ms since epoch
 * @property {number | null} birthtime  null where the file system does not keep it
 * @property {number | null} atime
 * @property {number | null} mode   POSIX mode bits; null on Windows
 * @property {number | null} winAttributes  System.IO.FileAttributes bits; null outside Windows
 * @property {boolean} hidden
 * @property {DriveDetails | null} drive
 */

/**
 * @typedef {object} DriveDetails
 * @property {string} label
 * @property {string} type
 * @property {boolean} ready
 * @property {number | null} free
 */

class DirectoryReader {
    #windowsShell;

    /**
     * @param {import('./windowsShell').WindowsShell | null} windowsShell  required on Windows
     */
    constructor(windowsShell) {
        this.#windowsShell = windowsShell;
    }

    /**
     * Entries of a folder, or the drive list for '' on Windows. Throws when the folder cannot be read.
     * @param {string} dirPath
     * @returns {Promise<Entry[]>}
     */
    async read(dirPath) {
        if (dirPath === '' && this.#windowsShell) {
            return this.#readDrives(this.#windowsShell);
        }
        const [dirents, winAttributes] = await Promise.all([
            fs.promises.readdir(dirPath, { withFileTypes: true }),
            this.#windowsShell ? this.#windowsShell.readAttributes(dirPath).catch(() => null) : null,
        ]);
        const entries = await Common.mapLimited(
            dirents,
            Config.STAT_CONCURRENCY,
            (dirent) => this.#readEntry(dirPath, dirent.name, winAttributes),
        );
        return entries.filter((entry) => entry !== null);
    }

    /**
     * @param {string} dirPath
     * @param {string} name
     * @param {Map<string, number> | null} winAttributesByName
     * @returns {Promise<Entry | null>}
     */
    async #readEntry(dirPath, name, winAttributesByName) {
        const fullPath = path.join(dirPath, name);
        let linkStats;
        try {
            linkStats = await fs.promises.lstat(fullPath);
        } catch (error) {
            return Common.errorCode(error) === 'ENOENT' ? null : DirectoryReader.#unreadableEntry(name);
        }
        const isLink = linkStats.isSymbolicLink();
        let stats = linkStats;
        let isBrokenLink = false;
        if (isLink) {
            try {
                stats = await fs.promises.stat(fullPath);
            } catch {
                isBrokenLink = true;
            }
        }
        const winAttributes = winAttributesByName?.get(name) ?? null;
        const isDir = stats.isDirectory();
        return {
            name,
            isDir,
            isLink,
            isBrokenLink,
            size: isDir ? null : stats.size,
            mtime: stats.mtimeMs,
            birthtime: stats.birthtimeMs > 0 ? stats.birthtimeMs : null,
            atime: stats.atimeMs,
            mode: Platform.kind === 'win' ? null : linkStats.mode,
            winAttributes,
            hidden: winAttributes === null
                ? name.startsWith('.')
                : (winAttributes & Config.WINDOWS_ATTRIBUTE_HIDDEN) !== 0,
            drive: null,
        };
    }

    /**
     * @param {import('./windowsShell').WindowsShell} windowsShell
     * @returns {Promise<Entry[]>}
     */
    async #readDrives(windowsShell) {
        const drives = await windowsShell.readDrives();
        return drives.map((drive) => ({
            name: drive.name,
            isDir: true,
            isLink: false,
            isBrokenLink: false,
            size: drive.total,
            mtime: null,
            birthtime: null,
            atime: null,
            mode: null,
            winAttributes: null,
            hidden: false,
            drive: { label: drive.label, type: drive.type, ready: drive.ready, free: drive.free },
        }));
    }

    /**
     * An entry listed by readdir whose stat is refused: shown by name, without details.
     * @param {string} name
     * @returns {Entry}
     */
    static #unreadableEntry(name) {
        return {
            name,
            isDir: false,
            isLink: false,
            isBrokenLink: false,
            size: null,
            mtime: null,
            birthtime: null,
            atime: null,
            mode: null,
            winAttributes: null,
            hidden: name.startsWith('.'),
            drive: null,
        };
    }
}

module.exports.DirectoryReader = DirectoryReader;
