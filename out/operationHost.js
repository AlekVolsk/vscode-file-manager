// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { Common } = require('./common');
const { Config } = require('./config');
const { ArchiveCatalog } = require('./archiveCatalog');
const { ArchiveExtractor } = require('./archiveExtractor');
const { ArchivePacker } = require('./archivePacker');
const { ArchiveTester } = require('./archiveTester');
const { AttributeOperation } = require('./attributeOperation');
const { CopyOperation } = require('./copyOperation');
const { DeleteOperation } = require('./deleteOperation');
const { FolderSizeCounter } = require('./folderSizeCounter');
const { NameValidator } = require('./nameValidator');
const { PropertiesReader } = require('./propertiesReader');
const { OperationAborted } = require('./operationAborted');
const { RetryPrompt } = require('./retryPrompt');

/** @typedef {import('./panelSession').Side} Side */
/** @typedef {import('./panelSession').PanelSession} PanelSession */

/**
 * File operations of one File Manager tab: creating, renaming, copying, moving, deleting. Requests come from the
 * webview, which never names a path itself — only entries of the folder a panel shows — so every path is built here.
 * One long operation runs at a time; its questions go to the webview and wait for the answer.
 */
class OperationHost {
    static #POSIX_BITS = 0o7777;
    /** ReadOnly 1, Hidden 2, System 4, Archive 32 */
    static #WINDOWS_BITS = 39;

    #post;
    #sessions;
    #windowsShell;
    /** @type {{ cancelled: boolean } | null} */
    #running = null;
    /** @type {Map<number, (answer: any) => void>} */
    #pendingQuestions = new Map();
    #nextQuestionId = 1;
    #lastProgressAt = 0;
    #propertiesReader;
    /** @type {Map<unknown, { cancelled: boolean }>} */
    #contentCounts = new Map();

    /**
     * @param {(message: Record<string, unknown>) => void} post
     * @param {() => Record<Side, PanelSession>} sessions
     * @param {import('./windowsShell').WindowsShell | null} windowsShell
     */
    constructor(post, sessions, windowsShell) {
        this.#post = post;
        this.#sessions = sessions;
        this.#windowsShell = windowsShell;
        this.#propertiesReader = new PropertiesReader(windowsShell);
    }

    /**
     * @param {any} message
     * @returns {boolean}  whether the message was an operation message
     */
    handle(message) {
        switch (message?.type) {
            case 'createEntry':
                void this.#reply(message.requestId, () => this.#create(message));
                return true;
            case 'renameEntry':
                void this.#reply(message.requestId, () => this.#rename(message));
                return true;
            case 'startCopy':
                void this.#reply(message.requestId, () => this.#startCopy(message));
                return true;
            case 'startDelete':
                void this.#reply(message.requestId, () => this.#startDelete(message));
                return true;
            case 'changeAttributes':
                void this.#reply(message.requestId, () => this.#startAttributes(message));
                return true;
            case 'startUnpack':
                void this.#reply(message.requestId, () => this.#startUnpack(message));
                return true;
            case 'startPack':
                void this.#reply(message.requestId, () => this.#startPack(message));
                return true;
            case 'startTest':
                void this.#reply(message.requestId, () => this.#startTest(message));
                return true;
            case 'properties':
                void this.#reply(message.requestId, () => this.#properties(message));
                return true;
            case 'cancelProperties': {
                const count = this.#contentCounts.get(message.requestId);
                if (count) {
                    count.cancelled = true;
                }
                this.#contentCounts.delete(message.requestId);
                return true;
            }
            case 'operationAnswer':
                this.#pendingQuestions.get(message.questionId)?.(message.answer);
                this.#pendingQuestions.delete(message.questionId);
                return true;
            case 'cancelOperation':
                this.#cancelRunning();
                return true;
        }
        return false;
    }

    dispose() {
        this.#cancelRunning();
        for (const count of this.#contentCounts.values()) {
            count.cancelled = true;
        }
        this.#contentCounts.clear();
    }

    /**
     * Properties of entries at once; the content of folders among them is counted afterwards and posted as it grows,
     * until the dialog closes.
     * @param {any} message
     * @returns {Promise<{ properties: import('./propertiesReader').EntryProperties[] }>}
     */
    async #properties(message) {
        const dir = this.#folderOf(message.side);
        const names = OperationHost.#requireEntryNames(message.names);
        const properties = await this.#propertiesReader.describe(dir, names);
        const folders = properties
            .filter((entry) => entry.kind === 'folder')
            .map((entry) => path.join(dir, entry.name));
        if (folders.length > 0) {
            const cancellation = { cancelled: false };
            this.#contentCounts.set(message.requestId, cancellation);
            setTimeout(() => void this.#countContent(message.requestId, folders, cancellation), 0);
        }
        return { properties };
    }

    /**
     * @param {unknown} requestId
     * @param {string[]} folders
     * @param {{ cancelled: boolean }} cancellation
     */
    async #countContent(requestId, folders, cancellation) {
        const total = { bytes: 0, files: 0, folders: 0, skippedFolders: 0 };
        for (const folder of folders) {
            const before = { ...total };
            const counted = await FolderSizeCounter.count(folder, cancellation, (progress) => {
                this.#post({
                    type: 'propertiesCount',
                    requestId,
                    bytes: before.bytes + progress.bytes,
                    files: before.files + progress.files,
                    folders: before.folders + progress.folders,
                    skippedFolders: before.skippedFolders + progress.skippedFolders,
                    done: false,
                });
            });
            if (counted === null) {
                return;
            }
            total.bytes += counted.bytes;
            total.files += counted.files;
            total.folders += counted.folders;
            total.skippedFolders += counted.skippedFolders;
        }
        this.#contentCounts.delete(requestId);
        this.#post({ type: 'propertiesCount', requestId, ...total, done: true });
    }

    /**
     * Runs a request and posts its result; an Error thrown inside becomes the message shown in the dialog.
     * @param {unknown} requestId
     * @param {() => Promise<Record<string, unknown>>} request
     */
    async #reply(requestId, request) {
        try {
            const result = await request();
            this.#post({ type: 'requestResult', requestId, ok: true, ...result });
        } catch (error) {
            this.#post({ type: 'requestResult', requestId, ok: false, error: Common.errorMessage(error) });
        }
    }

    /**
     * @param {any} message
     * @returns {Promise<{ focusName: string }>}
     */
    async #create(message) {
        const dir = this.#folderOf(message.side);
        const name = String(message.name ?? '');
        OperationHost.#requireValidName(name);
        const target = path.join(dir, name);
        try {
            if (message.kind === 'folder') {
                await fs.promises.mkdir(target);
            } else {
                await fs.promises.writeFile(target, '', { flag: 'wx' });
            }
        } catch (error) {
            throw OperationHost.#explain(error, name);
        }
        this.#refreshPanels();
        return { focusName: name };
    }

    /**
     * Renames inside the panel's folder. A change of letter case alone is allowed on file systems that ignore
     * case, where the new name is "taken" by the entry itself.
     * @param {any} message
     * @returns {Promise<{ focusName: string }>}
     */
    async #rename(message) {
        const dir = this.#folderOf(message.side);
        const oldName = OperationHost.#requireEntryName(message.oldName);
        const newName = String(message.newName ?? '');
        if (newName === oldName) {
            return { focusName: oldName };
        }
        OperationHost.#requireValidName(newName);
        const source = path.join(dir, oldName);
        const target = path.join(dir, newName);
        if (newName.toLowerCase() !== oldName.toLowerCase()) {
            const taken = await fs.promises.lstat(target).then(() => true, () => false);
            if (taken) {
                throw new Error(`"${newName}" already exists.`);
            }
        }
        try {
            await fs.promises.rename(source, target);
        } catch (error) {
            throw OperationHost.#explain(error, newName);
        }
        this.#refreshPanels();
        return { focusName: newName };
    }

    /**
     * Checks the request and starts the copy in the background; the dialog closes once the copy has started, and
     * its progress and questions arrive as separate messages.
     * @param {any} message
     * @returns {Promise<{}>}
     */
    async #startCopy(message) {
        this.#requireIdle();
        const dir = this.#folderOf(message.side);
        const names = OperationHost.#requireEntryNames(message.names);
        const move = message.move === true;
        const items = await CopyOperation.planItems(
            dir,
            names,
            String(message.destination ?? ''),
            (name) => NameValidator.problemOf(name),
        );
        const cancellation = { cancelled: false };
        const operation = new CopyOperation({
            items,
            move,
            ask: (question) => this.#ask(question),
            onProgress: (progress) => this.#reportProgress({ kind: move ? 'move' : 'copy', ...progress }),
            cancellation,
        });
        this.#runInBackground(move ? 'Move' : 'Copy', cancellation, () => operation.run());
        return {};
    }

    /**
     * @param {any} message
     * @returns {Promise<{}>}
     */
    async #startDelete(message) {
        this.#requireIdle();
        const dir = this.#folderOf(message.side);
        const names = OperationHost.#requireEntryNames(message.names);
        const toTrash = message.permanent !== true;
        if (toTrash && !DeleteOperation.trashAvailable) {
            throw new Error('There is no trash here; deleting would be permanent.');
        }
        const cancellation = { cancelled: false };
        const operation = new DeleteOperation({
            paths: names.map((name) => path.join(dir, name)),
            toTrash,
            ask: (question) => this.#ask(question),
            onProgress: (progress) => this.#reportProgress({ kind: 'delete', ...progress }),
            cancellation,
        });
        this.#runInBackground('Delete', cancellation, () => operation.run());
        return {};
    }

    /**
     * @param {any} message
     * @returns {Promise<{}>}
     */
    async #startAttributes(message) {
        this.#requireIdle();
        const dir = this.#folderOf(message.side);
        const names = OperationHost.#requireEntryNames(message.names);
        const allowedBits = this.#windowsShell ? OperationHost.#WINDOWS_BITS : OperationHost.#POSIX_BITS;
        const change = OperationHost.#requireBitChange(message.change, allowedBits);
        const windows = this.#windowsShell ? change : null;
        const posix = this.#windowsShell ? null : change;
        const cancellation = { cancelled: false };
        const operation = new AttributeOperation({
            paths: names.map((name) => path.join(dir, name)),
            posix,
            windows,
            recursive: message.recursive === true,
            windowsShell: this.#windowsShell,
            retry: new RetryPrompt((question) => this.#ask(question)),
            onProgress: (progress) => this.#reportProgress({ kind: 'attributes', ...progress }),
            cancellation,
        });
        this.#runInBackground('Attributes', cancellation, () => operation.run());
        return {};
    }

    /**
     * Unpacks whole archives into one folder, each into its own subfolder when asked.
     * @param {any} message
     * @returns {Promise<{}>}
     */
    async #startUnpack(message) {
        this.#requireIdle();
        const dir = this.#folderOf(message.side);
        const names = OperationHost.#requireArchiveNames(message.names);
        const destination = path.resolve(dir, String(message.destination ?? '').trim());
        const destinationStats = await fs.promises.stat(destination).catch(() => null);
        if (destinationStats && !destinationStats.isDirectory()) {
            throw new Error(`${destination} is a file, not a folder.`);
        }
        await fs.promises.mkdir(destination, { recursive: true });
        const cancellation = { cancelled: false };
        this.#runInBackground('Unpack', cancellation, async () => {
            const total = OperationHost.#emptySummary();
            for (const name of names) {
                const target = message.intoSubfolder === true
                    ? path.join(destination, OperationHost.#archiveBaseName(name))
                    : destination;
                await fs.promises.mkdir(target, { recursive: true });
                const summary = await new ArchiveExtractor({
                    archivePath: path.join(dir, name),
                    destination: target,
                    ask: (question) => this.#ask(question),
                    nameProblem: (entryName) => NameValidator.problemOf(entryName),
                    onProgress: (progress) => this.#reportProgress({ kind: 'unpack', ...progress }),
                    cancellation,
                }).run();
                OperationHost.#addSummary(total, summary);
                if (summary.cancelled) {
                    break;
                }
            }
            return total;
        });
        return {};
    }

    /**
     * Packs the chosen entries into a new archive; an existing file is never replaced.
     * @param {any} message
     * @returns {Promise<{}>}
     */
    async #startPack(message) {
        this.#requireIdle();
        const dir = this.#folderOf(message.side);
        const names = OperationHost.#requireEntryNames(message.names);
        const format = message.format;
        if (format !== 'zip' && format !== 'tgz' && format !== 'tar') {
            throw new Error('Unknown archive format.');
        }
        const target = path.resolve(dir, String(message.target ?? '').trim());
        OperationHost.#requireValidName(path.basename(target));
        const parentStats = await fs.promises.stat(path.dirname(target)).catch(() => null);
        if (!parentStats?.isDirectory()) {
            throw new Error(`Folder ${path.dirname(target)} does not exist.`);
        }
        if (await fs.promises.lstat(target).then(() => true, () => false)) {
            throw new Error(`${path.basename(target)} already exists.`);
        }
        for (const name of names) {
            const inside = path.relative(path.join(dir, name), target);
            if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
                throw new Error(`The archive cannot be created inside ${name}, which it packs.`);
            }
        }
        const cancellation = { cancelled: false };
        const packer = new ArchivePacker({
            sourceDir: dir,
            names,
            target,
            format,
            onProgress: (progress) => this.#reportProgress({ kind: 'pack', ...progress }),
            cancellation,
        });
        this.#runInBackground('Pack', cancellation, () => packer.run());
        return { focusName: path.basename(target) };
    }

    /**
     * Checks archives without writing anything; the summary lists every damaged entry.
     * @param {any} message
     * @returns {Promise<{}>}
     */
    async #startTest(message) {
        this.#requireIdle();
        const dir = this.#folderOf(message.side);
        const names = OperationHost.#requireArchiveNames(message.names);
        const cancellation = { cancelled: false };
        this.#runInBackground('Test', cancellation, async () => {
            const summary = OperationHost.#emptySummary();
            /** @type {import('./archiveTester').ArchiveProblem[]} */
            const problems = [];
            try {
                for (const name of names) {
                    const result = await new ArchiveTester({
                        archivePath: path.join(dir, name),
                        onProgress: (progress) => this.#reportProgress({ kind: 'test', ...progress }),
                        cancellation,
                    }).run();
                    summary.done += result.checked;
                    for (const problem of result.problems) {
                        problems.push({ name: `${name}: ${problem.name}`, problem: problem.problem });
                    }
                }
            } catch (error) {
                if (!(error instanceof OperationAborted)) {
                    throw error;
                }
                summary.cancelled = true;
            }
            summary.failed = problems.length;
            return { ...summary, problems, tested: names.length };
        });
        return {};
    }

    /**
     * "backup.tar.gz" → "backup".
     * @param {string} name
     * @returns {string}
     */
    static #archiveBaseName(name) {
        return name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '');
    }

    /**
     * @param {unknown} names
     * @returns {string[]}
     */
    static #requireArchiveNames(names) {
        const entryNames = OperationHost.#requireEntryNames(names);
        const notArchive = entryNames.find((name) => ArchiveCatalog.formatOf(name) === null);
        if (notArchive !== undefined) {
            throw new Error(`${notArchive} is not a zip, tar or tar.gz archive.`);
        }
        return entryNames;
    }

    /**
     * @returns {import('./copyOperation').OperationSummary}
     */
    static #emptySummary() {
        return { done: 0, skipped: 0, failed: 0, metadataWarnings: 0, cancelled: false };
    }

    /**
     * @param {import('./copyOperation').OperationSummary} total
     * @param {import('./copyOperation').OperationSummary} part
     */
    static #addSummary(total, part) {
        total.done += part.done;
        total.skipped += part.skipped;
        total.failed += part.failed;
        total.metadataWarnings += part.metadataWarnings;
        total.cancelled = total.cancelled || part.cancelled;
    }

    /**
     * @param {unknown} change
     * @param {number} allowedBits
     * @returns {import('./attributeOperation').BitChange}
     */
    static #requireBitChange(change, allowedBits) {
        const { set, clear } = /** @type {{ set?: unknown, clear?: unknown }} */ (change ?? {});
        if (typeof set !== 'number' || typeof clear !== 'number'
            || !Number.isInteger(set) || !Number.isInteger(clear)
            || (set & ~allowedBits) !== 0 || (clear & ~allowedBits) !== 0 || (set & clear) !== 0) {
            throw new Error('Invalid attribute change.');
        }
        return { set, clear };
    }

    /**
     * @param {string} title
     * @param {{ cancelled: boolean }} cancellation
     * @param {() => Promise<import('./copyOperation').OperationSummary>} run
     */
    #runInBackground(title, cancellation, run) {
        this.#running = cancellation;
        this.#lastProgressAt = 0;
        this.#post({ type: 'operationStarted', title });
        void run().then(
            (summary) => this.#post({ type: 'operationFinished', title, summary }),
            (error) => this.#post({ type: 'operationFinished', title, error: Common.errorMessage(error) }),
        ).finally(() => {
            this.#running = null;
            this.#refreshPanels();
        });
    }

    /**
     * @param {import('./copyOperation').OperationQuestion} question
     * @returns {Promise<any>}
     */
    #ask(question) {
        const questionId = this.#nextQuestionId++;
        return new Promise((resolve) => {
            this.#pendingQuestions.set(questionId, resolve);
            this.#post({ type: 'operationQuestion', questionId, question });
        });
    }

    /**
     * @param {Record<string, unknown>} progress
     */
    #reportProgress(progress) {
        const now = Date.now();
        if (now - this.#lastProgressAt < Config.PROGRESS_INTERVAL_MS) {
            return;
        }
        this.#lastProgressAt = now;
        this.#post({ type: 'operationProgress', progress });
    }

    #cancelRunning() {
        if (this.#running) {
            this.#running.cancelled = true;
        }
        for (const resolve of this.#pendingQuestions.values()) {
            resolve({ action: 'cancel', forAll: false });
        }
        this.#pendingQuestions.clear();
    }

    #requireIdle() {
        if (this.#running) {
            throw new Error('Another operation is still running.');
        }
    }

    #refreshPanels() {
        const sessions = this.#sessions();
        void sessions.left.refreshNow();
        void sessions.right.refreshNow();
    }

    /**
     * @param {unknown} side
     * @returns {string}
     */
    #folderOf(side) {
        if (side !== 'left' && side !== 'right') {
            throw new Error('Unknown panel.');
        }
        const session = this.#sessions()[side];
        if (session.isInArchive) {
            throw new Error('Archives are only looked into here; unpack the archive to change its content.');
        }
        const dir = session.path;
        if (dir === null || dir === '') {
            throw new Error('Nothing can be done in the drive list.');
        }
        return dir;
    }

    /**
     * @param {string} name
     */
    static #requireValidName(name) {
        const problem = NameValidator.problemOf(name);
        if (problem) {
            throw new Error(problem);
        }
    }

    /**
     * An entry of the panel's folder as the webview names it: a bare name, never a path.
     * @param {unknown} name
     * @returns {string}
     */
    static #requireEntryName(name) {
        if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
            throw new Error('Invalid entry name.');
        }
        return name;
    }

    /**
     * @param {unknown} names
     * @returns {string[]}
     */
    static #requireEntryNames(names) {
        if (!Array.isArray(names) || names.length === 0) {
            throw new Error('Nothing is selected.');
        }
        return names.map((name) => OperationHost.#requireEntryName(name));
    }

    /**
     * @param {unknown} error
     * @param {string} name
     * @returns {Error}
     */
    static #explain(error, name) {
        switch (Common.errorCode(error)) {
            case 'EEXIST':
                return new Error(`"${name}" already exists.`);
            case 'EACCES':
            case 'EPERM':
                return new Error(`Permission denied: ${Common.errorMessage(error)}`);
            default:
                return error instanceof Error ? error : new Error(String(error));
        }
    }
}

module.exports.OperationHost = OperationHost;
