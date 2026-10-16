// @ts-check
'use strict';

/**
 * @typedef {'newFolder' | 'newFile' | 'rename' | 'copy' | 'move' | 'attributes' | 'properties' | 'pack' | 'unpack'
 *     | 'test' | 'delete'} OperationAction
 */

/**
 * @typedef {object} RequestResult
 * @property {boolean} ok
 * @property {string} [error]
 * @property {string} [focusName]
 * @property {EntryProperties[]} [properties]
 */

/**
 * @typedef {object} OperationsContext
 * @property {(message: Record<string, unknown>) => void} post
 * @property {(side: 'left' | 'right') => PanelView} panel
 * @property {() => 'win' | 'linux' | 'mac'} platformKind
 * @property {() => boolean} hideExtension
 * @property {(hide: boolean) => void} setHideExtension
 */

/**
 * The dialogs of the file operations and the replies to them. The webview names only entries of the folders the
 * panels show; the extension host builds the paths, checks the names and does the work.
 */
class OperationsController {
    static #DELETE_COUNTDOWN_SECONDS = 5;
    static #ARCHIVE_NAME = /\.(zip|tar\.gz|tgz|tar)$/i;
    /** @type {Record<string, string>} */
    static #FORMAT_EXTENSIONS = { zip: '.zip', tgz: '.tar.gz', tar: '.tar' };
    static #LISTED_NAMES_MAX = 10;

    #context;
    #dialogs;
    #progress;
    #trashAvailable = false;
    /** @type {'zip' | 'tgz' | 'tar'} */
    #packFormat = 'zip';
    #unpackIntoSubfolder = false;
    /** @type {{ requestId: number, view: PropertiesView } | null} */
    #openProperties = null;
    #nextRequestId = 1;
    /** @type {Map<number, (result: RequestResult) => void>} */
    #pendingRequests = new Map();
    /** @type {{ side: 'left' | 'right', names: string[] } | null} */
    #running = null;

    /**
     * @param {OperationsContext} context
     * @param {DialogView} dialogs
     * @param {HTMLElement} root
     */
    constructor(context, dialogs, root) {
        this.#context = context;
        this.#dialogs = dialogs;
        this.#progress = new ProgressView(root, () => this.#context.post({ type: 'cancelOperation' }));
    }

    /**
     * @param {boolean} available
     */
    setTrashAvailable(available) {
        this.#trashAvailable = available;
    }

    /**
     * @param {OperationAction} action
     * @param {'left' | 'right'} side
     * @param {{ shiftKey: boolean }} modifiers
     */
    run(action, side, modifiers) {
        if (!this.#context.panel(side).canOperate) {
            return;
        }
        switch (action) {
            case 'newFolder':
                void this.#create(side, 'folder');
                break;
            case 'newFile':
                void this.#create(side, 'file');
                break;
            case 'rename':
                void this.#rename(side);
                break;
            case 'copy':
            case 'move':
                void this.#transfer(side, action === 'move');
                break;
            case 'attributes':
                void this.#attributes(side);
                break;
            case 'properties':
                void this.#properties(side);
                break;
            case 'pack':
                void this.#pack(side);
                break;
            case 'unpack':
                void this.#unpack(side);
                break;
            case 'test':
                void this.#test(side);
                break;
            case 'delete':
                void this.#delete(side, modifiers.shiftKey);
                break;
        }
    }

    /**
     * Messages of the extension host about requests and running operations.
     * @param {any} message
     * @returns {boolean}
     */
    handleMessage(message) {
        switch (message?.type) {
            case 'requestResult':
                this.#pendingRequests.get(message.requestId)?.(message);
                this.#pendingRequests.delete(message.requestId);
                return true;
            case 'propertiesCount':
                if (this.#openProperties && this.#openProperties.requestId === message.requestId) {
                    this.#openProperties.view.updateContent(message);
                }
                return true;
            case 'operationStarted':
                this.#progress.start(message.title);
                return true;
            case 'operationProgress':
                this.#progress.update(message.progress);
                return true;
            case 'operationQuestion':
                void this.#answer(message.questionId, message.question);
                return true;
            case 'operationFinished':
                this.#progress.finish();
                void this.#finished(message);
                return true;
        }
        return false;
    }

    /**
     * @param {'left' | 'right'} side
     * @param {'folder' | 'file'} kind
     */
    async #create(side, kind) {
        const panel = this.#context.panel(side);
        if (!panel.canOperate) {
            return;
        }
        await this.#dialogs.show({
            title: kind === 'folder' ? 'New folder' : 'New file',
            input: { value: '' },
            buttons: [
                { action: 'create', label: 'Create', primary: true },
                { action: 'cancel', label: 'Cancel' },
            ],
            cancelAction: 'cancel',
            submit: async ({ value }) => {
                const result = await this.#request({ type: 'createEntry', side, kind, name: value });
                if (!result.ok) {
                    return result.error ?? 'Failed.';
                }
                panel.focusEntry(result.focusName ?? value);
                return null;
            },
        });
        panel.focus();
    }

    /**
     * Renames the entry under the cursor. With "hide extension" on, the field holds the name without the
     * extension, which is kept as it was.
     * @param {'left' | 'right'} side
     */
    async #rename(side) {
        const panel = this.#context.panel(side);
        const entry = panel.cursorEntry;
        if (!entry) {
            return;
        }
        const { base, extension } = Format.splitName(entry.name, entry.isDir);
        const hasExtension = extension !== '';
        const hide = hasExtension && this.#context.hideExtension();
        const fullName = (/** @type {string} */ value, /** @type {boolean} */ hidden) => (
            hidden && hasExtension ? `${value}.${extension}` : value
        );
        await this.#dialogs.show({
            title: entry.isDir ? 'Rename folder' : 'Rename file',
            message: entry.name,
            input: { value: hide ? base : entry.name, selectionEnd: hasExtension && !hide ? base.length : undefined },
            checkbox: hasExtension ? {
                label: 'Hide file extension',
                checked: hide,
                onToggle: (checked, input) => {
                    this.#context.setHideExtension(checked);
                    if (!input) {
                        return;
                    }
                    const suffix = `.${extension}`;
                    if (checked && input.value.endsWith(suffix)) {
                        input.value = input.value.slice(0, -suffix.length);
                    } else if (!checked) {
                        input.value = `${input.value}${suffix}`;
                    }
                    input.focus();
                },
            } : undefined,
            buttons: [
                { action: 'rename', label: 'Rename', primary: true },
                { action: 'cancel', label: 'Cancel' },
            ],
            cancelAction: 'cancel',
            submit: async ({ value, checked }) => {
                const newName = fullName(value, checked);
                const result = await this.#request({ type: 'renameEntry', side, oldName: entry.name, newName });
                if (!result.ok) {
                    return result.error ?? 'Failed.';
                }
                panel.focusEntry(result.focusName ?? newName);
                return null;
            },
        });
        panel.focus();
    }

    /**
     * Entries dragged onto the other panel: asks where exactly before anything happens.
     * @param {'left' | 'right'} side
     * @param {string[]} names
     * @param {DropTarget} target
     * @param {boolean} move
     */
    transferTo(side, names, target, move) {
        void this.#transfer(side, move, names, target);
    }

    /**
     * @param {'left' | 'right'} side
     * @param {boolean} move
     * @param {string[]} [draggedNames]
     * @param {DropTarget} [dropTarget]
     */
    async #transfer(side, move, draggedNames, dropTarget) {
        const panel = this.#context.panel(side);
        const names = draggedNames ?? panel.operationNames;
        if (names.length === 0) {
            return;
        }
        const targetDir = dropTarget?.path ?? this.#context.panel(side === 'left' ? 'right' : 'left').path ?? '';
        const separator = this.#context.platformKind() === 'win' ? '\\' : '/';
        const destination = names.length === 1 && targetDir !== ''
            ? `${targetDir.endsWith(separator) ? targetDir : targetDir + separator}${names[0]}`
            : targetDir;
        const verb = move ? 'Move' : 'Copy';
        const into = dropTarget?.folderName ? ` into "${dropTarget.folderName}"` : '';
        const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
        await this.#dialogs.show({
            title: into ? `${verb} ${what}${into}` : `${verb} ${what} to`,
            input: { value: destination },
            buttons: [
                { action: 'start', label: verb, primary: true },
                { action: 'cancel', label: 'Cancel' },
            ],
            cancelAction: 'cancel',
            submit: async ({ value }) => {
                const result = await this.#request({ type: 'startCopy', side, names, destination: value, move });
                if (!result.ok) {
                    return result.error ?? 'Failed.';
                }
                this.#running = { side, names };
                return null;
            },
        });
        panel.focus();
    }

    /**
     * Permissions or attributes of the chosen entries; only the bits changed in the dialog are applied.
     * @param {'left' | 'right'} side
     */
    async #attributes(side) {
        const panel = this.#context.panel(side);
        const entries = panel.operationEntries;
        if (entries.length === 0) {
            return;
        }
        const form = new AttributesForm(entries);
        const what = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
        await this.#dialogs.show({
            title: `Attributes of ${what}`,
            body: form.element,
            buttons: [
                { action: 'apply', label: 'Apply', primary: true },
                { action: 'cancel', label: 'Cancel' },
            ],
            cancelAction: 'cancel',
            submit: async () => {
                const change = form.change;
                if (change.set === 0 && change.clear === 0) {
                    return null;
                }
                const result = await this.#request({
                    type: 'changeAttributes',
                    side,
                    names: entries.map((entry) => entry.name),
                    change,
                    recursive: form.recursive,
                });
                return result.ok ? null : result.error ?? 'Failed.';
            },
        });
        panel.focus();
    }

    /**
     * Properties of the chosen entries; folders are counted while the dialog is open, and closing it stops that.
     * @param {'left' | 'right'} side
     */
    async #properties(side) {
        const panel = this.#context.panel(side);
        const names = panel.operationNames;
        if (names.length === 0) {
            return;
        }
        const requestId = this.#nextRequestId++;
        const result = await this.#request({ type: 'properties', side, names }, requestId);
        if (!result.ok || !result.properties) {
            await this.#notice('Properties', result.error ?? 'Failed.');
            panel.focus();
            return;
        }
        const view = new PropertiesView(result.properties);
        this.#openProperties = { requestId, view };
        await this.#dialogs.show({
            title: names.length === 1 ? 'Properties' : `Properties of ${names.length} items`,
            body: view.element,
            buttons: [{ action: 'close', label: 'Close', primary: true }],
            cancelAction: 'close',
        });
        this.#openProperties = null;
        this.#context.post({ type: 'cancelProperties', requestId });
        panel.focus();
    }

    /**
     * Packs the chosen entries into a new archive in the other panel's folder.
     * @param {'left' | 'right'} side
     */
    async #pack(side) {
        const panel = this.#context.panel(side);
        const names = panel.operationNames;
        if (names.length === 0) {
            return;
        }
        const otherPanel = this.#context.panel(side === 'left' ? 'right' : 'left');
        const targetDir = otherPanel.canOperate ? otherPanel.path ?? '' : panel.path ?? '';
        const baseName = names.length === 1
            ? Format.splitName(names[0], panel.cursorEntry?.isDir ?? true).base
            : Format.lastSegment(panel.path ?? '') || 'archive';
        const separator = this.#context.platformKind() === 'win' ? '\\' : '/';
        const pathOf = (/** @type {'zip' | 'tgz' | 'tar'} */ format) => (
            `${targetDir.endsWith(separator) ? targetDir : targetDir + separator}${baseName}`
            + OperationsController.#FORMAT_EXTENSIONS[format]
        );
        const formats = document.createElement('div');
        formats.className = 'archive-formats';
        for (const [format, label] of [['zip', 'zip'], ['tgz', 'tar.gz'], ['tar', 'tar']]) {
            const option = document.createElement('label');
            option.className = 'dialog-checkbox';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'archive-format';
            radio.checked = format === this.#packFormat;
            radio.addEventListener('change', () => {
                this.#packFormat = /** @type {'zip' | 'tgz' | 'tar'} */ (format);
                const field = formats.closest('.dialog')?.querySelector('input.dialog-input');
                if (field instanceof HTMLInputElement) {
                    field.value = field.value.replace(OperationsController.#ARCHIVE_NAME, '')
                        + OperationsController.#FORMAT_EXTENSIONS[format];
                }
            });
            option.append(radio, document.createTextNode(label));
            formats.appendChild(option);
        }
        const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
        await this.#dialogs.show({
            title: `Pack ${what} into`,
            body: formats,
            input: { value: pathOf(this.#packFormat) },
            buttons: [
                { action: 'pack', label: 'Pack', primary: true },
                { action: 'cancel', label: 'Cancel' },
            ],
            cancelAction: 'cancel',
            submit: async ({ value }) => {
                const result = await this.#request({
                    type: 'startPack',
                    side,
                    names,
                    target: value,
                    format: this.#packFormat,
                });
                if (!result.ok) {
                    return result.error ?? 'Failed.';
                }
                if (otherPanel.canOperate && result.focusName) {
                    otherPanel.focusEntry(result.focusName);
                }
                return null;
            },
        });
        panel.focus();
    }

    /**
     * Unpacks whole archives into the other panel's folder, or into subfolders named after them.
     * @param {'left' | 'right'} side
     */
    async #unpack(side) {
        const panel = this.#context.panel(side);
        const names = panel.operationNames.filter((name) => OperationsController.#ARCHIVE_NAME.test(name));
        if (names.length === 0) {
            await this.#notice('Unpack', 'Choose zip, tar or tar.gz archives to unpack.');
            panel.focus();
            return;
        }
        const otherPanel = this.#context.panel(side === 'left' ? 'right' : 'left');
        const destination = otherPanel.canOperate ? otherPanel.path ?? '' : panel.path ?? '';
        const what = names.length === 1 ? `"${names[0]}"` : `${names.length} archives`;
        await this.#dialogs.show({
            title: `Unpack ${what} to`,
            input: { value: destination },
            checkbox: {
                label: 'Into a subfolder named after the archive',
                checked: this.#unpackIntoSubfolder,
                onToggle: (checked) => {
                    this.#unpackIntoSubfolder = checked;
                },
            },
            buttons: [
                { action: 'unpack', label: 'Unpack', primary: true },
                { action: 'cancel', label: 'Cancel' },
            ],
            cancelAction: 'cancel',
            submit: async ({ value, checked }) => {
                const result = await this.#request({
                    type: 'startUnpack',
                    side,
                    names,
                    destination: value,
                    intoSubfolder: checked,
                });
                return result.ok ? null : result.error ?? 'Failed.';
            },
        });
        panel.focus();
    }

    /**
     * @param {'left' | 'right'} side
     */
    async #test(side) {
        const panel = this.#context.panel(side);
        const names = panel.operationNames.filter((name) => OperationsController.#ARCHIVE_NAME.test(name));
        if (names.length === 0) {
            await this.#notice('Test', 'Choose zip, tar or tar.gz archives to test.');
            panel.focus();
            return;
        }
        const result = await this.#request({ type: 'startTest', side, names });
        if (!result.ok) {
            await this.#notice('Test', result.error ?? 'Failed.');
        }
        panel.focus();
    }

    /**
     * Always confirmed. Deleting past the trash — Shift, or no trash at all — is confirmed a second time, and
     * that confirmation cannot be pressed for the first seconds.
     * @param {'left' | 'right'} side
     * @param {boolean} shiftKey
     */
    async #delete(side, shiftKey) {
        const panel = this.#context.panel(side);
        const names = panel.operationNames;
        if (names.length === 0) {
            return;
        }
        const permanent = shiftKey || !this.#trashAvailable;
        const what = names.length === 1 ? `"${names[0]}"` : `${names.length} items`;
        const first = await this.#dialogs.show({
            title: permanent ? 'Delete' : 'Move to Trash',
            message: permanent ? `Delete ${what}?` : `Move ${what} to the Trash?`,
            lines: OperationsController.#listedNames(names),
            buttons: [
                { action: 'delete', label: permanent ? 'Delete' : 'Move to Trash', primary: true },
                { action: 'cancel', label: 'Cancel' },
            ],
            cancelAction: 'cancel',
        });
        if (first.action !== 'delete') {
            panel.focus();
            return;
        }
        if (permanent) {
            const reason = this.#trashAvailable ? '' : ' There is no trash here.';
            const second = await this.#dialogs.show({
                title: 'Delete permanently',
                message: `${what} will be deleted permanently. This cannot be undone.${reason}`,
                buttons: [
                    {
                        action: 'delete',
                        label: 'Delete permanently',
                        primary: true,
                        countdownSeconds: OperationsController.#DELETE_COUNTDOWN_SECONDS,
                    },
                    { action: 'cancel', label: 'Cancel' },
                ],
                cancelAction: 'cancel',
            });
            if (second.action !== 'delete') {
                panel.focus();
                return;
            }
        }
        const result = await this.#request({ type: 'startDelete', side, names, permanent });
        if (!result.ok) {
            await this.#notice('Delete', result.error ?? 'Failed.');
        } else {
            this.#running = { side, names };
        }
        panel.focus();
    }

    /**
     * @param {number} questionId
     * @param {any} question
     */
    async #answer(questionId, question) {
        if (question.kind === 'conflict') {
            const buttons = [
                { action: 'overwrite', label: 'Overwrite', primary: true },
                { action: 'rename', label: 'Keep both', primary: !question.canOverwrite },
                { action: 'skip', label: 'Skip' },
                { action: 'cancel', label: 'Cancel' },
            ].filter((button) => button.action !== 'overwrite' || question.canOverwrite);
            const result = await this.#dialogs.show({
                title: 'Name already taken',
                message: `"${question.name}" already exists in the destination.`,
                lines: [
                    `Existing: ${OperationsController.#describe(question.existing)}`,
                    `New:      ${OperationsController.#describe(question.source)}`,
                    'Keep both gives the new one a number: name (1).ext',
                ],
                checkbox: { label: 'Do this for all conflicts', checked: false },
                buttons,
                cancelAction: 'cancel',
            });
            this.#context.post({
                type: 'operationAnswer',
                questionId,
                answer: { action: result.action, forAll: result.checked },
            });
            return;
        }
        const result = await this.#dialogs.show({
            title: 'Error',
            message: `${question.name}: ${question.message}`,
            buttons: [
                { action: 'retry', label: 'Retry', primary: true },
                { action: 'skip', label: 'Skip' },
                { action: 'skipAll', label: 'Skip all' },
                { action: 'abort', label: 'Abort' },
            ],
            cancelAction: 'abort',
        });
        this.#context.post({ type: 'operationAnswer', questionId, answer: { action: result.action } });
    }

    /**
     * A summary only when something did not go as asked: skipped, failed, cancelled or incomplete metadata.
     * @param {any} message
     */
    async #finished(message) {
        const running = this.#running;
        this.#running = null;
        if (message.error) {
            await this.#notice(message.title, message.error);
            return;
        }
        const summary = message.summary;
        if (summary.tested !== undefined) {
            await this.#reportTest(summary);
            return;
        }
        if (running && !summary.cancelled && summary.failed === 0 && summary.skipped === 0) {
            this.#context.panel(running.side).deselect(running.names);
        }
        const problems = [];
        if (summary.cancelled) {
            problems.push('Cancelled.');
        }
        if (summary.skipped > 0) {
            problems.push(`Skipped: ${summary.skipped}.`);
        }
        if (summary.failed > 0) {
            problems.push(`Failed: ${summary.failed}.`);
        }
        if (summary.metadataWarnings > 0) {
            const count = summary.metadataWarnings;
            problems.push(`Dates or permissions not kept on ${count} items: the file system refused them.`);
        }
        if (problems.length > 0) {
            await this.#notice(message.title, `Done: ${summary.done}.`, problems);
        }
    }

    /**
     * @param {any} summary
     */
    async #reportTest(summary) {
        const archives = summary.tested === 1 ? 'the archive' : `${summary.tested} archives`;
        if (summary.cancelled) {
            await this.#notice('Test', `Cancelled after ${summary.done} files.`);
        } else if (summary.problems.length === 0) {
            await this.#notice('Test', `No damage found: ${summary.done} files in ${archives} read and checked.`);
        } else {
            await this.#notice(
                'Test',
                `Damage found in ${archives}: ${summary.problems.length} of ${summary.done} files.`,
                summary.problems.map((/** @type {{ name: string, problem: string }} */ problem) => (
                    `${problem.name} — ${problem.problem}`
                )),
            );
        }
    }

    /**
     * @param {string} title
     * @param {string} message
     * @param {string[]} [lines]
     */
    async #notice(title, message, lines = []) {
        await this.#dialogs.show({
            title,
            message,
            lines,
            buttons: [{ action: 'ok', label: 'OK', primary: true }],
            cancelAction: 'ok',
        });
    }

    /**
     * @param {Record<string, unknown>} message
     * @param {number} [requestId]  given when later messages of the host refer to this request
     * @returns {Promise<RequestResult>}
     */
    #request(message, requestId = this.#nextRequestId++) {
        return new Promise((resolve) => {
            this.#pendingRequests.set(requestId, resolve);
            this.#context.post({ ...message, requestId });
        });
    }

    /**
     * @param {string[]} names
     * @returns {string[]}
     */
    static #listedNames(names) {
        if (names.length <= 1) {
            return [];
        }
        const listed = names.slice(0, OperationsController.#LISTED_NAMES_MAX);
        const more = names.length - listed.length;
        return more > 0 ? [...listed, `… and ${more} more`] : listed;
    }

    /**
     * @param {{ isDir: boolean, size: number, mtime: number }} facts
     * @returns {string}
     */
    static #describe(facts) {
        const size = facts.isDir ? 'folder' : Format.size(facts.size, 'units');
        return `${size}, ${Format.date(facts.mtime)}`;
    }
}
