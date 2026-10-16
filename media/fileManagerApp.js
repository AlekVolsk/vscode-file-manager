// @ts-check
'use strict';

/**
 * @typedef {object} AppViewState
 * @property {number} ratio  share of the left panel
 * @property {number} fontSizeDelta  px added to the editor font size in the tables
 * @property {boolean} hideExtension  in the rename dialog
 * @property {'left' | 'right'} active
 * @property {{ left?: Partial<PanelViewState>, right?: Partial<PanelViewState> }} panels
 * @property {{ left: string | null, right: string | null }} [paths]  folders of this tab, restored after a reload
 */

/**
 * The two panels, the splitter between them, keyboard routing and the messages to and from the extension host.
 */
class FileManagerApp {
    static #MIN_RATIO = 0.15;
    static #MAX_RATIO = 0.85;
    static #SAVE_DELAY_MS = 300;
    static #OPERATION_ACTIONS = new Set([
        'rename',
        'properties',
        'newFile',
        'copy',
        'move',
        'newFolder',
        'delete',
        'attributes',
        'pack',
        'unpack',
    ]);
    static #DOUBLE_CLICK_MS = 500;
    static #EQUAL_RATIO = 0.5;
    static #MIN_FONT_SIZE = 6;
    static #MAX_FONT_SIZE = 48;
    static #FALLBACK_FONT_SIZE = 14;

    #api;
    #icons;
    /** @type {HTMLElement} */
    #root;
    /** @type {{ left: PanelView, right: PanelView } | null} */
    #panels = null;
    /** @type {'left' | 'right'} */
    #active = 'left';
    #ratio = FileManagerApp.#EQUAL_RATIO;
    #fontSizeDelta = 0;
    #hideExtension = true;
    /** @type {'win' | 'linux' | 'mac'} */
    #platformKind = 'linux';
    /** @type {DialogView} */
    #dialogs;
    /** @type {DragController} */
    #drag;
    /** @type {OperationsController} */
    #operations;
    #swapPending = false;
    /** @type {{ side: 'left' | 'right' }[]} */
    #places = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    #saveTimer = null;
    /** @type {Array<Record<string, any>>} */
    #queuedMessages = [];

    /**
     * @param {{ postMessage(message: unknown): void, setState(state: unknown): void, getState(): unknown }} api
     * @param {string} nonce
     * @param {HTMLElement} root
     */
    constructor(api, nonce, root) {
        this.#api = api;
        this.#icons = new IconResolver(nonce);
        this.#root = root;
        this.#dialogs = new DialogView(document.body);
        this.#drag = new DragController(
            () => this.#panels,
            (side, names, target, move) => this.#operations.transferTo(side, names, target, move),
        );
        this.#operations = new OperationsController({
            post: (message) => this.#api.postMessage(message),
            panel: (side) => /** @type {{ left: PanelView, right: PanelView }} */ (this.#panels)[side],
            platformKind: () => this.#platformKind,
            hideExtension: () => this.#hideExtension,
            setHideExtension: (hide) => {
                this.#hideExtension = hide;
                this.#scheduleSave();
            },
        }, this.#dialogs, document.body);
    }

    start() {
        window.addEventListener('message', (event) => this.#onMessage(event.data));
        document.addEventListener('keydown', (event) => this.#onKeyDown(event));
        document.addEventListener('wheel', (event) => this.#onWheel(event), { passive: false });
        new MutationObserver(() => this.#rerenderIcons())
            .observe(document.body, { attributes: true, attributeFilter: ['class'] });
        this.#api.postMessage({ type: 'ready' });
    }

    /**
     * @param {any} message  posted by our own extension host
     */
    #onMessage(message) {
        if (message?.type === 'init') {
            this.#operations.setTrashAvailable(message.capabilities?.trash === true);
            this.#init(message.platform, message.viewState ?? this.#api.getState());
            this.#panels?.left.setRevealAvailable(message.capabilities?.revealInOs === true);
            this.#panels?.right.setRevealAvailable(message.capabilities?.revealInOs === true);
            for (const queued of this.#queuedMessages.splice(0)) {
                this.#onMessage(queued);
            }
            return;
        }
        if (this.#operations.handleMessage(message)) {
            return;
        }
        if (message?.type === 'workspaceFolders' && this.#panels) {
            this.#panels.left.setWorkspaceFolders(message.folders);
            this.#panels.right.setWorkspaceFolders(message.folders);
            return;
        }
        if (message?.type === 'iconTheme') {
            this.#icons.setTheme(message.theme);
            this.#rerenderIcons();
            if (message.error) {
                this.#panels?.left.showError(message.error);
            }
            return;
        }
        if (!this.#panels) {
            this.#queuedMessages.push(message);
            return;
        }
        if (message?.type === 'panelsSwapped') {
            this.#onPanelsSwapped();
            return;
        }
        if (message?.type === 'action') {
            void this.#runAction(String(message.action));
            return;
        }
        /** @type {unknown} */
        const side = message?.side;
        const panel = side === 'left' || side === 'right' ? this.#panels[side] : null;
        if (!panel) {
            return;
        }
        switch (message.type) {
            case 'listing':
                panel.setListing(message);
                if (message.isNewFolder) {
                    this.#scheduleSave();
                }
                break;
            case 'error':
                panel.showError(message.message);
                break;
            case 'folderSize':
                panel.setFolderSize(message);
                break;
            case 'folderSizesCancelled':
                panel.folderSizesCancelled();
                break;
            case 'notice':
                panel.showLoading(message.message);
                break;
        }
    }

    /**
     * @param {{ kind: 'win' | 'linux' | 'mac', isWsl: boolean, home: string }} platform
     * @param {Partial<AppViewState> | null} viewState
     */
    #init(platform, viewState) {
        if (this.#panels) {
            return;
        }
        this.#root.innerHTML = '<div class="panel-slot left"></div>'
            + '<div class="splitter"></div>'
            + '<div class="panel-slot right"></div>';
        const leftSlot = /** @type {HTMLElement} */ (this.#root.querySelector('.panel-slot.left'));
        const rightSlot = /** @type {HTMLElement} */ (this.#root.querySelector('.panel-slot.right'));
        this.#panels = {
            left: new PanelView(leftSlot, this.#callbacksFor('left'), this.#icons, platform),
            right: new PanelView(rightSlot, this.#callbacksFor('right'), this.#icons, platform),
        };
        this.#panels.left.applyViewState(viewState?.panels?.left);
        this.#panels.right.applyViewState(viewState?.panels?.right);
        if (typeof viewState?.ratio === 'number') {
            this.#ratio = Math.min(FileManagerApp.#MAX_RATIO, Math.max(FileManagerApp.#MIN_RATIO, viewState.ratio));
        }
        this.#applyRatio();
        this.#hideExtension = viewState?.hideExtension !== false;
        this.#platformKind = platform.kind;
        if (typeof viewState?.fontSizeDelta === 'number') {
            this.#fontSizeDelta = viewState.fontSizeDelta;
        }
        this.#applyFontSize();
        this.#bindSplitter(/** @type {HTMLElement} */ (this.#root.querySelector('.splitter')));
        this.#activate(viewState?.active === 'right' ? 'right' : 'left');
    }

    /**
     * Callbacks of the panel created on `initialSide`; they follow it when the panels swap.
     * @param {'left' | 'right'} initialSide
     * @returns {PanelCallbacks}
     */
    #callbacksFor(initialSide) {
        const place = { side: initialSide };
        this.#places.push(place);
        const post = (/** @type {string} */ type, /** @type {Record<string, unknown>} */ fields = {}) => {
            this.#api.postMessage({ type, side: place.side, ...fields });
        };
        return {
            navigate: (path, focusName) => post('navigate', { path, focusName }),
            openFile: (name, asFile = false) => post('openFile', { name, asFile }),
            countFolderSizes: (names) => post('countFolderSizes', { names }),
            cancelFolderSizes: () => post('cancelFolderSizes'),
            activate: () => this.#activate(place.side),
            operation: (action, modifiers) => this.#operations.run(action, place.side, modifiers),
            beginDrag: (names, event) => this.#drag.begin(place.side, names, event),
            revealInOs: (name) => post('revealInOs', { name }),
            viewStateChanged: () => this.#scheduleSave(),
        };
    }

    /**
     * Ctrl+U: the panels trade places with everything in them; the active side stays where it was.
     * The host swaps first and answers with panelsSwapped, which ends up in #onPanelsSwapped.
     */
    #requestSwap() {
        if (this.#swapPending) {
            return;
        }
        this.#swapPending = true;
        this.#api.postMessage({ type: 'swapPanels' });
    }

    /**
     * A function key, sent by the extension host from its keybindings. Nothing happens while a dialog is open or
     * a text field has the focus.
     * @param {string} action
     */
    async #runAction(action) {
        if (!this.#panels || this.#dialogs.isOpen) {
            return;
        }
        if (document.activeElement?.closest('input, select, textarea')) {
            return;
        }
        const panel = this.#panels[this.#active];
        if (action === 'help') {
            await this.#dialogs.show({
                title: 'File Manager — keys and mouse',
                body: HelpView.element(),
                buttons: [{ action: 'close', label: 'Close', primary: true }],
                cancelAction: 'close',
            });
            panel.focus();
        } else if (action === 'edit') {
            panel.openCursorFileInEditor();
        } else if (action === 'deletePermanently') {
            this.#operations.run('delete', this.#active, { shiftKey: true });
        } else if (FileManagerApp.#OPERATION_ACTIONS.has(action)) {
            this.#operations.run(/** @type {OperationAction} */ (action), this.#active, { shiftKey: false });
        }
    }

    #onPanelsSwapped() {
        this.#swapPending = false;
        if (!this.#panels) {
            return;
        }
        const { left, right } = this.#panels;
        this.#slot('left').appendChild(right.element);
        this.#slot('right').appendChild(left.element);
        this.#panels = { left: right, right: left };
        for (const place of this.#places) {
            place.side = place.side === 'left' ? 'right' : 'left';
        }
        this.#activate(this.#active);
        this.#scheduleSave();
    }

    /**
     * @param {'left' | 'right'} side
     */
    #activate(side) {
        if (!this.#panels) {
            return;
        }
        const changed = this.#active !== side;
        this.#active = side;
        this.#panels.left.setActive(side === 'left');
        this.#panels.right.setActive(side === 'right');
        if (changed) {
            this.#scheduleSave();
        }
    }

    /**
     * @param {KeyboardEvent} event
     */
    #onKeyDown(event) {
        if (!this.#panels || this.#dialogs.isOpen) {
            return;
        }
        const target = /** @type {HTMLElement} */ (event.target);
        if (target.closest('input, select, textarea')) {
            return;
        }
        if (event.code === 'KeyU' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            this.#requestSwap();
            return;
        }
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            this.#activate(this.#active === 'left' ? 'right' : 'left');
            return;
        }
        if (this.#panels[this.#active].handleKey(event)) {
            event.preventDefault();
            event.stopPropagation();
        }
    }

    /**
     * @param {HTMLElement} splitter
     */
    #bindSplitter(splitter) {
        let lastPointerDownAt = 0;
        splitter.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
                return;
            }
            event.preventDefault();
            const now = Date.now();
            if (now - lastPointerDownAt <= FileManagerApp.#DOUBLE_CLICK_MS) {
                lastPointerDownAt = 0;
                this.#ratio = FileManagerApp.#EQUAL_RATIO;
                this.#applyRatio();
                this.#scheduleSave();
                return;
            }
            lastPointerDownAt = now;
            splitter.setPointerCapture(event.pointerId);
            splitter.classList.add('dragging');
        });
        splitter.addEventListener('pointermove', (event) => {
            if (!splitter.hasPointerCapture(event.pointerId)) {
                return;
            }
            const left = this.#slot('left').getBoundingClientRect();
            const right = this.#slot('right').getBoundingClientRect();
            const splitterWidth = splitter.getBoundingClientRect().width;
            const available = right.right - left.left - splitterWidth;
            const ratio = (event.clientX - left.left - splitterWidth / 2) / available;
            this.#ratio = Math.min(FileManagerApp.#MAX_RATIO, Math.max(FileManagerApp.#MIN_RATIO, ratio));
            this.#applyRatio();
        });
        const finish = (/** @type {PointerEvent} */ event) => {
            if (splitter.hasPointerCapture(event.pointerId)) {
                splitter.releasePointerCapture(event.pointerId);
            }
            splitter.classList.remove('dragging');
            this.#scheduleSave();
        };
        splitter.addEventListener('pointerup', finish);
        splitter.addEventListener('pointercancel', finish);
    }

    /**
     * Ctrl+wheel scales the tables, one pixel of font size per step, as it does in the editor.
     * @param {WheelEvent} event
     */
    #onWheel(event) {
        if (!this.#panels || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
            return;
        }
        event.preventDefault();
        const delta = event.deltaY;
        if (delta === 0) {
            return;
        }
        const editorFontSize = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-size');
        const baseSize = parseFloat(editorFontSize) || FileManagerApp.#FALLBACK_FONT_SIZE;
        const next = this.#fontSizeDelta + (delta < 0 ? 1 : -1);
        const size = baseSize + next;
        if (size < FileManagerApp.#MIN_FONT_SIZE || size > FileManagerApp.#MAX_FONT_SIZE) {
            return;
        }
        this.#fontSizeDelta = next;
        this.#applyFontSize();
        this.#scheduleSave();
    }

    #applyFontSize() {
        document.documentElement.style.setProperty(
            '--table-font-size',
            `calc(var(--vscode-editor-font-size) + ${this.#fontSizeDelta}px)`,
        );
        this.#panels?.left.updateScale();
        this.#panels?.right.updateScale();
    }

    /**
     * The ratio shares the width without the splitter, so 0.5 gives both panels exactly the same width.
     */
    #applyRatio() {
        this.#slot('left').style.flexBasis = `calc((100% - var(--splitter-width)) * ${this.#ratio})`;
    }

    /**
     * @param {'left' | 'right'} side
     * @returns {HTMLElement}
     */
    #slot(side) {
        return /** @type {HTMLElement} */ (this.#root.querySelector(`.panel-slot.${side}`));
    }

    #rerenderIcons() {
        this.#panels?.left.rerenderIcons();
        this.#panels?.right.rerenderIcons();
    }

    #scheduleSave() {
        if (this.#saveTimer) {
            clearTimeout(this.#saveTimer);
        }
        this.#saveTimer = setTimeout(() => {
            this.#saveTimer = null;
            if (!this.#panels) {
                return;
            }
            /** @type {AppViewState} */
            const state = {
                ratio: this.#ratio,
                fontSizeDelta: this.#fontSizeDelta,
                hideExtension: this.#hideExtension,
                active: this.#active,
                panels: { left: this.#panels.left.viewState, right: this.#panels.right.viewState },
                paths: { left: this.#panels.left.path, right: this.#panels.right.path },
            };
            this.#api.setState(state);
            this.#api.postMessage({ type: 'saveViewState', state });
        }, FileManagerApp.#SAVE_DELAY_MS);
    }
}
