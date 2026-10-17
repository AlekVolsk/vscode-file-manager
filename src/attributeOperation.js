// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { OperationAborted } = require('./operationAborted');
const { RetryPrompt } = require('./retryPrompt');

/**
 * @typedef {object} BitChange
 * @property {number} set    bits to turn on
 * @property {number} clear  bits to turn off; bits in neither stay as each entry has them
 */

/**
 * @typedef {object} AttributeProgress
 * @property {'scanning' | 'applying'} phase
 * @property {string} currentName
 * @property {number} doneFiles
 * @property {number} totalFiles
 */

/**
 * Changes permissions (POSIX) or attributes (Windows) of the chosen entries, and with `recursive` of everything
 * inside chosen folders. Only the bits the user decided are touched, so entries with different permissions keep
 * their differences. Links are left alone: chmod would change what they point to, possibly outside the folder.
 */
class AttributeOperation {
    #paths;
    #posix;
    #windows;
    #recursive;
    #windowsShell;
    #retry;
    #onProgress;
    #cancellation;
    #total = 0;
    #done = 0;

    /**
     * @param {object} options
     * @param {string[]} options.paths
     * @param {BitChange | null} options.posix
     * @param {BitChange | null} options.windows
     * @param {boolean} options.recursive
     * @param {import('./windowsShell').WindowsShell | null} options.windowsShell
     * @param {RetryPrompt} options.retry
     * @param {(progress: AttributeProgress) => void} options.onProgress
     * @param {{ cancelled: boolean }} options.cancellation
     */
    constructor({ paths, posix, windows, recursive, windowsShell, retry, onProgress, cancellation }) {
        this.#paths = paths;
        this.#posix = posix;
        this.#windows = windows;
        this.#recursive = recursive;
        this.#windowsShell = windowsShell;
        this.#retry = retry;
        this.#onProgress = onProgress;
        this.#cancellation = cancellation;
    }

    /**
     * @returns {Promise<import('./copyOperation').OperationSummary>}
     */
    async run() {
        /** @type {import('./copyOperation').OperationSummary} */
        const summary = { done: 0, skipped: 0, failed: 0, metadataWarnings: 0, cancelled: false };
        try {
            this.#report('scanning', '');
            for (const entryPath of this.#paths) {
                await this.#count(entryPath);
            }
            for (const entryPath of this.#paths) {
                if (await this.#applyTree(entryPath)) {
                    summary.done++;
                } else {
                    summary.failed++;
                }
            }
        } catch (error) {
            if (!(error instanceof OperationAborted)) {
                throw error;
            }
            summary.cancelled = true;
        }
        return summary;
    }

    /**
     * @param {string} entryPath
     */
    async #count(entryPath) {
        this.#throwIfCancelled();
        this.#total++;
        if (!this.#recursive) {
            return;
        }
        const stats = await fs.promises.lstat(entryPath).catch(() => null);
        if (!stats?.isDirectory()) {
            return;
        }
        this.#report('scanning', entryPath);
        const names = await fs.promises.readdir(entryPath).catch(() => []);
        for (const name of names) {
            await this.#count(path.join(entryPath, name));
        }
    }

    /**
     * @param {string} entryPath
     * @returns {Promise<boolean>}  false when this entry or something inside it was skipped
     */
    async #applyTree(entryPath) {
        this.#throwIfCancelled();
        const name = path.basename(entryPath);
        this.#report('applying', name);
        /** @type {fs.Stats | null} */
        let stats = null;
        const statted = await this.#retry.attempt(name, async () => {
            stats = await fs.promises.lstat(entryPath);
        });
        if (!statted || stats === null) {
            this.#done++;
            return false;
        }
        const entryStats = /** @type {fs.Stats} */ (stats);
        let complete = entryStats.isSymbolicLink()
            || await this.#retry.attempt(name, () => this.#apply(entryPath, entryStats));
        this.#done++;
        if (this.#recursive && entryStats.isDirectory()) {
            /** @type {string[]} */
            let names = [];
            const listed = await this.#retry.attempt(name, async () => {
                names = await fs.promises.readdir(entryPath);
            });
            complete = complete && listed;
            for (const child of names) {
                const childComplete = await this.#applyTree(path.join(entryPath, child));
                complete = complete && childComplete;
            }
        }
        return complete;
    }

    /**
     * @param {string} entryPath
     * @param {fs.Stats} stats
     */
    async #apply(entryPath, stats) {
        if (this.#windows && this.#windowsShell) {
            await this.#windowsShell.changeAttributes(entryPath, this.#windows.set, this.#windows.clear);
            return;
        }
        if (this.#posix) {
            const current = stats.mode & 0o7777;
            const wanted = (current & ~this.#posix.clear) | this.#posix.set;
            if (wanted !== current) {
                await fs.promises.chmod(entryPath, wanted);
            }
        }
    }

    /**
     * @param {'scanning' | 'applying'} phase
     * @param {string} currentName
     */
    #report(phase, currentName) {
        this.#onProgress({ phase, currentName, doneFiles: this.#done, totalFiles: this.#total });
    }

    #throwIfCancelled() {
        if (this.#cancellation.cancelled) {
            throw new OperationAborted();
        }
    }
}

module.exports.AttributeOperation = AttributeOperation;
