// @ts-check
'use strict';

/**
 * @typedef {object} ArchiveItem
 * @property {string} path      inside the archive, '/'-separated
 * @property {boolean} isDir
 * @property {boolean} isLink
 * @property {number} size
 * @property {number | null} mtime
 * @property {number | null} mode
 */

/**
 * The content of one archive as folders of entries, read once when the panel enters it. Folders that the archive
 * only implies by its paths are listed too. Paths with ".." or an absolute start are left out: they could not be
 * unpacked safely and are not shown as if they could.
 */
class ArchiveListing {
    /** @type {Map<string, Map<string, import('./directoryReader').Entry>>} */
    #folders = new Map([['', new Map()]]);
    /** @type {Map<string, number>} */
    #bytesUnder = new Map([['', 0]]);

    /**
     * @param {ArchiveItem} item
     */
    add(item) {
        if (/^([a-zA-Z]:)?[\\/]/.test(item.path)) {
            return;
        }
        const segments = item.path.split('/').filter((segment) => segment !== '' && segment !== '.');
        if (segments.length === 0 || segments.includes('..')) {
            return;
        }
        for (let depth = 0; depth < segments.length - 1; depth++) {
            this.#ensureFolder(segments.slice(0, depth + 1), null);
        }
        if (item.isDir) {
            this.#ensureFolder(segments, item.mtime);
            return;
        }
        const parent = segments.slice(0, -1).join('/');
        const name = segments[segments.length - 1];
        /** @type {Map<string, import('./directoryReader').Entry>} */ (this.#folders.get(parent)).set(name, {
            name,
            isDir: false,
            isLink: item.isLink,
            isBrokenLink: false,
            size: item.size,
            mtime: item.mtime,
            birthtime: null,
            atime: null,
            mode: item.mode,
            winAttributes: null,
            hidden: name.startsWith('.'),
            drive: null,
        });
        for (let depth = 0; depth < segments.length; depth++) {
            const folder = segments.slice(0, depth).join('/');
            this.#bytesUnder.set(folder, (this.#bytesUnder.get(folder) ?? 0) + item.size);
        }
    }

    /**
     * @param {string[]} inner  folder inside the archive; [] is its root
     * @returns {import('./directoryReader').Entry[] | null}  null when there is no such folder
     */
    entriesOf(inner) {
        const folder = this.#folders.get(inner.join('/'));
        return folder ? [...folder.values()] : null;
    }

    /**
     * @param {string[]} inner
     * @returns {number}
     */
    bytesUnder(inner) {
        return this.#bytesUnder.get(inner.join('/')) ?? 0;
    }

    /**
     * @param {string[]} segments
     * @param {number | null} mtime
     */
    #ensureFolder(segments, mtime) {
        const key = segments.join('/');
        const parent = segments.slice(0, -1).join('/');
        const name = segments[segments.length - 1];
        if (!this.#folders.has(key)) {
            this.#folders.set(key, new Map());
            this.#bytesUnder.set(key, this.#bytesUnder.get(key) ?? 0);
        }
        const siblings = /** @type {Map<string, import('./directoryReader').Entry>} */ (this.#folders.get(parent));
        const existing = siblings.get(name);
        if (existing && existing.isDir) {
            existing.mtime = mtime ?? existing.mtime;
            return;
        }
        siblings.set(name, {
            name,
            isDir: true,
            isLink: false,
            isBrokenLink: false,
            size: null,
            mtime,
            birthtime: null,
            atime: null,
            mode: null,
            winAttributes: null,
            hidden: name.startsWith('.'),
            drive: null,
        });
    }
}

module.exports.ArchiveListing = ArchiveListing;
