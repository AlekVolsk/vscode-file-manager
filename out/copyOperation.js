// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { Common } = require('./common');
const { FileHasher } = require('./fileHasher');
const { OperationAborted } = require('./operationAborted');
const { Platform } = require('./platform');

/**
 * @typedef {object} CopyItem
 * @property {string} source
 * @property {string} target
 */

/**
 * @typedef {object} EntryFacts
 * @property {boolean} isDir
 * @property {number} size
 * @property {number} mtime
 */

/**
 * @typedef {{ kind: 'conflict', name: string, target: string, source: EntryFacts, existing: EntryFacts,
 *     canOverwrite: boolean }
 *     | { kind: 'error', name: string, message: string }} OperationQuestion
 */

/**
 * @typedef {{ action: 'overwrite' | 'rename' | 'skip' | 'cancel', forAll: boolean }
 *     | { action: 'retry' | 'skip' | 'skipAll' | 'abort' }} OperationAnswer
 */

/**
 * @typedef {object} CopyProgress
 * @property {'scanning' | 'copying' | 'verifying' | 'moving'} phase
 * @property {string} currentName
 * @property {number} currentDone   bytes of the current file, copy and check together
 * @property {number} currentTotal
 * @property {number} done          bytes of the whole operation, copy and check together
 * @property {number} total
 * @property {number} doneFiles
 * @property {number} totalFiles
 */

/**
 * @typedef {object} OperationSummary
 * @property {number} done
 * @property {number} skipped
 * @property {number} failed
 * @property {number} metadataWarnings  copies whose dates or permissions could not be set
 * @property {boolean} cancelled
 * @property {{ name: string, problem: string }[]} [problems]  damaged entries found by Test
 * @property {number} [tested]  archives checked by Test
 */

/**
 * Copies or moves files and folders. Every copied file is read back and compared with the checksum taken while it
 * was copied; a move deletes a source file only after its copy has passed that check, and a source folder only
 * when everything in it has been moved. A move inside one volume is a rename and copies nothing.
 */
class CopyOperation {
    static #CHUNK_BYTES = 1_048_576;

    #items;
    #move;
    #ask;
    #onProgress;
    #cancellation;
    /** @type {Map<string, number>} */
    #folderBytes = new Map();
    /** @type {'overwrite' | 'rename' | 'skip' | null} */
    #conflictForAll = null;
    #skipAllErrors = false;
    /** @type {OperationSummary} */
    #summary = { done: 0, skipped: 0, failed: 0, metadataWarnings: 0, cancelled: false };
    /** @type {CopyProgress} */
    #progress = {
        phase: 'scanning',
        currentName: '',
        currentDone: 0,
        currentTotal: 0,
        done: 0,
        total: 0,
        doneFiles: 0,
        totalFiles: 0,
    };

    /**
     * @param {object} options
     * @param {CopyItem[]} options.items
     * @param {boolean} options.move
     * @param {(question: OperationQuestion) => Promise<OperationAnswer>} options.ask
     * @param {(progress: CopyProgress) => void} options.onProgress
     * @param {{ cancelled: boolean }} options.cancellation
     */
    constructor({ items, move, ask, onProgress, cancellation }) {
        this.#items = items;
        this.#move = move;
        this.#ask = ask;
        this.#onProgress = onProgress;
        this.#cancellation = cancellation;
    }

    /**
     * Pairs the chosen entries with their targets. A single entry may be given a new name by typing a path that is
     * not an existing folder; several entries always go into a folder, which is created when missing.
     * Throws with a message for the user when the request cannot be carried out.
     * @param {string} sourceDir
     * @param {string[]} names
     * @param {string} destination  as typed; relative to the source folder
     * @param {(name: string) => string | null} nameProblem
     * @returns {Promise<CopyItem[]>}
     */
    static async planItems(sourceDir, names, destination, nameProblem) {
        const resolved = path.resolve(sourceDir, destination.trim());
        const destinationStats = await fs.promises.stat(resolved).catch(() => null);
        /** @type {CopyItem[]} */
        let items;
        if (destinationStats?.isDirectory()) {
            items = names.map((name) => ({ source: path.join(sourceDir, name), target: path.join(resolved, name) }));
        } else if (destinationStats) {
            if (names.length > 1) {
                throw new Error(`${resolved} is a file; several items can only go into a folder.`);
            }
            items = [{ source: path.join(sourceDir, names[0]), target: resolved }];
        } else if (names.length === 1) {
            const problem = nameProblem(path.basename(resolved));
            if (problem) {
                throw new Error(problem);
            }
            const parentStats = await fs.promises.stat(path.dirname(resolved)).catch(() => null);
            if (!parentStats?.isDirectory()) {
                throw new Error(`Folder ${path.dirname(resolved)} does not exist.`);
            }
            items = [{ source: path.join(sourceDir, names[0]), target: resolved }];
        } else {
            await fs.promises.mkdir(resolved, { recursive: true });
            items = names.map((name) => ({ source: path.join(sourceDir, name), target: path.join(resolved, name) }));
        }
        for (const item of items) {
            const inside = path.relative(item.source, item.target);
            if (inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)) {
                throw new Error(`Cannot put ${path.basename(item.source)} inside itself.`);
            }
        }
        return items;
    }

    /**
     * @returns {Promise<OperationSummary>}
     */
    async run() {
        try {
            await this.#scan();
            for (const item of this.#items) {
                await this.#transferEntry(item.source, item.target);
            }
        } catch (error) {
            if (!(error instanceof OperationAborted)) {
                throw error;
            }
            this.#summary.cancelled = true;
        }
        return this.#summary;
    }

    async #scan() {
        this.#report();
        for (const item of this.#items) {
            await this.#scanEntry(item.source);
        }
        this.#progress.currentName = '';
        this.#report();
    }

    /**
     * Adds what is found to the totals as it goes, so the window shows the count growing.
     * @param {string} entryPath
     */
    async #scanEntry(entryPath) {
        this.#throwIfCancelled();
        const stats = await fs.promises.lstat(entryPath).catch(() => null);
        if (!stats?.isDirectory()) {
            this.#progress.totalFiles++;
            this.#progress.total += stats?.isFile() ? 2 * stats.size : 0;
            return;
        }
        this.#progress.currentName = entryPath;
        this.#report();
        const totalBefore = this.#progress.total;
        const names = await fs.promises.readdir(entryPath).catch(() => []);
        for (const name of names) {
            await this.#scanEntry(path.join(entryPath, name));
        }
        this.#folderBytes.set(entryPath, (this.#progress.total - totalBefore) / 2);
        this.#report();
    }

    /**
     * @param {string} source
     * @param {string} target
     * @returns {Promise<boolean>}  true when the entry with everything in it arrived
     */
    async #transferEntry(source, target) {
        this.#throwIfCancelled();
        const name = path.basename(source);
        const stats = await this.#guard(name, () => fs.promises.lstat(source));
        if (!stats) {
            return false;
        }
        return stats.isDirectory()
            ? this.#transferFolder(source, target, stats)
            : this.#transferLeaf(source, target, stats);
    }

    /**
     * @param {string} source
     * @param {string} target
     * @param {fs.Stats} stats
     * @returns {Promise<boolean>}
     */
    async #transferFolder(source, target, stats) {
        const name = path.basename(source);
        const resolution = await this.#resolveTarget(source, target, stats);
        if (resolution === null) {
            this.#summary.skipped++;
            this.#advance(2 * (this.#folderBytes.get(source) ?? 0));
            return false;
        }
        const finalTarget = resolution.target;
        const targetExists = resolution.exists;
        if (this.#move && !targetExists) {
            const renamed = await this.#guard(name, () => this.#tryRename(source, finalTarget));
            if (renamed === null) {
                return false;
            }
            if (renamed) {
                this.#summary.done++;
                this.#advance(2 * (this.#folderBytes.get(source) ?? 0));
                return true;
            }
        }
        if (!targetExists) {
            const created = await this.#guard(name, () => fs.promises.mkdir(finalTarget));
            if (created === null) {
                return false;
            }
        }
        const children = await this.#guard(name, () => fs.promises.readdir(source));
        if (children === null) {
            return false;
        }
        let complete = true;
        for (const child of children) {
            const arrived = await this.#transferEntry(path.join(source, child), path.join(finalTarget, child));
            complete = complete && arrived;
        }
        if (!targetExists) {
            await this.#preserveMetadata(finalTarget, stats);
        }
        if (this.#move && complete) {
            const removed = await this.#guard(name, () => fs.promises.rmdir(source));
            complete = removed !== null;
        }
        return complete;
    }

    /**
     * A file, a link or another non-folder entry.
     * @param {string} source
     * @param {string} target
     * @param {fs.Stats} stats
     * @returns {Promise<boolean>}
     */
    async #transferLeaf(source, target, stats) {
        const name = path.basename(source);
        const size = stats.isFile() ? stats.size : 0;
        const resolution = await this.#resolveTarget(source, target, stats);
        if (resolution === null) {
            this.#summary.skipped++;
            this.#progress.doneFiles++;
            this.#advance(2 * size);
            return false;
        }
        const finalTarget = resolution.target;
        if (this.#move) {
            const renamed = await this.#guard(name, () => this.#tryRename(source, finalTarget));
            if (renamed === null) {
                this.#progress.doneFiles++;
                return false;
            }
            if (renamed) {
                this.#finishFile(size);
                return true;
            }
        }
        const copied = await this.#guard(name, async () => {
            if (!stats.isFile() && !stats.isSymbolicLink()) {
                throw new Error(`${name} is not a regular file, folder or link.`);
            }
            if (resolution.existingIsLink) {
                await fs.promises.unlink(finalTarget);
            }
            return stats.isSymbolicLink()
                ? this.#copyLink(source, finalTarget, resolution.exists && !resolution.existingIsLink)
                : this.#copyFileVerified(source, finalTarget, stats);
        });
        if (copied === null) {
            this.#progress.doneFiles++;
            return false;
        }
        if (this.#move) {
            const removed = await this.#guard(name, () => fs.promises.unlink(source));
            if (removed === null) {
                this.#progress.doneFiles++;
                return false;
            }
        }
        this.#progress.doneFiles++;
        this.#summary.done++;
        this.#report();
        return true;
    }

    /**
     * @param {number} size
     */
    #finishFile(size) {
        this.#summary.done++;
        this.#progress.doneFiles++;
        this.#advance(2 * size);
    }

    /**
     * Where the entry goes when the target name is taken: the user overwrites, renames, skips or cancels.
     * A folder going onto a folder merges into it. Overwriting is not offered when it would destroy the source
     * itself or put a file in place of a folder.
     * @param {string} source
     * @param {string} target
     * @param {fs.Stats} sourceStats
     * @returns {Promise<{ target: string, exists: boolean, existingIsLink: boolean } | null>}  null to skip
     */
    async #resolveTarget(source, target, sourceStats) {
        const existing = await fs.promises.lstat(target).catch(() => null);
        if (!existing) {
            return { target, exists: false, existingIsLink: false };
        }
        const sameEntry = path.resolve(source) === path.resolve(target)
            || (existing.ino !== 0 && existing.ino === sourceStats.ino && existing.dev === sourceStats.dev);
        if (this.#move && sameEntry) {
            return null;
        }
        if (sourceStats.isDirectory() && existing.isDirectory() && !sameEntry) {
            return { target, exists: true, existingIsLink: false };
        }
        const canOverwrite = !sameEntry && !sourceStats.isDirectory() && !existing.isDirectory();
        let action = this.#conflictForAll;
        if (action === null || (action === 'overwrite' && !canOverwrite)) {
            const answer = /** @type {{ action: 'overwrite' | 'rename' | 'skip' | 'cancel', forAll: boolean }} */ (
                await this.#ask({
                    kind: 'conflict',
                    name: path.basename(target),
                    target,
                    source: CopyOperation.#facts(sourceStats),
                    existing: CopyOperation.#facts(existing),
                    canOverwrite,
                })
            );
            if (answer.action === 'cancel') {
                throw new OperationAborted();
            }
            action = answer.action;
            if (answer.forAll) {
                this.#conflictForAll = action;
            }
        }
        if (action === 'skip') {
            return null;
        }
        if (action === 'rename') {
            const freeTarget = await Common.freeName(target, sourceStats.isDirectory());
            return { target: freeTarget, exists: false, existingIsLink: false };
        }
        return { target, exists: true, existingIsLink: existing.isSymbolicLink() };
    }

    /**
     * A move by rename; false when source and target are on different volumes and the entry has to be copied.
     * @param {string} source
     * @param {string} target
     * @returns {Promise<boolean>}
     */
    async #tryRename(source, target) {
        this.#progress.phase = 'moving';
        this.#progress.currentName = path.basename(source);
        try {
            await fs.promises.rename(source, target);
            return true;
        } catch (error) {
            const code = Common.errorCode(error);
            if (code === 'EXDEV' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') {
                return false;
            }
            throw error;
        }
    }

    /**
     * @param {string} source
     * @param {string} target
     * @param {boolean} replace
     */
    async #copyLink(source, target, replace) {
        const linkTarget = await fs.promises.readlink(source);
        if (replace) {
            await fs.promises.unlink(target);
        }
        const pointsToFolder = await fs.promises.stat(source).then((stats) => stats.isDirectory(), () => false);
        await fs.promises.symlink(linkTarget, target, pointsToFolder ? 'dir' : 'file');
    }

    /**
     * Copies the file while hashing what was read, then reads the copy back and compares. Whatever goes wrong,
     * a half-written copy is removed before the error goes on.
     * @param {string} source
     * @param {string} target
     * @param {fs.Stats} stats
     */
    async #copyFileVerified(source, target, stats) {
        const name = path.basename(source);
        const startDone = this.#progress.done;
        this.#progress.currentName = name;
        this.#progress.currentDone = 0;
        this.#progress.currentTotal = 2 * stats.size;
        try {
            this.#progress.phase = 'copying';
            const sourceHash = await this.#copyContent(source, target);
            this.#progress.phase = 'verifying';
            const targetHash = await this.#hashFile(target);
            if (sourceHash !== targetHash) {
                throw new Error(`The copy of ${name} differs from the original (${FileHasher.algorithm} mismatch).`);
            }
        } catch (error) {
            this.#progress.done = startDone;
            await fs.promises.unlink(target).catch(() => undefined);
            throw error;
        }
        await this.#preserveMetadata(target, stats);
    }

    /**
     * @param {string} source
     * @param {string} target
     * @returns {Promise<string>}  checksum of what was read
     */
    async #copyContent(source, target) {
        const hasher = new FileHasher();
        const buffer = Buffer.allocUnsafe(CopyOperation.#CHUNK_BYTES);
        const input = await fs.promises.open(source, 'r');
        try {
            const output = await fs.promises.open(target, 'w');
            try {
                for (;;) {
                    this.#throwIfCancelled();
                    const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
                    if (bytesRead === 0) {
                        break;
                    }
                    const chunk = buffer.subarray(0, bytesRead);
                    hasher.update(chunk);
                    await output.write(chunk);
                    this.#advanceCurrent(bytesRead);
                }
            } finally {
                await output.close();
            }
        } finally {
            await input.close();
        }
        return hasher.digest();
    }

    /**
     * @param {string} filePath
     * @returns {Promise<string>}
     */
    async #hashFile(filePath) {
        const hasher = new FileHasher();
        const buffer = Buffer.allocUnsafe(CopyOperation.#CHUNK_BYTES);
        const input = await fs.promises.open(filePath, 'r');
        try {
            for (;;) {
                this.#throwIfCancelled();
                const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
                if (bytesRead === 0) {
                    break;
                }
                hasher.update(buffer.subarray(0, bytesRead));
                this.#advanceCurrent(bytesRead);
            }
        } finally {
            await input.close();
        }
        return hasher.digest();
    }

    /**
     * Dates and permissions of the source. Some file systems refuse them (Windows drives under WSL mounted without
     * metadata); the copy is still complete, and the summary counts it.
     * @param {string} target
     * @param {fs.Stats} stats
     */
    async #preserveMetadata(target, stats) {
        try {
            await fs.promises.utimes(target, stats.atime, stats.mtime);
            if (Platform.kind !== 'win') {
                await fs.promises.chmod(target, stats.mode & 0o7777);
            }
        } catch {
            this.#summary.metadataWarnings++;
        }
    }

    /**
     * Runs `action` until it succeeds or the user skips or aborts it.
     * @template T
     * @param {string} name
     * @param {() => Promise<T>} action
     * @returns {Promise<T | null>}  null when skipped
     */
    async #guard(name, action) {
        for (;;) {
            try {
                const result = await action();
                return result === undefined ? /** @type {T} */ (/** @type {unknown} */ (true)) : result;
            } catch (error) {
                if (error instanceof OperationAborted) {
                    throw error;
                }
                this.#summary.failed++;
                if (this.#skipAllErrors) {
                    return null;
                }
                const answer = await this.#ask({ kind: 'error', name, message: Common.errorMessage(error) });
                if (answer.action === 'abort') {
                    throw new OperationAborted();
                }
                if (answer.action === 'retry') {
                    this.#summary.failed--;
                    continue;
                }
                if (answer.action === 'skipAll') {
                    this.#skipAllErrors = true;
                }
                return null;
            }
        }
    }

    /**
     * @param {fs.Stats} stats
     * @returns {EntryFacts}
     */
    static #facts(stats) {
        return { isDir: stats.isDirectory(), size: stats.isFile() ? stats.size : 0, mtime: stats.mtimeMs };
    }

    /**
     * @param {number} bytes
     */
    #advance(bytes) {
        this.#progress.done += bytes;
        this.#report();
    }

    /**
     * @param {number} bytes
     */
    #advanceCurrent(bytes) {
        this.#progress.currentDone += bytes;
        this.#progress.done += bytes;
        this.#report();
    }

    #report() {
        this.#onProgress({ ...this.#progress });
    }

    #throwIfCancelled() {
        if (this.#cancellation.cancelled) {
            throw new OperationAborted();
        }
    }
}

module.exports.CopyOperation = CopyOperation;
