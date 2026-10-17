// @ts-check
'use strict';

const path = require('path');
const { ArchiveCatalog } = require('./archiveCatalog');
const { Common } = require('./common');
const { Crc32 } = require('./crc32');
const { OperationAborted } = require('./operationAborted');
const { TarReader } = require('./tarReader');
const { I18n } = require('./i18n');

/**
 * @typedef {object} ArchiveProblem
 * @property {string} name     entry inside the archive, or the archive itself
 * @property {string} problem
 */

/**
 * @typedef {object} TestProgress
 * @property {'testing'} phase
 * @property {string} currentName
 * @property {number} done
 * @property {number} total
 * @property {number} doneFiles
 * @property {number} totalFiles
 */

/**
 * Reads a whole archive without writing anything. In a zip every file is checked against its stored CRC-32 and
 * size, and a damaged file does not stop the check of the others; a tar.gz is checked by the CRC and length of
 * gzip and the header checksums of tar, and the first damage ends the check, since nothing after it can be read.
 */
class ArchiveTester {
    #archivePath;
    #onProgress;
    #cancellation;
    /** @type {ArchiveProblem[]} */
    #problems = [];
    /** @type {TestProgress} */
    #progress = { phase: 'testing', currentName: '', done: 0, total: 0, doneFiles: 0, totalFiles: 0 };

    /**
     * @param {object} options
     * @param {string} options.archivePath
     * @param {(progress: TestProgress) => void} options.onProgress
     * @param {{ cancelled: boolean }} options.cancellation
     */
    constructor({ archivePath, onProgress, cancellation }) {
        this.#archivePath = archivePath;
        this.#onProgress = onProgress;
        this.#cancellation = cancellation;
    }

    /**
     * @returns {Promise<{ checked: number, problems: ArchiveProblem[] }>}  throws OperationAborted when cancelled
     */
    async run() {
        try {
            if (ArchiveCatalog.formatOf(this.#archivePath) === 'zip') {
                await this.#testZip();
            } else {
                await this.#testTar();
            }
        } catch (error) {
            if (error instanceof OperationAborted) {
                throw error;
            }
            this.#problems.push({ name: path.basename(this.#archivePath), problem: Common.errorMessage(error) });
        }
        return { checked: this.#progress.doneFiles, problems: this.#problems };
    }

    async #testZip() {
        await ArchiveCatalog.forEachZipEntry(this.#archivePath, async (entry) => {
            this.#progress.totalFiles++;
            this.#progress.total += entry.uncompressedSize;
        });
        await ArchiveCatalog.forEachZipEntry(this.#archivePath, async (entry, name, zipFile) => {
            this.#throwIfCancelled();
            this.#progress.currentName = name;
            if (name.endsWith('/')) {
                this.#progress.doneFiles++;
                return;
            }
            const startDone = this.#progress.done;
            try {
                if (entry.isEncrypted()) {
                    throw new Error(I18n.t('error.encryptedTest'));
                }
                const crc = new Crc32();
                for await (const chunk of await zipFile.openReadStreamPromise(entry)) {
                    this.#throwIfCancelled();
                    crc.update(chunk);
                    this.#progress.done += chunk.length;
                    this.#report();
                }
                if (crc.value !== entry.crc32 >>> 0) {
                    throw new Error(I18n.t('error.crcMismatch'));
                }
            } catch (error) {
                if (error instanceof OperationAborted) {
                    throw error;
                }
                this.#problems.push({ name, problem: Common.errorMessage(error) });
                this.#progress.done = startDone + entry.uncompressedSize;
            }
            this.#progress.doneFiles++;
            this.#report();
        });
    }

    async #testTar() {
        await TarReader.read(this.#archivePath, async (entry) => {
            this.#progress.currentName = entry.path;
            for await (const chunk of entry) {
                this.#throwIfCancelled();
                void chunk;
            }
            this.#progress.doneFiles++;
            this.#progress.totalFiles++;
        }, this.#cancellation, (bytesRead, totalBytes) => {
            this.#progress.done = bytesRead;
            this.#progress.total = totalBytes;
            this.#report();
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

module.exports.ArchiveTester = ArchiveTester;
