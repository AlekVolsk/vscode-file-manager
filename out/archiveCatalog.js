// @ts-check
'use strict';

const yauzl = require('yauzl');
const { ArchiveListing } = require('./archiveListing');
const { TarReader } = require('./tarReader');
const { ZipNames } = require('./zipNames');

/** @typedef {'zip' | 'tar' | 'tgz'} ArchiveFormat */

/**
 * Which files are archives the panels can enter, and reading the content of one.
 */
class ArchiveCatalog {
    static #S_IFMT = 0o170000;
    static #S_IFLNK = 0o120000;
    /** "version made by" high byte of a zip entry packed on Unix: its external attributes hold a POSIX mode */
    static #MADE_ON_UNIX = 3;

    /**
     * @param {string} name
     * @returns {ArchiveFormat | null}
     */
    static formatOf(name) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.zip')) {
            return 'zip';
        }
        if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
            return 'tgz';
        }
        return lower.endsWith('.tar') ? 'tar' : null;
    }

    /**
     * @param {string} archivePath
     * @param {{ cancelled: boolean }} cancellation
     * @returns {Promise<ArchiveListing>}
     */
    static async read(archivePath, cancellation) {
        const listing = new ArchiveListing();
        if (ArchiveCatalog.formatOf(archivePath) === 'zip') {
            await ArchiveCatalog.forEachZipEntry(archivePath, async (entry, name) => {
                listing.add(ArchiveCatalog.#zipItem(entry, name));
            });
            return listing;
        }
        await TarReader.read(archivePath, async (entry) => {
            listing.add({
                path: entry.path,
                isDir: entry.type === 'Directory',
                isLink: entry.type === 'SymbolicLink',
                size: entry.size,
                mtime: entry.mtime ? entry.mtime.getTime() : null,
                mode: entry.mode ?? null,
            });
            entry.resume();
        }, cancellation);
        return listing;
    }

    /**
     * Walks the entries of a zip one at a time; the zip stays open until the walk ends, so `onEntry` may read the
     * entry's data with `zipFile.openReadStream`.
     * @param {string} archivePath
     * @param {(entry: import('yauzl').Entry, name: string, zipFile: import('yauzl').ZipFile) => Promise<void>} onEntry
     * @returns {Promise<void>}
     */
    static async forEachZipEntry(archivePath, onEntry) {
        const zipFile = await yauzl.openPromise(archivePath, { lazyEntries: true, autoClose: false });
        try {
            await new Promise((resolve, reject) => {
                zipFile.on('entry', (/** @type {import('yauzl').Entry} */ entry) => {
                    onEntry(entry, ZipNames.decode(entry), zipFile).then(() => zipFile.readEntry(), reject);
                });
                zipFile.on('end', resolve);
                zipFile.on('error', reject);
                zipFile.readEntry();
            });
        } finally {
            zipFile.close();
        }
    }

    /**
     * @param {import('yauzl').Entry} entry
     * @param {string} name
     * @returns {import('./archiveListing').ArchiveItem}
     */
    static #zipItem(entry, name) {
        const unixMode = (entry.versionMadeBy >> 8) === ArchiveCatalog.#MADE_ON_UNIX
            ? (entry.externalFileAttributes >>> 16)
            : 0;
        return {
            path: name,
            isDir: name.endsWith('/'),
            isLink: unixMode !== 0 && (unixMode & ArchiveCatalog.#S_IFMT) === ArchiveCatalog.#S_IFLNK,
            size: entry.uncompressedSize,
            mtime: entry.getLastModDate().getTime(),
            mode: unixMode !== 0 ? unixMode : null,
        };
    }
}

module.exports.ArchiveCatalog = ArchiveCatalog;
