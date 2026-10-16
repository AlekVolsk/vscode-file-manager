// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { Common } = require('./common');
const { OperationAborted } = require('./operationAborted');
const { Platform } = require('./platform');
const { RetryPrompt } = require('./retryPrompt');

/** @typedef {import('./copyOperation').OperationQuestion} OperationQuestion */
/** @typedef {import('./copyOperation').OperationAnswer} OperationAnswer */

/**
 * @typedef {object} DeleteProgress
 * @property {'scanning' | 'deleting'} phase
 * @property {string} currentName
 * @property {number} doneFiles   entries deleted so far, files and folders
 * @property {number} totalFiles
 */

/**
 * Deletes chosen entries, to the trash or for good. An entry that cannot be deleted is asked about: retry, skip,
 * skip all or abort.
 */
class DeleteOperation {
    static #PARALLEL_REMOVALS = 16;

    #paths;
    #toTrash;
    #onProgress;
    #cancellation;
    #retry;
    #totalEntries = 0;
    #removedEntries = 0;

    /**
     * @param {object} options
     * @param {string[]} options.paths
     * @param {boolean} options.toTrash
     * @param {(question: OperationQuestion) => Promise<OperationAnswer>} options.ask
     * @param {(progress: DeleteProgress) => void} options.onProgress
     * @param {{ cancelled: boolean }} options.cancellation
     */
    constructor({ paths, toTrash, ask, onProgress, cancellation }) {
        this.#paths = paths;
        this.#toTrash = toTrash;
        this.#retry = new RetryPrompt(ask);
        this.#onProgress = onProgress;
        this.#cancellation = cancellation;
    }

    /**
     * Whether this extension host can move files to the trash: only the local one; a remote host (WSL, SSH,
     * containers) has no trash VS Code can reach.
     * @returns {boolean}
     */
    static get trashAvailable() {
        return vscode.env.remoteName === undefined;
    }

    /**
     * @returns {Promise<import('./copyOperation').OperationSummary>}
     */
    async run() {
        /** @type {import('./copyOperation').OperationSummary} */
        const summary = { done: 0, skipped: 0, failed: 0, metadataWarnings: 0, cancelled: false };
        try {
            if (!this.#toTrash) {
                this.#report('scanning', '');
                for (const entryPath of this.#paths) {
                    await this.#countEntries(entryPath);
                }
            } else {
                this.#totalEntries = this.#paths.length;
            }
            for (const entryPath of this.#paths) {
                this.#throwIfCancelled();
                const removed = this.#toTrash
                    ? await this.#moveToTrash(entryPath)
                    : await this.#removeTree(entryPath);
                if (removed) {
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
     * The trash takes a whole entry in one call, so progress goes by the chosen entries.
     * @param {string} entryPath
     * @returns {Promise<boolean>}
     */
    async #moveToTrash(entryPath) {
        const name = path.basename(entryPath);
        this.#report('deleting', name);
        const moved = await this.#retry.attempt(name, async () => {
            await vscode.workspace.fs.delete(vscode.Uri.file(entryPath), { recursive: true, useTrash: true });
        });
        this.#removedEntries++;
        return moved;
    }

    /**
     * Deletes for good, entry by entry, so a big folder shows its progress. A folder is removed after its content;
     * when something inside was skipped, the folder stays without a second question.
     * @param {string} entryPath
     * @returns {Promise<boolean>}
     */
    async #removeTree(entryPath) {
        this.#throwIfCancelled();
        const name = path.basename(entryPath);
        /** @type {fs.Stats | null} */
        let stats = null;
        const statted = await this.#retry.attempt(name, async () => {
            stats = await fs.promises.lstat(entryPath);
        });
        if (!statted || stats === null) {
            return false;
        }
        if (!(/** @type {fs.Stats} */ (stats)).isDirectory()) {
            return this.#removeLeaf(entryPath);
        }
        /** @type {fs.Dirent[]} */
        let children = [];
        const listed = await this.#retry.attempt(name, async () => {
            children = await fs.promises.readdir(entryPath, { withFileTypes: true });
        });
        if (!listed) {
            return false;
        }
        const folders = children.filter((child) => child.isDirectory());
        const leaves = children.filter((child) => !child.isDirectory());
        const leafResults = await Common.mapLimited(
            leaves,
            DeleteOperation.#PARALLEL_REMOVALS,
            (leaf) => this.#removeLeaf(path.join(entryPath, leaf.name)),
        );
        let complete = leafResults.every((removed) => removed);
        for (const folder of folders) {
            const removed = await this.#removeTree(path.join(entryPath, folder.name));
            complete = complete && removed;
        }
        if (!complete) {
            return false;
        }
        this.#report('deleting', name);
        const removed = await this.#retry.attempt(name, () => fs.promises.rmdir(entryPath));
        this.#removedEntries++;
        return removed;
    }

    /**
     * @param {string} entryPath
     * @returns {Promise<boolean>}
     */
    async #removeLeaf(entryPath) {
        this.#throwIfCancelled();
        const name = path.basename(entryPath);
        this.#report('deleting', name);
        const removed = await this.#retry.attempt(name, () => DeleteOperation.#unlink(entryPath));
        this.#removedEntries++;
        return removed;
    }

    /**
     * Windows refuses to delete a read-only file; it is made writable first, as Explorer does.
     * @param {string} entryPath
     */
    static async #unlink(entryPath) {
        try {
            await fs.promises.unlink(entryPath);
        } catch (error) {
            if (Platform.kind !== 'win' || Common.errorCode(error) !== 'EPERM') {
                throw error;
            }
            await fs.promises.chmod(entryPath, 0o666);
            await fs.promises.unlink(entryPath);
        }
    }

    /**
     * Counts the entry and everything under it into the total as it goes, so the window shows the count growing.
     * @param {string} entryPath
     */
    async #countEntries(entryPath) {
        this.#throwIfCancelled();
        this.#totalEntries++;
        const stats = await fs.promises.lstat(entryPath).catch(() => null);
        if (!stats?.isDirectory()) {
            return;
        }
        this.#report('scanning', entryPath);
        const names = await fs.promises.readdir(entryPath).catch(() => []);
        for (const name of names) {
            await this.#countEntries(path.join(entryPath, name));
        }
    }

    /**
     * @param {'scanning' | 'deleting'} phase
     * @param {string} currentName
     */
    #report(phase, currentName) {
        this.#onProgress({
            phase,
            currentName,
            doneFiles: this.#removedEntries,
            totalFiles: this.#totalEntries,
        });
    }

    #throwIfCancelled() {
        if (this.#cancellation.cancelled) {
            throw new OperationAborted();
        }
    }
}

module.exports.DeleteOperation = DeleteOperation;
