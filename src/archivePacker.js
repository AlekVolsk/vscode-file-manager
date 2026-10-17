// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const tar = require('tar');
const yazl = require('yazl');
const { ArchiveTester } = require('./archiveTester');
const { OperationAborted } = require('./operationAborted');
const { I18n } = require('./i18n');

/**
 * @typedef {object} PackItem
 * @property {string} absolutePath
 * @property {string} entryName   '/'-separated, relative to the source folder
 * @property {boolean} isDir
 * @property {boolean} isLink
 * @property {number} size
 * @property {Date} mtime
 * @property {number} mode
 */

/**
 * @typedef {object} PackProgress
 * @property {'scanning' | 'packing' | 'verifying'} phase
 * @property {string} currentName
 * @property {number} done
 * @property {number} total
 * @property {number} doneFiles
 * @property {number} totalFiles
 */

/**
 * Packs chosen entries of one folder into a new zip, tar or tar.gz, then reads the result back the way Test does.
 * A pack that fails, is cancelled or does not pass the check leaves no archive behind. Zip has no links; they are
 * skipped and counted, while tar keeps them as links.
 */
class ArchivePacker {
    #sourceDir;
    #names;
    #target;
    #format;
    #onProgress;
    #cancellation;
    /** @type {PackItem[]} */
    #items = [];
    /** @type {PackProgress} */
    #progress = { phase: 'scanning', currentName: '', done: 0, total: 0, doneFiles: 0, totalFiles: 0 };
    /** @type {import('./copyOperation').OperationSummary} */
    #summary = { done: 0, skipped: 0, failed: 0, metadataWarnings: 0, cancelled: false };

    /**
     * @param {object} options
     * @param {string} options.sourceDir
     * @param {string[]} options.names
     * @param {string} options.target  a new file; must not exist
     * @param {import('./archiveCatalog').ArchiveFormat} options.format
     * @param {(progress: PackProgress) => void} options.onProgress
     * @param {{ cancelled: boolean }} options.cancellation
     */
    constructor({ sourceDir, names, target, format, onProgress, cancellation }) {
        this.#sourceDir = sourceDir;
        this.#names = names;
        this.#target = target;
        this.#format = format;
        this.#onProgress = onProgress;
        this.#cancellation = cancellation;
    }

    /**
     * @returns {Promise<import('./copyOperation').OperationSummary>}
     */
    async run() {
        let created = false;
        try {
            for (const name of this.#names) {
                await this.#scan(path.join(this.#sourceDir, name));
            }
            this.#progress.phase = 'packing';
            this.#report();
            created = true;
            if (this.#format === 'zip') {
                await this.#writeZip();
            } else {
                await this.#writeTar();
            }
            await this.#verify();
        } catch (error) {
            if (created) {
                await fs.promises.unlink(this.#target).catch(() => undefined);
            }
            if (!(error instanceof OperationAborted)) {
                throw error;
            }
            this.#summary.cancelled = true;
        }
        return this.#summary;
    }

    /**
     * @param {string} absolutePath
     */
    async #scan(absolutePath) {
        this.#throwIfCancelled();
        const stats = await fs.promises.lstat(absolutePath);
        const entryName = path.relative(this.#sourceDir, absolutePath).split(path.sep).join('/');
        this.#items.push({
            absolutePath,
            entryName,
            isDir: stats.isDirectory(),
            isLink: stats.isSymbolicLink(),
            size: stats.isFile() ? stats.size : 0,
            mtime: stats.mtime,
            mode: stats.mode & 0o7777,
        });
        this.#progress.totalFiles++;
        this.#progress.total += stats.isFile() ? 2 * stats.size : 0;
        if (!stats.isDirectory()) {
            return;
        }
        this.#progress.currentName = absolutePath;
        this.#report();
        for (const child of await fs.promises.readdir(absolutePath)) {
            await this.#scan(path.join(absolutePath, child));
        }
    }

    async #writeZip() {
        const zip = new yazl.ZipFile();
        const output = fs.createWriteStream(this.#target, { flags: 'wx' });
        const written = ArchivePacker.#finished(zip.outputStream, output);
        zip.on('error', (error) => zip.outputStream.emit('error', error));
        zip.outputStream.pipe(output);
        for (const item of this.#items) {
            if (item.isLink) {
                this.#summary.skipped++;
                this.#progress.doneFiles++;
                continue;
            }
            if (item.isDir) {
                zip.addEmptyDirectory(item.entryName, { mtime: item.mtime, mode: item.mode });
                this.#countPacked(item);
                continue;
            }
            const options = { mtime: item.mtime, mode: item.mode, compress: true };
            zip.addReadStreamLazy(item.entryName, options, (callback) => {
                const input = fs.createReadStream(item.absolutePath);
                const counted = this.#counting(item);
                input.on('error', (error) => counted.destroy(error));
                counted.on('error', (error) => zip.outputStream.emit('error', error));
                callback(null, input.pipe(counted));
            });
        }
        zip.end();
        await written;
    }

    async #writeTar() {
        const pack = tar.c({
            gzip: this.#format === 'tgz',
            cwd: this.#sourceDir,
            portable: true,
            filter: (entryPath, stats) => {
                if (this.#cancellation.cancelled) {
                    pack.destroy(new OperationAborted());
                    return false;
                }
                const size = stats instanceof fs.Stats && stats.isFile() ? stats.size : 0;
                this.#progress.currentName = entryPath;
                this.#progress.done += size;
                this.#progress.doneFiles++;
                this.#summary.done++;
                this.#report();
                return true;
            },
        }, this.#names);
        const output = fs.createWriteStream(this.#target, { flags: 'wx' });
        const written = ArchivePacker.#finished(pack, output);
        pack.pipe(output);
        await written;
    }

    /**
     * Reads the new archive back; a damaged one is removed by the caller.
     */
    async #verify() {
        this.#progress.phase = 'verifying';
        const packedBytes = this.#progress.total / 2;
        const tester = new ArchiveTester({
            archivePath: this.#target,
            cancellation: this.#cancellation,
            onProgress: (progress) => {
                this.#progress.currentName = progress.currentName;
                const share = progress.total > 0 ? progress.done / progress.total : 0;
                this.#progress.done = packedBytes + packedBytes * share;
                this.#report();
            },
        });
        const { problems } = await tester.run();
        if (problems.length > 0) {
            const first = problems[0];
            throw new Error(I18n.t('error.packCheckFailed', { name: first.name, problem: first.problem }));
        }
    }

    /**
     * @param {PackItem} item
     * @returns {Transform}
     */
    #counting(item) {
        return new Transform({
            transform: (chunk, _encoding, callback) => {
                if (this.#cancellation.cancelled) {
                    callback(new OperationAborted());
                    return;
                }
                this.#progress.currentName = item.entryName;
                this.#progress.done += chunk.length;
                this.#report();
                callback(null, chunk);
            },
            flush: (callback) => {
                this.#countPacked(item, 0);
                callback();
            },
        });
    }

    /**
     * @param {PackItem} item
     * @param {number} [bytes]
     */
    #countPacked(item, bytes = item.size) {
        this.#progress.done += bytes;
        this.#progress.doneFiles++;
        this.#summary.done++;
        this.#report();
    }

    /**
     * @param {{ on(event: 'error', listener: (error: unknown) => void): unknown }} source
     * @param {fs.WriteStream} output
     * @returns {Promise<void>}
     */
    static #finished(source, output) {
        return new Promise((resolve, reject) => {
            const fail = (/** @type {unknown} */ error) => {
                output.destroy();
                reject(error);
            };
            source.on('error', fail);
            output.on('error', fail);
            output.on('close', () => resolve());
        });
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

module.exports.ArchivePacker = ArchivePacker;
