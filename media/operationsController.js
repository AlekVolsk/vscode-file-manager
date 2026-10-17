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
 * @property {() => Settings} settings
 * @property {(key: keyof Settings, value: unknown) => void} updateSetting
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
            title: I18n.t(kind === 'folder' ? 'dialog.newFolder' : 'dialog.newFile'),
            input: { value: '' },
            buttons: [
                { action: 'create', label: I18n.t('button.create'), primary: true },
                { action: 'cancel', label: I18n.t('button.cancel') },
            ],
            cancelAction: 'cancel',
            submit: async ({ value }) => {
                const result = await this.#request({ type: 'createEntry', side, kind, name: value });
                if (!result.ok) {
                    return result.error ?? I18n.t('common.failed');
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
        const hide = hasExtension && this.#context.settings().hideExtensionOnRename;
        const fullName = (/** @type {string} */ value, /** @type {boolean} */ hidden) => (
            hidden && hasExtension ? `${value}.${extension}` : value
        );
        await this.#dialogs.show({
            title: I18n.t(entry.isDir ? 'dialog.renameFolder' : 'dialog.renameFile'),
            message: entry.name,
            input: { value: hide ? base : entry.name, selectionEnd: hasExtension && !hide ? base.length : undefined },
            checkbox: hasExtension ? {
                label: I18n.t('rename.hideExtension'),
                checked: hide,
                onToggle: (checked, input) => {
                    this.#context.updateSetting('hideExtensionOnRename', checked);
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
                { action: 'rename', label: I18n.t('button.rename'), primary: true },
                { action: 'cancel', label: I18n.t('button.cancel') },
            ],
            cancelAction: 'cancel',
            submit: async ({ value, checked }) => {
                const newName = fullName(value, checked);
                const result = await this.#request({ type: 'renameEntry', side, oldName: entry.name, newName });
                if (!result.ok) {
                    return result.error ?? I18n.t('common.failed');
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
        const folder = dropTarget?.folderName;
        const title = folder
            ? I18n.t(move ? 'dialog.moveInto' : 'dialog.copyInto', { folder })
            : I18n.t(move ? 'dialog.moveTo' : 'dialog.copyTo');
        await this.#dialogs.show({
            title,
            message: OperationsController.#what(names),
            input: { value: destination },
            buttons: [
                { action: 'start', label: I18n.t(move ? 'button.move' : 'button.copy'), primary: true },
                { action: 'cancel', label: I18n.t('button.cancel') },
            ],
            cancelAction: 'cancel',
            submit: async ({ value }) => {
                const result = await this.#request({ type: 'startCopy', side, names, destination: value, move });
                if (!result.ok) {
                    return result.error ?? I18n.t('common.failed');
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
        await this.#dialogs.show({
            title: I18n.t('dialog.attributes'),
            message: OperationsController.#what(entries.map((entry) => entry.name)),
            body: form.element,
            buttons: [
                { action: 'apply', label: I18n.t('button.apply'), primary: true },
                { action: 'cancel', label: I18n.t('button.cancel') },
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
                return result.ok ? null : result.error ?? I18n.t('common.failed');
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
            await this.#notice(I18n.t('dialog.properties'), result.error ?? I18n.t('common.failed'));
            panel.focus();
            return;
        }
        const view = new PropertiesView(result.properties);
        this.#openProperties = { requestId, view };
        await this.#dialogs.show({
            title: I18n.t('dialog.properties'),
            body: view.element,
            buttons: [{ action: 'close', label: I18n.t('button.close'), primary: true }],
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
            radio.checked = format === this.#context.settings().packFormat;
            radio.addEventListener('change', () => {
                this.#context.updateSetting('packFormat', format);
                const field = formats.closest('.dialog')?.querySelector('input.dialog-input');
                if (field instanceof HTMLInputElement) {
                    field.value = field.value.replace(OperationsController.#ARCHIVE_NAME, '')
                        + OperationsController.#FORMAT_EXTENSIONS[format];
                }
            });
            option.append(radio, document.createTextNode(label));
            formats.appendChild(option);
        }
        await this.#dialogs.show({
            title: I18n.t('dialog.packInto'),
            message: OperationsController.#what(names),
            body: formats,
            input: { value: pathOf(this.#context.settings().packFormat) },
            buttons: [
                { action: 'pack', label: I18n.t('button.pack'), primary: true },
                { action: 'cancel', label: I18n.t('button.cancel') },
            ],
            cancelAction: 'cancel',
            submit: async ({ value }) => {
                const result = await this.#request({
                    type: 'startPack',
                    side,
                    names,
                    target: value,
                    format: this.#context.settings().packFormat,
                });
                if (!result.ok) {
                    return result.error ?? I18n.t('common.failed');
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
            await this.#notice(I18n.t('dialog.unpack'), I18n.t('unpack.chooseArchives'));
            panel.focus();
            return;
        }
        const otherPanel = this.#context.panel(side === 'left' ? 'right' : 'left');
        const destination = otherPanel.canOperate ? otherPanel.path ?? '' : panel.path ?? '';
        await this.#dialogs.show({
            title: I18n.t('dialog.unpackTo'),
            message: OperationsController.#what(names),
            input: { value: destination },
            checkbox: {
                label: I18n.t('unpack.intoSubfolder'),
                checked: this.#context.settings().unpackIntoSubfolder,
                onToggle: (checked) => {
                    this.#context.updateSetting('unpackIntoSubfolder', checked);
                },
            },
            buttons: [
                { action: 'unpack', label: I18n.t('button.unpack'), primary: true },
                { action: 'cancel', label: I18n.t('button.cancel') },
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
                return result.ok ? null : result.error ?? I18n.t('common.failed');
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
            await this.#notice(I18n.t('dialog.test'), I18n.t('test.chooseArchives'));
            panel.focus();
            return;
        }
        const result = await this.#request({ type: 'startTest', side, names });
        if (!result.ok) {
            await this.#notice(I18n.t('dialog.test'), result.error ?? I18n.t('common.failed'));
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
        const question = names.length === 1
            ? I18n.t(permanent ? 'delete.permanentOne' : 'delete.trashOne', { name: names[0] })
            : `${I18n.t(permanent ? 'delete.permanentMany' : 'delete.trashMany')} ${OperationsController.#what(names)}`;
        const first = await this.#dialogs.show({
            title: I18n.t(permanent ? 'dialog.delete' : 'dialog.moveToTrash'),
            message: question,
            lines: OperationsController.#listedNames(names),
            buttons: [
                { action: 'delete', label: I18n.t(permanent ? 'button.delete' : 'button.moveToTrash'), primary: true },
                { action: 'cancel', label: I18n.t('button.cancel') },
            ],
            cancelAction: 'cancel',
        });
        if (first.action !== 'delete') {
            panel.focus();
            return;
        }
        if (permanent) {
            const reason = this.#trashAvailable ? '' : ` ${I18n.t('delete.noTrash')}`;
            const second = await this.#dialogs.show({
                title: I18n.t('dialog.deletePermanently'),
                message: `${OperationsController.#what(names)}. ${I18n.t('delete.cannotUndo')}${reason}`,
                buttons: [
                    {
                        action: 'delete',
                        label: I18n.t('button.deletePermanently'),
                        primary: true,
                        countdownSeconds: OperationsController.#DELETE_COUNTDOWN_SECONDS,
                    },
                    { action: 'cancel', label: I18n.t('button.cancel') },
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
            await this.#notice(I18n.t('dialog.delete'), result.error ?? I18n.t('common.failed'));
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
                { action: 'overwrite', label: I18n.t('button.overwrite'), primary: true },
                { action: 'rename', label: I18n.t('button.keepBoth'), primary: !question.canOverwrite },
                { action: 'skip', label: I18n.t('button.skip') },
                { action: 'cancel', label: I18n.t('button.cancel') },
            ].filter((button) => button.action !== 'overwrite' || question.canOverwrite);
            const result = await this.#dialogs.show({
                title: I18n.t('dialog.nameTaken'),
                message: I18n.t('conflict.exists', { name: question.name }),
                lines: [
                    I18n.t('conflict.existing', { facts: OperationsController.#describe(question.existing) }),
                    I18n.t('conflict.new', { facts: OperationsController.#describe(question.source) }),
                    I18n.t('conflict.keepBothHint'),
                ],
                checkbox: { label: I18n.t('conflict.forAll'), checked: false },
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
            title: I18n.t('dialog.error'),
            message: `${question.name}: ${question.message}`,
            buttons: [
                { action: 'retry', label: I18n.t('button.retry'), primary: true },
                { action: 'skip', label: I18n.t('button.skip') },
                { action: 'skipAll', label: I18n.t('button.skipAll') },
                { action: 'abort', label: I18n.t('button.abort') },
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
            problems.push(I18n.t('summary.cancelled'));
        }
        if (summary.skipped > 0) {
            problems.push(I18n.t('summary.skipped', { count: summary.skipped }));
        }
        if (summary.failed > 0) {
            problems.push(I18n.t('summary.failed', { count: summary.failed }));
        }
        if (summary.metadataWarnings > 0) {
            problems.push(I18n.t('summary.metadata', { count: summary.metadataWarnings }));
        }
        if (problems.length > 0) {
            await this.#notice(message.title, I18n.t('summary.done', { count: summary.done }), problems);
        }
    }

    /**
     * @param {any} summary
     */
    async #reportTest(summary) {
        const title = I18n.t('dialog.test');
        const counts = { archives: summary.tested, count: summary.done, damaged: summary.problems.length };
        if (summary.cancelled) {
            await this.#notice(title, I18n.t('test.cancelled', counts));
        } else if (summary.problems.length === 0) {
            await this.#notice(title, I18n.t('test.clean', counts));
        } else {
            await this.#notice(
                title,
                I18n.t('test.damaged', counts),
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
            buttons: [{ action: 'ok', label: I18n.t('button.ok'), primary: true }],
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
        return more > 0 ? [...listed, I18n.t('common.more', { count: more })] : listed;
    }

    /**
     * The name of a single entry, or how many are selected: a count in a sentence would need plural forms in
     * every language.
     * @param {string[]} names
     * @returns {string}
     */
    static #what(names) {
        return names.length === 1 ? names[0] : I18n.t('common.selected', { count: names.length });
    }

    /**
     * @param {{ isDir: boolean, size: number, mtime: number }} facts
     * @returns {string}
     */
    static #describe(facts) {
        const size = facts.isDir ? I18n.t('conflict.folder') : Format.size(facts.size, 'units');
        return `${size}, ${Format.date(facts.mtime)}`;
    }
}
