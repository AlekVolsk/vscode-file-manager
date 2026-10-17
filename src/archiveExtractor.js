// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { ArchiveCatalog } = require('./archiveCatalog');
const { Common } = require('./common');
const { Crc32 } = require('./crc32');
const { OperationAborted } = require('./operationAborted');
const { Platform } = require('./platform');
const { RetryPrompt } = require('./retryPrompt');
const { TarReader } = require('./tarReader');
const { I18n } = require('./i18n');

/** @typedef {import('./copyOperation').OperationQuestion} OperationQuestion */
/** @typedef {import('./copyOperation').OperationAnswer} OperationAnswer */

/**
 * @typedef {object} ExtractProgress
 * @property {'unpacking'} phase
 * @property {string} currentName
 * @property {number} done
 * @property {number} total
 * @property {number} doneFiles
 * @property {number} totalFiles
 */

/**
 * Unpacks a whole archive into a folder. Nothing lands outside it: entries with "..", absolute paths, names the
 * target file system does not accept, and links pointing out of the folder are refused and asked about.
 * A zip file is checked against the CRC-32 stored for it; a tar has no checksums of content, a tar.gz has the one
 * of gzip, checked at its end.
 */
class ArchiveExtractor {
    /** "version made by" high byte of a zip entry packed on Unix */
    static #MADE_ON_UNIX = 3;
    static #S_IFMT = 0o170000;
    static #S_IFLNK = 0o120000;

    #archivePath;
    #destination;
    #ask;
    #retry;
    #nameProblem;
    #onProgress;
    #cancellation;
    /** @type {'overwrite' | 'rename' | 'skip' | null} */
    #conflictForAll = null;
    /** @type {import('./copyOperation').OperationSummary} */
    #summary = { done: 0, skipped: 0, failed: 0, metadataWarnings: 0, cancelled: false };
    /** @type {ExtractProgress} */
    #progress = { phase: 'unpacking', currentName: '', done: 0, total: 0, doneFiles: 0, totalFiles: 0 };

    /**
     * @param {object} options
     * @param {string} options.archivePath
     * @param {string} options.destination  an existing folder
     * @param {(question: OperationQuestion) => Promise<OperationAnswer>} options.ask
     * @param {(name: string) => string | null} options.nameProblem
     * @param {(progress: ExtractProgress) => void} options.onProgress
     * @param {{ cancelled: boolean }} options.cancellation
     */
    constructor({ archivePath, destination, ask, nameProblem, onProgress, cancellation }) {
        this.#archivePath = archivePath;
        this.#destination = destination;
        this.#ask = ask;
        this.#retry = new RetryPrompt(ask);
        this.#nameProblem = nameProblem;
        this.#onProgress = onProgress;
        this.#cancellation = cancellation;
    }

    /**
     * @returns {Promise<import('./copyOperation').OperationSummary>}
     */
    async run() {
        try {
            if (ArchiveCatalog.formatOf(this.#archivePath) === 'zip') {
                await this.#unpackZip();
            } else {
                await this.#unpackTar();
            }
        } catch (error) {
            if (!(error instanceof OperationAborted)) {
                throw error;
            }
            this.#summary.cancelled = true;
        }
        return this.#summary;
    }

    async #unpackZip() {
        await ArchiveCatalog.forEachZipEntry(this.#archivePath, async (entry) => {
            this.#progress.totalFiles++;
            this.#progress.total += entry.uncompressedSize;
        });
        this.#report();
        await ArchiveCatalog.forEachZipEntry(this.#archivePath, async (entry, name, zipFile) => {
            this.#throwIfCancelled();
            const unixMode = (entry.versionMadeBy >> 8) === ArchiveExtractor.#MADE_ON_UNIX
                ? entry.externalFileAttributes >>> 16
                : 0;
            const kind = name.endsWith('/')
                ? 'dir'
                : ((unixMode & ArchiveExtractor.#S_IFMT) === ArchiveExtractor.#S_IFLNK ? 'link' : 'file');
            await this.#unpackEntry({
                name,
                kind,
                size: entry.uncompressedSize,
                mtime: entry.getLastModDate(),
                mode: unixMode & 0o777,
                encrypted: entry.isEncrypted(),
                open: async () => zipFile.openReadStreamPromise(entry),
                expectedCrc: entry.crc32,
            });
        });
    }

    async #unpackTar() {
        await TarReader.read(this.#archivePath, async (entry) => {
            this.#progress.totalFiles++;
            /** @type {'dir' | 'file' | 'link' | 'other'} */
            let kind = 'other';
            if (entry.type === 'Directory') {
                kind = 'dir';
            } else if (entry.type === 'File' || entry.type === 'OldFile' || entry.type === 'ContiguousFile') {
                kind = 'file';
            } else if (entry.type === 'SymbolicLink') {
                kind = 'link';
            }
            await this.#unpackEntry({
                name: entry.path,
                kind,
                size: entry.size,
                mtime: entry.mtime ?? new Date(),
                mode: (entry.mode ?? 0) & 0o777,
                encrypted: false,
                linkTarget: entry.linkpath,
                open: async () => entry,
                expectedCrc: null,
            });
            entry.resume();
        }, this.#cancellation, (bytesRead, totalBytes) => {
            this.#progress.done = bytesRead;
            this.#progress.total = totalBytes;
            this.#report();
        });
    }

    /**
     * @param {object} entry
     * @param {string} entry.name
     * @param {'dir' | 'file' | 'link' | 'other'} entry.kind
     * @param {number} entry.size
     * @param {Date} entry.mtime
     * @param {number} entry.mode
     * @param {boolean} entry.encrypted
     * @param {string} [entry.linkTarget]
     * @param {() => Promise<AsyncIterable<Buffer>>} entry.open
     * @param {number | null} entry.expectedCrc
     */
    async #unpackEntry(entry) {
        this.#progress.currentName = entry.name;
        const problem = this.#problemOf(entry);
        if (problem !== null) {
            await this.#retry.attempt(entry.name, async () => {
                throw new Error(problem);
            });
            this.#finish(entry, false);
            return;
        }
        const target = path.join(this.#destination, ...ArchiveExtractor.#segmentsOf(entry.name));
        if (entry.kind === 'dir') {
            const created = await this.#retry.attempt(entry.name, () => fs.promises.mkdir(target, { recursive: true }));
            this.#finish(entry, created);
            return;
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const finalPath = await this.#resolveConflict(target, entry);
        if (finalPath === null) {
            this.#skip(entry);
            return;
        }
        const written = await this.#retry.attempt(entry.name, () => (entry.kind === 'link'
            ? this.#writeLink(finalPath, entry)
            : this.#writeFile(finalPath, entry)));
        this.#finish(entry, written);
    }

    /**
     * Why an entry must not be unpacked, or null.
     * @param {{ name: string, kind: string, encrypted: boolean }} entry
     * @returns {string | null}
     */
    #problemOf(entry) {
        if (entry.encrypted) {
            return I18n.t('error.encryptedUnpack');
        }
        if (entry.kind === 'other') {
            return I18n.t('error.unsupportedEntry');
        }
        const segments = ArchiveExtractor.#segmentsOf(entry.name);
        if (/^([a-zA-Z]:)?[\\/]/.test(entry.name) || segments.includes('..') || segments.length === 0) {
            return I18n.t('error.pathLeaves');
        }
        for (const segment of segments) {
            const problem = this.#nameProblem(segment);
            if (problem !== null) {
                return problem;
            }
        }
        const inside = path.relative(this.#destination, path.join(this.#destination, ...segments));
        const leavesDestination = inside.startsWith('..') || path.isAbsolute(inside);
        return leavesDestination ? I18n.t('error.pathLeaves') : null;
    }

    /**
     * @param {string} name
     * @returns {string[]}
     */
    static #segmentsOf(name) {
        return name.split('/').filter((segment) => segment !== '' && segment !== '.');
    }

    /**
     * @param {string} target
     * @param {{ name: string, kind: string, size: number, mtime: Date }} entry
     * @returns {Promise<string | null>}
     */
    async #resolveConflict(target, entry) {
        const existing = await fs.promises.lstat(target).catch(() => null);
        if (!existing) {
            return target;
        }
        const canOverwrite = !existing.isDirectory();
        let action = this.#conflictForAll;
        if (action === null || (action === 'overwrite' && !canOverwrite)) {
            const answer = /** @type {{ action: 'overwrite' | 'rename' | 'skip' | 'cancel', forAll: boolean }} */ (
                await this.#ask({
                    kind: 'conflict',
                    name: path.basename(target),
                    target,
                    source: { isDir: false, size: entry.size, mtime: entry.mtime.getTime() },
                    existing: {
                        isDir: existing.isDirectory(),
                        size: existing.isFile() ? existing.size : 0,
                        mtime: existing.mtimeMs,
                    },
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
            return Common.freeName(target, false);
        }
        if (existing.isSymbolicLink()) {
            await fs.promises.unlink(target);
        }
        return target;
    }

    /**
     * @param {string} target
     * @param {{ name: string, size: number, mtime: Date, mode: number, open: () => Promise<AsyncIterable<Buffer>>,
     *     expectedCrc: number | null }} entry
     */
    async #writeFile(target, entry) {
        const startDone = this.#progress.done;
        const crc = new Crc32();
        const output = await fs.promises.open(target, 'w');
        try {
            for await (const chunk of await entry.open()) {
                this.#throwIfCancelled();
                crc.update(chunk);
                await output.write(chunk);
                if (entry.expectedCrc !== null) {
                    this.#progress.done += chunk.length;
                    this.#report();
                }
            }
        } catch (error) {
            await output.close();
            await fs.promises.unlink(target).catch(() => undefined);
            this.#progress.done = entry.expectedCrc !== null ? startDone : this.#progress.done;
            throw error;
        }
        await output.close();
        if (entry.expectedCrc !== null && crc.value !== entry.expectedCrc >>> 0) {
            await fs.promises.unlink(target).catch(() => undefined);
            throw new Error(I18n.t('error.unpackMismatch'));
        }
        await this.#preserveMetadata(target, entry);
    }

    /**
     * A link is created only when it points inside the destination folder.
     * @param {string} target
     * @param {{ linkTarget?: string, open: () => Promise<AsyncIterable<Buffer>> }} entry
     */
    async #writeLink(target, entry) {
        let linkTarget = entry.linkTarget;
        if (linkTarget === undefined) {
            const chunks = [];
            for await (const chunk of await entry.open()) {
                chunks.push(chunk);
            }
            linkTarget = Buffer.concat(chunks).toString('utf8');
        }
        const resolved = path.resolve(path.dirname(target), linkTarget);
        const inside = path.relative(this.#destination, resolved);
        if (path.isAbsolute(linkTarget) || inside.startsWith('..') || path.isAbsolute(inside)) {
            throw new Error(I18n.t('error.linkLeaves', { target: linkTarget }));
        }
        await fs.promises.symlink(linkTarget, target);
    }

    /**
     * @param {string} target
     * @param {{ mtime: Date, mode: number }} entry
     */
    async #preserveMetadata(target, entry) {
        try {
            await fs.promises.utimes(target, entry.mtime, entry.mtime);
            if (Platform.kind !== 'win' && entry.mode !== 0) {
                await fs.promises.chmod(target, entry.mode);
            }
        } catch {
            this.#summary.metadataWarnings++;
        }
    }

    /**
     * @param {{ size: number, expectedCrc: number | null }} entry
     */
    #skip(entry) {
        this.#summary.skipped++;
        this.#progress.doneFiles++;
        if (entry.expectedCrc !== null) {
            this.#progress.done += entry.size;
        }
        this.#report();
    }

    /**
     * @param {{ size: number }} entry
     * @param {boolean} succeeded
     */
    #finish(entry, succeeded) {
        if (succeeded) {
            this.#summary.done++;
        } else {
            this.#summary.failed++;
        }
        this.#progress.doneFiles++;
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

module.exports.ArchiveExtractor = ArchiveExtractor;
