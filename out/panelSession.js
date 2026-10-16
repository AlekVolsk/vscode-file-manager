// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { ArchiveCatalog } = require('./archiveCatalog');
const { Common } = require('./common');
const { Config } = require('./config');
const { DirectoryWatcher } = require('./directoryWatcher');
const { FolderSizeCounter } = require('./folderSizeCounter');
const { MountTable } = require('./mountTable');
const { Platform } = require('./platform');

/** @typedef {'left' | 'right'} Side */

/**
 * @typedef {object} OpenArchive
 * @property {string} file
 * @property {string[]} inner   folder inside the archive; [] is its root
 * @property {import('./archiveListing').ArchiveListing} listing
 * @property {string} stamp     size and mtime of the archive file when it was read
 */

/**
 * The host side of one panel: which folder it shows, reading it, keeping it live, counting folder sizes.
 * A folder inside an archive has an ordinary-looking path, "…/backup.zip/docs": a path that does not exist
 * on disk is looked up in the archive file it starts with, so ".." and the breadcrumbs work there unchanged.
 */
class PanelSession {
    #side;
    #reader;
    #post;
    #watcher;
    /** @type {string | null} */
    #path = null;
    /** @type {OpenArchive | null} */
    #archive = null;
    #lastListing = '';
    #navigation = 0;
    /** @type {string[]} */
    #sizeQueue = [];
    /** @type {{ cancelled: boolean } | null} */
    #sizeCancellation = null;

    /**
     * @param {Side} side
     * @param {import('./directoryReader').DirectoryReader} reader
     * @param {(message: Record<string, unknown>) => void} post
     */
    constructor(side, reader, post) {
        this.#side = side;
        this.#reader = reader;
        this.#post = post;
        this.#watcher = new DirectoryWatcher(() => this.#refresh());
    }

    /**
     * @param {Side} side  the panel moved to the other side
     */
    set side(side) {
        this.#side = side;
    }

    /**
     * @returns {string | null}
     */
    get path() {
        return this.#path;
    }

    /**
     * Archives are only looked into; nothing is written inside them.
     * @returns {boolean}
     */
    get isInArchive() {
        return this.#archive !== null;
    }

    /**
     * Opens a folder, or a folder inside an archive. A path typed by hand may also be relative to the current
     * folder, start with ~, or name a file: then its folder opens with the cursor on it; an archive file opens as
     * a folder. On failure the panel stays where it was and gets the error.
     * @param {string} requestedPath
     * @param {string | null} focusName
     */
    async navigate(requestedPath, focusName) {
        const navigation = ++this.#navigation;
        const target = this.#resolve(requestedPath);
        try {
            const location = await this.#locate(target);
            if (location.archive) {
                await this.#enterArchive(navigation, location.archive.file, location.archive.inner, focusName);
                return;
            }
            const entries = await this.#reader.read(location.dir);
            if (navigation !== this.#navigation) {
                return;
            }
            this.#cancelSizes();
            this.#archive = null;
            this.#path = location.dir;
            this.#publish(entries, location.focusName ?? focusName, true);
            this.#watchCurrent();
        } catch (error) {
            if (navigation === this.#navigation) {
                this.#post({ type: 'error', side: this.#side, message: Common.errorMessage(error) });
            }
        }
    }

    /**
     * @param {string} target
     * @returns {Promise<{ dir: string, focusName?: string, archive?: undefined }
     *     | { archive: { file: string, inner: string[] }, dir?: undefined, focusName?: undefined }>}
     */
    async #locate(target) {
        if (target === '') {
            return { dir: '' };
        }
        try {
            const stats = await fs.promises.stat(target);
            if (stats.isDirectory()) {
                return { dir: target };
            }
            if (ArchiveCatalog.formatOf(target)) {
                return { archive: { file: target, inner: [] } };
            }
            return { dir: path.dirname(target), focusName: path.basename(target) };
        } catch (error) {
            const archive = await PanelSession.#archiveContaining(target);
            if (archive) {
                return { archive };
            }
            throw error;
        }
    }

    /**
     * The archive file a path that does not exist on disk starts with, and the rest of the path inside it.
     * @param {string} target
     * @returns {Promise<{ file: string, inner: string[] } | null>}
     */
    static async #archiveContaining(target) {
        let candidate = target;
        for (;;) {
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                return null;
            }
            candidate = parent;
            const stats = await fs.promises.stat(candidate).catch(() => null);
            if (!stats) {
                continue;
            }
            if (stats.isFile() && ArchiveCatalog.formatOf(candidate)) {
                return { file: candidate, inner: path.relative(candidate, target).split(path.sep) };
            }
            return null;
        }
    }

    /**
     * Reads the archive unless it is the one already open and unchanged, then shows the folder inside it.
     * @param {number} navigation
     * @param {string} file
     * @param {string[]} inner
     * @param {string | null} focusName
     */
    async #enterArchive(navigation, file, inner, focusName) {
        const stats = await fs.promises.stat(file);
        const stamp = `${stats.size}:${stats.mtimeMs}`;
        let listing = this.#archive?.file === file && this.#archive.stamp === stamp ? this.#archive.listing : null;
        if (!listing) {
            this.#post({ type: 'notice', side: this.#side, message: `Reading ${path.basename(file)}…` });
            listing = await ArchiveCatalog.read(file, { cancelled: false });
        }
        const entries = listing.entriesOf(inner);
        if (!entries) {
            throw new Error(`There is no ${inner.join('/')} in ${path.basename(file)}.`);
        }
        if (navigation !== this.#navigation) {
            return;
        }
        this.#cancelSizes();
        this.#archive = { file, inner, listing, stamp };
        this.#path = inner.length === 0 ? file : path.join(file, ...inner);
        this.#publish(entries, focusName, true);
        this.#watchCurrent();
    }

    /**
     * Opens the first folder of `candidates` that can be read, the home folder as the last resort.
     * @param {string[]} candidates
     */
    async navigateToFirstReadable(candidates) {
        for (const candidate of [...candidates, Platform.homeDirectory()]) {
            try {
                if (candidate !== '' && !(await fs.promises.stat(candidate)).isDirectory()) {
                    continue;
                }
                await this.#reader.read(candidate);
            } catch {
                continue;
            }
            await this.navigate(candidate, null);
            return;
        }
    }

    /**
     * @param {string[]} names  folders of the current listing, counted one after another
     */
    countFolderSizes(names) {
        const archive = this.#archive;
        if (archive) {
            for (const name of names) {
                const bytes = archive.listing.bytesUnder([...archive.inner, name]);
                const size = { bytes, files: 0, folders: 0, skippedFolders: 0, done: true };
                this.#post({ type: 'folderSize', side: this.#side, path: this.#path, name, ...size });
            }
            return;
        }
        const wasIdle = this.#sizeQueue.length === 0 && this.#sizeCancellation === null;
        this.#sizeQueue.push(...names.filter((name) => !this.#sizeQueue.includes(name)));
        if (wasIdle) {
            void this.#countQueuedSizes();
        }
    }

    /**
     * Re-reads the folder at once, after an operation, without waiting for the watcher or the next poll.
     */
    async refreshNow() {
        await this.#refresh();
    }

    cancelFolderSizes() {
        this.#cancelSizes();
    }

    dispose() {
        this.#navigation++;
        this.#cancelSizes();
        this.#watcher.stop();
    }

    async #refresh() {
        const dirPath = this.#path;
        if (dirPath === null) {
            return;
        }
        if (this.#archive) {
            await this.#refreshArchive(this.#archive);
            return;
        }
        const navigation = this.#navigation;
        const startedAt = Date.now();
        try {
            const entries = await this.#reader.read(dirPath);
            this.#watcher.reportReadDuration(Date.now() - startedAt);
            if (navigation === this.#navigation) {
                this.#publish(entries, null, false);
            }
        } catch (error) {
            if (navigation !== this.#navigation) {
                return;
            }
            const code = Common.errorCode(error);
            if (code === 'ENOENT' || code === 'ENOTDIR') {
                await this.#leaveVanishedFolder(dirPath);
            }
        }
    }

    /**
     * The folder of the archive file changed: when it is the archive file itself, its content is read again and the
     * panel stays in the same folder inside it, or the nearest one above that still exists.
     * @param {OpenArchive} archive
     */
    async #refreshArchive(archive) {
        const navigation = this.#navigation;
        const stats = await fs.promises.stat(archive.file).catch(() => null);
        if (!stats) {
            await this.#leaveVanishedFolder(archive.file);
            return;
        }
        const stamp = `${stats.size}:${stats.mtimeMs}`;
        if (stamp === archive.stamp) {
            return;
        }
        const listing = await ArchiveCatalog.read(archive.file, { cancelled: false }).catch(() => null);
        if (navigation !== this.#navigation) {
            return;
        }
        if (!listing) {
            await this.navigate(path.dirname(archive.file), path.basename(archive.file));
            return;
        }
        const inner = [...archive.inner];
        while (inner.length > 0 && !listing.entriesOf(inner)) {
            inner.pop();
        }
        const stayed = inner.length === archive.inner.length;
        this.#archive = { file: archive.file, inner, listing, stamp };
        this.#path = inner.length === 0 ? archive.file : path.join(archive.file, ...inner);
        this.#publish(/** @type {import('./directoryReader').Entry[]} */ (listing.entriesOf(inner)), null, !stayed);
    }

    /**
     * The open folder was deleted or renamed away: move up to the nearest folder that still exists.
     * @param {string} vanishedPath
     */
    async #leaveVanishedFolder(vanishedPath) {
        let candidate = Platform.parentOf(vanishedPath);
        while (candidate !== null && candidate !== '') {
            try {
                if ((await fs.promises.stat(candidate)).isDirectory()) {
                    break;
                }
            } catch {
                candidate = Platform.parentOf(candidate);
                continue;
            }
            candidate = Platform.parentOf(candidate);
        }
        await this.navigate(candidate ?? Platform.homeDirectory(), null);
    }

    /**
     * @param {import('./directoryReader').Entry[]} entries
     * @param {string | null} focusName
     * @param {boolean} isNewFolder
     */
    #publish(entries, focusName, isNewFolder) {
        const listing = JSON.stringify(entries);
        if (!isNewFolder && listing === this.#lastListing) {
            return;
        }
        this.#lastListing = listing;
        this.#post({
            type: 'listing',
            side: this.#side,
            path: this.#path,
            parent: this.#path === null ? null : Platform.parentOf(this.#path),
            entries,
            focusName,
            isNewFolder,
            archive: this.#archive !== null,
        });
    }

    #watchCurrent() {
        const dirPath = this.#archive ? path.dirname(this.#archive.file) : /** @type {string} */ (this.#path);
        if (dirPath === '') {
            this.#watcher.watch(dirPath, 'polling', Config.DRIVE_POLL_INTERVAL_MS);
            return;
        }
        this.#watcher.watch(dirPath, MountTable.requiresPolling(dirPath) ? 'polling' : 'events');
    }

    async #countQueuedSizes() {
        while (this.#sizeQueue.length > 0) {
            const name = /** @type {string} */ (this.#sizeQueue.shift());
            const dirPath = /** @type {string} */ (this.#path);
            const cancellation = { cancelled: false };
            this.#sizeCancellation = cancellation;
            /**
             * @param {import('./folderSizeCounter').FolderSize} size
             * @param {boolean} done
             */
            const report = (size, done) => {
                this.#post({ type: 'folderSize', side: this.#side, path: dirPath, name, ...size, done });
            };
            const total = await FolderSizeCounter.count(
                dirPath === '' ? `${name}\\` : path.join(dirPath, name),
                cancellation,
                (progress) => report(progress, false),
            );
            if (cancellation.cancelled || total === null) {
                return;
            }
            report(total, true);
        }
        this.#sizeCancellation = null;
    }

    #cancelSizes() {
        this.#sizeQueue = [];
        if (this.#sizeCancellation) {
            this.#sizeCancellation.cancelled = true;
            this.#sizeCancellation = null;
            this.#post({ type: 'folderSizesCancelled', side: this.#side });
        }
    }

    /**
     * @param {string} requestedPath
     * @returns {string}
     */
    #resolve(requestedPath) {
        const trimmed = requestedPath.trim();
        if (trimmed === '') {
            return Platform.kind === 'win' ? '' : '/';
        }
        if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
            return path.join(Platform.homeDirectory(), trimmed.slice(1));
        }
        if (Platform.kind === 'win' && /^[a-zA-Z]:$/.test(trimmed)) {
            return `${trimmed}\\`;
        }
        return path.resolve(this.#path || Platform.homeDirectory(), trimmed);
    }
}

module.exports.PanelSession = PanelSession;
