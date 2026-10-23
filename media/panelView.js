// @ts-check
'use strict';

/**
 * @typedef {object} Entry
 * @property {string} name
 * @property {boolean} isDir
 * @property {boolean} isLink
 * @property {boolean} isBrokenLink
 * @property {number | null} size
 * @property {number | null} mtime
 * @property {number | null} birthtime
 * @property {number | null} atime
 * @property {number | null} mode
 * @property {number | null} winAttributes
 * @property {boolean} hidden
 * @property {{ label: string, type: string, ready: boolean, free: number | null } | null} drive
 */

/**
 * @typedef {object} Listing
 * @property {string} path
 * @property {string | null} parent
 * @property {Entry[]} entries
 * @property {string | null} focusName
 * @property {boolean} isNewFolder
 * @property {boolean} [archive]  a folder inside an archive: shown, never changed
 */

/**
 * @typedef {object} Row
 * @property {string} name
 * @property {boolean} isParent
 * @property {boolean} isDir
 * @property {string} base
 * @property {string} extension
 * @property {Entry | null} entry
 */

/**
 * @typedef {object} FolderSize
 * @property {number} bytes
 * @property {number} skippedFolders
 * @property {boolean} done
 */

/**
 * @typedef {'name' | 'ext' | 'size' | 'date' | 'attrs'} SortKey
 * @typedef {'mtime' | 'birthtime' | 'atime'} DateKind
 * @typedef {'units' | 'bytes'} SizeMode
 */

/**
 * @typedef {object} PanelViewState
 * @property {SortKey} sortKey
 * @property {boolean} sortDescending
 * @property {DateKind} dateKind
 * @property {SizeMode} sizeMode
 * @property {boolean} showHidden
 * @property {Partial<Record<ResizableColumn, number>>} columnWidths  set by hand, in ch without cell padding
 */

/**
 * @typedef {'ext' | 'size' | 'date' | 'attrs'} ResizableColumn
 */

/**
 * @typedef {object} ColumnDrag
 * @property {ResizableColumn} column
 * @property {number} direction  1 when the line is the column's right edge, -1 when it is its left edge
 * @property {number} startX
 * @property {number} startPx
 * @property {number} pxPerCh
 */

/** @typedef {'name' | 'project' | 'absolute'} TerminalPathKind */

/**
 * @typedef {object} PanelCallbacks
 * @property {(path: string, focusName: string | null) => void} navigate
 * @property {(name: string, asFile?: boolean) => void} openFile
 * @property {(name: string, pathKind: TerminalPathKind) => void} pasteToTerminal
 * @property {(names: string[]) => void} countFolderSizes
 * @property {() => void} cancelFolderSizes
 * @property {() => void} activate
 * @property {() => void} viewStateChanged
 * @property {(action: OperationAction, modifiers: { shiftKey: boolean }) => void} operation
 * @property {(names: string[], event: MouseEvent) => void} beginDrag
 * @property {(cursorName: string | null) => void} revealInOs
 * @property {() => void} help
 */

/**
 * One panel: toolbar, path, column header, the list and the status line under it. Holds what the user does with
 * the list — cursor, selection, sorting — and asks the host for everything that touches the file system.
 */
class PanelView {
    static #DATE_KINDS = /** @type {const} */ (['mtime', 'birthtime', 'atime']);
    static #SORT_KEYS = /** @type {const} */ (['name', 'ext', 'size', 'date', 'attrs']);
    static #COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    static #ERROR_VISIBLE_MS = 6000;
    static #DOUBLE_CLICK_MS = 500;
    static #LOADING_DELAY_MS = 150;
    static #PENDING_FOCUS_MS = 3000;
    static #EXTENSION_HEADER_LENGTH = 3;
    /** "KB" button with its frame and gap, then "Size" */
    static #SIZE_HEADER_LENGTH = 8;
    static #EXTENSION_MAX_LENGTH = 12;
    /** @type {readonly ResizableColumn[]} */
    static #RESIZABLE_COLUMNS = ['ext', 'size', 'date', 'attrs'];
    static #COLUMN_MIN_CH = 1;
    static #COLUMN_MAX_CH = 80;
    /** "2026-10-16 20:41" */
    static #DATE_DEFAULT_CH = 17;
    /** "drwxr-xr-x" */
    static #ATTRIBUTES_DEFAULT_CH = 11;
    /** " ▲" after the sorted column's label */
    static #SORT_MARK_LENGTH = 2;
    /** the cell's left border and rounding of ch to whole pixels */
    static #COLUMN_EXTRA_PX = 3;
    /** 0.5ch on each side of a cell */
    static #CELL_PADDING_CH = 1;

    #callbacks;
    #icons;
    #platform;
    #root;
    /** @type {HTMLInputElement} */
    #pathInput;
    /** @type {HTMLElement} */
    #breadcrumbs;
    /** @type {HTMLElement} */
    #header;
    /** @type {HTMLElement} */
    #viewport;
    /** @type {HTMLElement} */
    #spacer;
    /** @type {HTMLElement} */
    #rowsLayer;
    /** @type {HTMLElement} */
    #statusCounts;
    /** @type {HTMLElement} */
    #statusSizes;
    /** @type {HTMLElement} */
    #statusError;
    /** @type {HTMLButtonElement} */
    #hiddenToggle;
    /** @type {HTMLSelectElement} */
    #dateSelect;
    /** @type {HTMLButtonElement} */
    #sizeModeButton;

    /** @type {string | null} */
    #path = null;
    /** @type {string | null} */
    #parent = null;
    /** @type {Entry[]} */
    #entries = [];
    /** @type {Row[]} */
    #rows = [];
    #cursor = 0;
    /** @type {Set<string>} */
    #selected = new Set();
    /** @type {Map<string, FolderSize>} */
    #folderSizes = new Map();
    #active = false;
    #rowHeight = 20;
    /** @type {ReturnType<typeof setTimeout> | null} */
    #errorTimer = null;
    /** @type {{ index: number, at: number } | null} */
    #lastRowClick = null;
    /** @type {{ index: number, pathKind: TerminalPathKind, at: number } | null} */
    #lastTerminalClick = null;
    /** @type {{ name: string, path: string }[]} */
    #workspaceFolders = [];
    /** @type {HTMLElement | null} */
    #menu = null;
    /** @type {((event: MouseEvent) => void) | null} */
    #closeMenuListener = null;
    /** @type {string | null} */
    #selectionAnchor = null;
    /** @type {{ name: string, until: number } | null} */
    #pendingFocus = null;
    #clearSelectionOnRelease = false;
    #revealAvailable = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    #loadingTimer = null;
    /** @type {HTMLElement} */
    #loadingText;
    #inArchive = false;
    /** @type {string | null} */
    #dropFolderName = null;

    /** @type {PanelViewState} */
    #state = {
        sortKey: 'name',
        sortDescending: false,
        dateKind: 'mtime',
        sizeMode: 'units',
        showHidden: true,
        columnWidths: {},
    };

    /**
     * @param {HTMLElement} container
     * @param {PanelCallbacks} callbacks
     * @param {IconResolver} icons
     * @param {{ kind: 'win' | 'linux' | 'mac', isWsl: boolean, home: string }} platform
     */
    constructor(container, callbacks, icons, platform) {
        this.#callbacks = callbacks;
        this.#icons = icons;
        this.#platform = platform;
        this.#root = document.createElement('section');
        this.#root.className = 'panel';
        this.#root.innerHTML = PanelView.#template();
        this.#root.prepend(new ToolbarView().element);
        container.appendChild(this.#root);

        this.#pathInput = this.#query('.path-input');
        this.#breadcrumbs = this.#query('.breadcrumbs');
        this.#header = this.#query('.list-header');
        this.#viewport = this.#query('.viewport');
        this.#spacer = this.#query('.spacer');
        this.#rowsLayer = this.#query('.rows');
        this.#statusCounts = this.#query('.status-counts');
        this.#statusSizes = this.#query('.status-sizes');
        this.#statusError = this.#query('.status-error');
        this.#hiddenToggle = this.#query('[data-action="hidden"]');
        this.#dateSelect = this.#query('.date-kind');
        this.#sizeModeButton = this.#query('.size-mode');
        this.#loadingText = this.#query('.loading-text');

        this.#bindEvents();
        this.#measureRowHeight();
        this.#applyStateToControls();
    }

    /**
     * @returns {HTMLElement}
     */
    get element() {
        return this.#root;
    }

    /**
     * @returns {string | null}
     */
    get path() {
        return this.#path;
    }

    /**
     * @returns {PanelViewState}
     */
    get viewState() {
        return { ...this.#state, columnWidths: { ...this.#state.columnWidths } };
    }

    /**
     * @param {Partial<PanelViewState> | null | undefined} state
     */
    applyViewState(state) {
        if (!state) {
            return;
        }
        if (PanelView.#SORT_KEYS.includes(/** @type {SortKey} */ (state.sortKey))) {
            this.#state.sortKey = /** @type {SortKey} */ (state.sortKey);
        }
        if (PanelView.#DATE_KINDS.includes(/** @type {DateKind} */ (state.dateKind))) {
            this.#state.dateKind = /** @type {DateKind} */ (state.dateKind);
        }
        this.#state.sortDescending = state.sortDescending === true;
        this.#state.sizeMode = state.sizeMode === 'bytes' ? 'bytes' : 'units';
        this.#state.showHidden = state.showHidden !== false;
        this.#state.columnWidths = {};
        for (const column of PanelView.#RESIZABLE_COLUMNS) {
            const width = state.columnWidths?.[column];
            if (typeof width === 'number' && width >= PanelView.#COLUMN_MIN_CH && width <= PanelView.#COLUMN_MAX_CH) {
                this.#state.columnWidths[column] = width;
            }
        }
        this.#applyStateToControls();
        this.#rebuildRows(this.#currentName());
    }

    /**
     * @param {boolean} active
     */
    setActive(active) {
        this.#active = active;
        this.#root.classList.toggle('active', active);
        if (active && document.activeElement !== this.#pathInput) {
            this.#viewport.focus({ preventScroll: true });
        }
        this.#renderRows();
    }

    /**
     * @param {Listing} listing
     */
    setListing(listing) {
        const focusName = listing.isNewFolder ? listing.focusName : this.#currentName();
        const previousCursor = this.#cursor;
        this.#stopLoading();
        this.#path = listing.path;
        this.#parent = listing.parent;
        this.#inArchive = listing.archive === true;
        this.#entries = listing.entries;
        const names = new Set(listing.entries.map((entry) => entry.name));
        if (listing.isNewFolder) {
            this.#selected.clear();
            this.#folderSizes.clear();
            this.#selectionAnchor = null;
        } else {
            this.#retainNames(this.#selected, names);
            for (const name of [...this.#folderSizes.keys()]) {
                if (!names.has(name)) {
                    this.#folderSizes.delete(name);
                }
            }
        }
        this.#showPath();
        this.#clearError();
        this.#rebuildRows(focusName, listing.isNewFolder ? 0 : previousCursor);
        this.#applyPendingFocus();
        this.#updateRevealButton();
    }

    /**
     * Ctrl+Alt+Enter, which comes as a keybinding: VS Code gives it to Replace All of the Search view, and a key the
     * webview handles still reaches VS Code.
     * @param {TerminalPathKind} pathKind
     */
    pasteCursorToTerminal(pathKind) {
        this.#pasteToTerminal(this.#cursor, pathKind);
    }

    /**
     * F4: the file under the cursor in an editor tab, an archive included; folders are left alone.
     */
    openCursorFileInEditor() {
        const row = this.#rows[this.#cursor];
        if (row && !row.isDir && !row.isParent && !this.#inArchive) {
            this.#callbacks.openFile(row.name, true);
        }
    }

    /**
     * Whether file operations make sense here: a folder is open, not the drive list.
     * @returns {boolean}
     */
    get canOperate() {
        return this.#path !== null && this.#path !== '' && !this.#inArchive;
    }

    /**
     * What an operation works on: the selection in list order, or else the entry under the cursor.
     * @returns {string[]}
     */
    get operationNames() {
        if (!this.canOperate) {
            return [];
        }
        const selected = this.#rows.filter((row) => this.#selected.has(row.name)).map((row) => row.name);
        if (selected.length > 0) {
            return selected;
        }
        const cursorEntry = this.cursorEntry;
        return cursorEntry ? [cursorEntry.name] : [];
    }

    /**
     * The entries of operationNames with what the attributes dialog needs to know of them.
     * @returns {{ name: string, isDir: boolean, mode: number | null, winAttributes: number | null }[]}
     */
    get operationEntries() {
        const names = new Set(this.operationNames);
        return this.#rows
            .filter((row) => names.has(row.name) && row.entry !== null)
            .map((row) => {
                const entry = /** @type {Entry} */ (row.entry);
                return { name: row.name, isDir: row.isDir, mode: entry.mode, winAttributes: entry.winAttributes };
            });
    }

    /**
     * @returns {{ name: string, isDir: boolean } | null}
     */
    get cursorEntry() {
        const row = this.#rows[this.#cursor];
        return this.canOperate && PanelView.#isSelectable(row) ? { name: row.name, isDir: row.isDir } : null;
    }

    /**
     * Puts the cursor on an entry; one that is not listed yet gets it when the watcher brings it.
     * @param {string} name
     */
    focusEntry(name) {
        this.#pendingFocus = { name, until: Date.now() + PanelView.#PENDING_FOCUS_MS };
        this.#applyPendingFocus();
    }

    /**
     * @param {string[]} names
     */
    deselect(names) {
        for (const name of names) {
            this.#selected.delete(name);
        }
        this.#renderRows();
        this.#renderStatus();
    }

    focus() {
        this.#viewport.focus({ preventScroll: true });
    }

    #applyPendingFocus() {
        const pending = this.#pendingFocus;
        if (!pending) {
            return;
        }
        if (Date.now() > pending.until) {
            this.#pendingFocus = null;
            return;
        }
        const index = this.#rows.findIndex((row) => row.name === pending.name);
        if (index !== -1) {
            this.#pendingFocus = null;
            this.#moveCursor(index);
        }
    }

    /**
     * @param {{ path: string, name: string, bytes: number, skippedFolders: number, done: boolean }} size
     */
    setFolderSize(size) {
        if (size.path !== this.#path) {
            return;
        }
        this.#folderSizes.set(size.name, { bytes: size.bytes, skippedFolders: size.skippedFolders, done: size.done });
        if (this.#state.sortKey === 'size' && size.done) {
            this.#rebuildRows(this.#currentName());
        } else {
            this.#fitColumnWidths();
            this.#renderRows();
            this.#renderStatus();
        }
    }

    folderSizesCancelled() {
        for (const [name, size] of [...this.#folderSizes]) {
            if (!size.done) {
                this.#folderSizes.delete(name);
            }
        }
        this.#renderRows();
        this.#renderStatus();
    }

    /**
     * @param {string} message
     */
    showError(message) {
        this.#stopLoading();
        this.#statusError.textContent = message;
        this.#statusError.title = message;
        this.#root.classList.add('has-error');
        if (this.#errorTimer) {
            clearTimeout(this.#errorTimer);
        }
        this.#errorTimer = setTimeout(() => this.#clearError(), PanelView.#ERROR_VISIBLE_MS);
        if (this.#path !== null) {
            this.#showPath();
        }
    }

    /**
     * The host says what takes long — reading an archive — and the spinner shows it once it appears.
     * @param {string} message
     */
    showLoading(message) {
        this.#loadingText.textContent = message;
    }

    rerenderIcons() {
        this.#renderRows();
    }

    /**
     * Row height follows the table font size; called after the scale changes.
     */
    updateScale() {
        const cursorName = this.#currentName();
        this.#measureRowHeight();
        this.#rebuildRows(cursorName);
    }

    /**
     * Keys of the list. Returns false for keys the panel does not handle, so they reach VS Code.
     * @param {KeyboardEvent} event
     * @returns {boolean}
     */
    handleKey(event) {
        if (this.#menu) {
            if (event.key === 'Escape') {
                this.#closeMenu();
                return true;
            }
        }
        const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
        const pathKind = PanelView.#terminalPathKind(event);
        if (event.key === 'Enter' && (pathKind === 'name' || pathKind === 'project')) {
            this.#pasteToTerminal(this.#cursor, pathKind);
            return true;
        }
        if (event.key === 'Enter' && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
            this.#countAllFolderSizes();
            return true;
        }
        if (!plain) {
            return false;
        }
        const page = Math.max(1, Math.floor(this.#viewport.clientHeight / this.#rowHeight) - 1);
        switch (event.key) {
            case 'ArrowUp':
                this.#moveCursor(this.#cursor - 1);
                return true;
            case 'ArrowDown':
                this.#moveCursor(this.#cursor + 1);
                return true;
            case 'PageUp':
                this.#moveCursor(this.#cursor - page);
                return true;
            case 'PageDown':
                this.#moveCursor(this.#cursor + page);
                return true;
            case 'Home':
                this.#moveCursor(0);
                return true;
            case 'End':
                this.#moveCursor(this.#rows.length - 1);
                return true;
            case 'Enter':
                if (!event.shiftKey) {
                    this.#openRow(this.#rows[this.#cursor]);
                    return true;
                }
                return false;
            case 'Backspace':
                this.#goToParent();
                return true;
            case 'Insert':
                this.#toggleSelection(this.#cursor);
                this.#moveCursor(this.#cursor + 1);
                return true;
            case ' ':
                this.#toggleSelectionAndCount();
                return true;
            case 'Escape':
                this.#callbacks.cancelFolderSizes();
                return true;
            case 'Delete':
                this.#callbacks.operation('delete', { shiftKey: event.shiftKey });
                return true;
        }
        return false;
    }

    #bindEvents() {
        this.#root.addEventListener('mousedown', () => this.#callbacks.activate());
        this.#query('.toolbar').addEventListener('click', (event) => {
            const target = /** @type {HTMLElement} */ (event.target);
            const button = /** @type {HTMLElement | null} */ (target.closest('[data-action]'));
            if (button?.dataset.operation) {
                this.#callbacks.operation(
                    /** @type {OperationAction} */ (button.dataset.operation),
                    { shiftKey: /** @type {MouseEvent} */ (event).shiftKey },
                );
            } else if (button) {
                this.#runToolbarAction(String(button.dataset.action));
            }
        });
        this.#breadcrumbs.addEventListener('click', (event) => this.#onBreadcrumbClick(event));
        this.#pathInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.#navigate(this.#pathInput.value, null);
                this.#viewport.focus();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.#viewport.focus();
            }
            event.stopPropagation();
        });
        this.#pathInput.addEventListener('blur', () => {
            this.#root.classList.remove('editing-path');
            this.#showPath();
        });
        this.#header.addEventListener('click', (event) => {
            const target = /** @type {HTMLElement} */ (event.target);
            if (target.closest('select, button, .column-grip')) {
                return;
            }
            const cell = /** @type {HTMLElement | null} */ (target.closest('[data-sort]'));
            if (cell) {
                this.#sortBy(/** @type {SortKey} */ (cell.dataset.sort));
            }
        });
        this.#bindColumnGrips();
        this.#dateSelect.addEventListener('change', () => {
            this.#state.dateKind = /** @type {DateKind} */ (this.#dateSelect.value);
            this.#rebuildRows(this.#currentName());
            this.#callbacks.viewStateChanged();
            this.#viewport.focus();
        });
        this.#sizeModeButton.addEventListener('click', () => {
            this.#state.sizeMode = this.#state.sizeMode === 'units' ? 'bytes' : 'units';
            this.#applyStateToControls();
            this.#fitColumnWidths();
            this.#renderRows();
            this.#renderStatus();
            this.#callbacks.viewStateChanged();
            this.#viewport.focus();
        });
        this.#viewport.addEventListener('scroll', () => this.#renderRows());
        new ResizeObserver(() => {
            this.#root.style.setProperty(
                '--scrollbar-width',
                `${this.#viewport.offsetWidth - this.#viewport.clientWidth}px`,
            );
            this.#renderRows();
        }).observe(this.#viewport);
        this.#rowsLayer.addEventListener('mousedown', (event) => this.#onRowMouseDown(event));
    }

    /**
     * Click on the icon or Ctrl+click toggles one row and keeps the rest; Shift+click selects from the last clicked
     * row, Ctrl+Shift+click adds that range; a plain click clears the selection. On macOS ⌘ stands for Ctrl.
     * Double click is recognised here rather than by the dblclick event: the first click re-renders the rows, and the
     * browser does not report a dblclick across two different elements.
     * @param {MouseEvent} event
     */
    #onRowMouseDown(event) {
        if (event.button !== 0) {
            return;
        }
        const target = /** @type {HTMLElement} */ (event.target);
        const index = this.#rowIndexOf(target);
        if (index === null) {
            return;
        }
        event.preventDefault();
        this.#viewport.focus({ preventScroll: true });
        this.#detectTerminalDoubleClick(event, index);
        const toggleKey = Keys.command(event);
        const onSelectableIcon = target.closest('.icon') !== null && PanelView.#isSelectable(this.#rows[index]);
        if (onSelectableIcon || (toggleKey && !event.shiftKey)) {
            this.#lastRowClick = null;
            this.#selectionAnchor = this.#rows[index]?.name ?? null;
            this.#toggleSelection(index);
            this.#moveCursor(index);
            return;
        }
        if (event.shiftKey) {
            this.#lastRowClick = null;
            this.#selectRange(index, toggleKey);
            this.#moveCursor(index);
            return;
        }
        const row = this.#rows[index];
        this.#selectionAnchor = row?.name ?? null;
        const pressedSelected = row !== undefined && this.#selected.has(row.name);
        const dragNames = PanelView.#isSelectable(row) && this.canOperate
            ? (pressedSelected ? this.operationNames : [row.name])
            : [];
        this.#clearSelectionOnRelease = pressedSelected;
        if (!pressedSelected) {
            this.#clearSelection();
        }
        const now = Date.now();
        const isDoubleClick = this.#lastRowClick !== null
            && this.#lastRowClick.index === index
            && now - this.#lastRowClick.at <= PanelView.#DOUBLE_CLICK_MS;
        this.#lastRowClick = isDoubleClick ? null : { index, at: now };
        this.#moveCursor(index);
        if (isDoubleClick) {
            this.#clearSelectionOnRelease = false;
            this.#openRow(row);
        } else if (dragNames.length > 0) {
            this.#callbacks.beginDrag(dragNames, event);
        }
    }

    /**
     * Ctrl+double-click, alone or with Shift or Alt, puts the entry into the terminal. It only adds to the presses:
     * each of the two is still an ordinary Ctrl+click.
     * @param {MouseEvent} event
     * @param {number} index
     */
    #detectTerminalDoubleClick(event, index) {
        const pathKind = PanelView.#terminalPathKind(event);
        const at = Date.now();
        const first = this.#lastTerminalClick;
        const isDoubleClick = pathKind !== null && first !== null && first.index === index
            && first.pathKind === pathKind && at - first.at <= PanelView.#DOUBLE_CLICK_MS;
        this.#lastTerminalClick = pathKind === null || isDoubleClick ? null : { index, pathKind, at };
        if (isDoubleClick) {
            this.#pasteToTerminal(index, pathKind);
        }
    }

    /**
     * Ctrl+Enter and Ctrl+double-click: by name; with Shift, by path from the project folder; with Alt, by absolute
     * path.
     * @param {MouseEvent | KeyboardEvent} event
     * @returns {TerminalPathKind | null}
     */
    static #terminalPathKind(event) {
        if (!Keys.command(event) || Keys.unused(event) || (event.shiftKey && event.altKey)) {
            return null;
        }
        if (event.altKey) {
            return 'absolute';
        }
        return event.shiftKey ? 'project' : 'name';
    }

    /**
     * @param {number} index
     * @param {TerminalPathKind} pathKind
     */
    #pasteToTerminal(index, pathKind) {
        const row = this.#rows[index];
        if (row && this.canOperate) {
            this.#callbacks.pasteToTerminal(row.name, pathKind);
        }
    }

    /**
     * A press on a selected row keeps the selection while it may still become a drag of the whole selection.
     */
    dragStarted() {
        this.#clearSelectionOnRelease = false;
        this.#lastRowClick = null;
    }

    /**
     * The press ended without a drag: a plain click on a selected row clears the selection after all.
     */
    clickReleased() {
        if (this.#clearSelectionOnRelease) {
            this.#clearSelectionOnRelease = false;
            this.#clearSelection();
        }
    }

    /**
     * Where entries dropped at this point go: into the folder row under it, otherwise into this panel's folder —
     * the ".." row and file rows included.
     * @param {number} clientX
     * @param {number} clientY
     * @returns {DropTarget | null}
     */
    dropTargetAt(clientX, clientY) {
        if (!this.canOperate) {
            return null;
        }
        const element = document.elementFromPoint(clientX, clientY);
        const rowElement = /** @type {HTMLElement | null} */ (element?.closest('.row') ?? null);
        const row = rowElement && this.#rowsLayer.contains(rowElement)
            ? this.#rows[Number(rowElement.dataset.index)]
            : null;
        if (row && row.isDir && !row.isParent && !row.entry?.drive) {
            return { path: this.#childPath(row.name), folderName: row.name };
        }
        return { path: /** @type {string} */ (this.#path), folderName: null };
    }

    /**
     * @param {DropTarget | null} target
     */
    showDropTarget(target) {
        const folderName = target?.folderName ?? null;
        const wholePanel = target !== null && folderName === null;
        if (folderName === this.#dropFolderName && wholePanel === this.#root.classList.contains('drop-panel')) {
            return;
        }
        this.#dropFolderName = folderName;
        this.#root.classList.toggle('drop-panel', wholePanel);
        this.#renderRows();
    }

    /**
     * @param {string} action
     */
    #runToolbarAction(action) {
        switch (action) {
            case 'parent':
                this.#goToParent();
                break;
            case 'home':
                this.#navigate(this.#platform.home, null);
                break;
            case 'project':
                this.#openProjectFolder();
                return;
            case 'reveal':
                this.#callbacks.revealInOs(this.#currentName());
                break;
            case 'help':
                this.#callbacks.help();
                return;
            case 'root':
                this.#navigate(this.#platform.kind === 'win' ? '' : '/', null);
                break;
            case 'hidden':
                this.#state.showHidden = !this.#state.showHidden;
                this.#applyStateToControls();
                this.#rebuildRows(this.#currentName());
                this.#callbacks.viewStateChanged();
                break;
        }
        this.#viewport.focus();
    }

    /**
     * @param {boolean} available  whether this VS Code can reach a system file manager at all
     */
    setRevealAvailable(available) {
        this.#revealAvailable = available;
        this.#updateRevealButton();
    }

    #updateRevealButton() {
        this.#query('[data-action="reveal"]').toggleAttribute('disabled', !this.#revealAvailable || !this.canOperate);
        for (const button of this.#root.querySelectorAll('[data-operation]')) {
            button.toggleAttribute('disabled', !this.canOperate);
        }
        this.#root.classList.toggle('in-archive', this.#inArchive);
    }

    /**
     * @param {{ name: string, path: string }[]} folders
     */
    setWorkspaceFolders(folders) {
        this.#workspaceFolders = folders;
        const button = this.#query('[data-action="project"]');
        button.toggleAttribute('disabled', folders.length === 0);
        button.title = folders.length === 1
            ? I18n.t('toolbar.projectPath', { path: folders[0].path })
            : I18n.t('toolbar.projects');
        this.#closeMenu();
    }

    /**
     * One workspace folder opens at once; several are offered in a list under the button.
     */
    #openProjectFolder() {
        if (this.#workspaceFolders.length === 1) {
            this.#navigate(this.#workspaceFolders[0].path, null);
            this.#viewport.focus();
            return;
        }
        if (this.#workspaceFolders.length === 0 || this.#menu) {
            this.#closeMenu();
            return;
        }
        const button = this.#query('[data-action="project"]');
        const menu = document.createElement('div');
        menu.className = 'menu';
        for (const folder of this.#workspaceFolders) {
            const item = document.createElement('button');
            item.type = 'button';
            item.tabIndex = -1;
            item.className = 'menu-item';
            item.textContent = folder.name;
            item.title = folder.path;
            item.addEventListener('click', () => {
                this.#closeMenu();
                this.#navigate(folder.path, null);
                this.#viewport.focus();
            });
            menu.appendChild(item);
        }
        const panelBounds = this.#root.getBoundingClientRect();
        const buttonBounds = button.getBoundingClientRect();
        menu.style.left = `${buttonBounds.left - panelBounds.left}px`;
        menu.style.top = `${buttonBounds.bottom - panelBounds.top}px`;
        this.#root.appendChild(menu);
        this.#menu = menu;
        const closeOnOutsideClick = (/** @type {MouseEvent} */ event) => {
            const target = /** @type {Node} */ (event.target);
            if (!menu.contains(target) && !button.contains(target)) {
                this.#closeMenu();
            }
        };
        document.addEventListener('mousedown', closeOnOutsideClick, true);
        this.#closeMenuListener = closeOnOutsideClick;
    }

    #closeMenu() {
        this.#menu?.remove();
        this.#menu = null;
        if (this.#closeMenuListener) {
            document.removeEventListener('mousedown', this.#closeMenuListener, true);
            this.#closeMenuListener = null;
        }
    }

    /**
     * @param {SortKey} key
     */
    #sortBy(key) {
        if (this.#state.sortKey === key) {
            this.#state.sortDescending = !this.#state.sortDescending;
        } else {
            this.#state.sortKey = key;
            this.#state.sortDescending = false;
        }
        this.#applyStateToControls();
        this.#rebuildRows(this.#currentName());
        this.#callbacks.viewStateChanged();
    }

    /**
     * @param {string | null} focusName
     * @param {number} [fallbackIndex]
     */
    #rebuildRows(focusName, fallbackIndex = this.#cursor) {
        const visible = this.#state.showHidden ? this.#entries : this.#entries.filter((entry) => !entry.hidden);
        if (!this.#state.showHidden) {
            this.#retainNames(this.#selected, new Set(visible.map((entry) => entry.name)));
        }
        /** @type {Row[]} */
        const rows = visible.map((entry) => {
            const { base, extension } = entry.drive
                ? { base: entry.name, extension: entry.drive.label }
                : Format.splitName(entry.name, entry.isDir);
            return { name: entry.name, isParent: false, isDir: entry.isDir, base, extension, entry };
        });
        rows.sort((a, b) => this.#compareRows(a, b));
        if (this.#parent !== null) {
            rows.unshift({ name: '..', isParent: true, isDir: true, base: '..', extension: '', entry: null });
        }
        this.#rows = rows;
        const focusIndex = focusName === null ? -1 : rows.findIndex((row) => row.name === focusName);
        const clampedFallback = Math.min(Math.max(0, fallbackIndex), Math.max(0, rows.length - 1));
        this.#cursor = focusIndex !== -1 ? focusIndex : clampedFallback;
        this.#spacer.style.height = `${rows.length * this.#rowHeight}px`;
        this.#scrollCursorIntoView();
        this.#fitColumnWidths();
        this.#renderRows();
        this.#renderStatus();
    }

    /**
     * Extension and size columns as wide as their longest value in the whole folder, not only in the visible rows;
     * the table font is monospaced, so the width is exact in ch. The header label sets the minimum.
     */
    #fitColumnWidths() {
        let extensionLength = 0;
        let sizeLength = 0;
        for (const row of this.#rows) {
            extensionLength = Math.max(extensionLength, row.extension.length);
            sizeLength = Math.max(sizeLength, this.#sizeText(row).length);
        }
        const sortMark = (/** @type {SortKey} */ key) => (
            this.#state.sortKey === key ? PanelView.#SORT_MARK_LENGTH : 0
        );
        const extensionMinimum = PanelView.#EXTENSION_HEADER_LENGTH + sortMark('ext');
        const sizeMinimum = PanelView.#SIZE_HEADER_LENGTH + sortMark('size');
        const manual = this.#state.columnWidths;
        /** @type {Record<ResizableColumn, number>} */
        const widths = {
            ext: manual.ext ?? Math.min(PanelView.#EXTENSION_MAX_LENGTH, Math.max(extensionMinimum, extensionLength)),
            size: manual.size ?? Math.max(sizeMinimum, sizeLength),
            date: manual.date ?? PanelView.#DATE_DEFAULT_CH,
            attrs: manual.attrs ?? PanelView.#ATTRIBUTES_DEFAULT_CH,
        };
        for (const column of PanelView.#RESIZABLE_COLUMNS) {
            this.#root.style.setProperty(
                PanelView.#widthProperty(column),
                `calc(${widths[column] + PanelView.#CELL_PADDING_CH}ch + ${PanelView.#COLUMN_EXTRA_PX}px)`,
            );
        }
    }

    /**
     * Dragging the line between two header cells moves it. The name column takes what is left, so the line after
     * it resizes the extension column, and every other line resizes the column to its left. A double click on the
     * line gives the column back its automatic width.
     */
    #bindColumnGrips() {
        /** @type {ColumnDrag | null} */
        let drag = null;
        this.#header.addEventListener('pointerdown', (event) => {
            const grip = PanelView.#gripOf(event);
            if (!grip || event.button !== 0) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            const column = /** @type {ResizableColumn} */ (grip.dataset.resizes);
            const cell = /** @type {HTMLElement} */ (this.#header.querySelector(`.col-${column}`));
            const startPx = cell.getBoundingClientRect().width;
            const currentCh = parseFloat(
                this.#root.style.getPropertyValue(PanelView.#widthProperty(column)).replace(/^calc\(/, ''),
            );
            drag = {
                column,
                direction: Number(grip.dataset.direction),
                startX: event.clientX,
                startPx,
                pxPerCh: currentCh > 0 ? (startPx - PanelView.#COLUMN_EXTRA_PX) / currentCh : startPx,
            };
            grip.setPointerCapture(event.pointerId);
            grip.classList.add('dragging');
        });
        this.#header.addEventListener('pointermove', (event) => {
            if (!drag) {
                return;
            }
            const widthPx = drag.startPx + drag.direction * (event.clientX - drag.startX);
            const contentCh = (widthPx - PanelView.#COLUMN_EXTRA_PX) / drag.pxPerCh - PanelView.#CELL_PADDING_CH;
            const clamped = Math.min(PanelView.#COLUMN_MAX_CH, Math.max(PanelView.#COLUMN_MIN_CH, contentCh));
            this.#state.columnWidths[drag.column] = Math.round(clamped * 10) / 10;
            this.#fitColumnWidths();
        });
        const finish = (/** @type {PointerEvent} */ event) => {
            if (!drag) {
                return;
            }
            drag = null;
            const grip = /** @type {HTMLElement} */ (event.target);
            if (grip.hasPointerCapture?.(event.pointerId)) {
                grip.releasePointerCapture(event.pointerId);
            }
            grip.classList.remove('dragging');
            this.#callbacks.viewStateChanged();
        };
        this.#header.addEventListener('pointerup', finish);
        this.#header.addEventListener('pointercancel', finish);
        this.#header.addEventListener('dblclick', (event) => {
            const grip = PanelView.#gripOf(event);
            if (!grip) {
                return;
            }
            delete this.#state.columnWidths[/** @type {ResizableColumn} */ (grip.dataset.resizes)];
            this.#fitColumnWidths();
            this.#callbacks.viewStateChanged();
        });
    }

    /**
     * @param {Event} event
     * @returns {HTMLElement | null}
     */
    static #gripOf(event) {
        return /** @type {HTMLElement | null} */ ((/** @type {HTMLElement} */ (event.target)).closest('.column-grip'));
    }

    /**
     * @param {ResizableColumn} column
     * @returns {string}
     */
    static #widthProperty(column) {
        return `--${column}-width`;
    }

    /**
     * Folders before files whatever the order; inside each group by the sort key, then by name.
     * @param {Row} a
     * @param {Row} b
     * @returns {number}
     */
    #compareRows(a, b) {
        if (a.isDir !== b.isDir) {
            return a.isDir ? -1 : 1;
        }
        const direction = this.#state.sortDescending ? -1 : 1;
        const byName = PanelView.#COLLATOR.compare(a.name, b.name);
        let result = 0;
        switch (this.#state.sortKey) {
            case 'ext':
                result = PanelView.#COLLATOR.compare(a.extension, b.extension);
                break;
            case 'size':
                result = this.#sortableSize(a) - this.#sortableSize(b);
                break;
            case 'date':
                result = (a.entry?.[this.#state.dateKind] ?? -1) - (b.entry?.[this.#state.dateKind] ?? -1);
                break;
            case 'attrs':
                result = this.#attributesText(a).localeCompare(this.#attributesText(b));
                break;
        }
        return (result || byName) * direction;
    }

    /**
     * @param {Row} row
     * @returns {number}
     */
    #sortableSize(row) {
        if (row.isDir && !row.entry?.drive) {
            return this.#folderSizes.get(row.name)?.bytes ?? -1;
        }
        return row.entry?.size ?? -1;
    }

    #renderRows() {
        const height = this.#viewport.clientHeight;
        const first = Math.max(0, Math.floor(this.#viewport.scrollTop / this.#rowHeight));
        const last = Math.min(this.#rows.length, first + Math.ceil(height / this.#rowHeight) + 1);
        this.#rowsLayer.style.transform = `translateY(${first * this.#rowHeight}px)`;
        const fragment = document.createDocumentFragment();
        for (let index = first; index < last; index++) {
            fragment.appendChild(this.#renderRow(this.#rows[index], index));
        }
        this.#rowsLayer.replaceChildren(fragment);
    }

    /**
     * @param {Row} row
     * @param {number} index
     * @returns {HTMLElement}
     */
    #renderRow(row, index) {
        const element = document.createElement('div');
        element.className = 'row';
        element.dataset.index = String(index);
        element.classList.toggle('cursor', index === this.#cursor);
        element.classList.toggle('selected', this.#selected.has(row.name) && !row.isParent);
        element.classList.toggle('dir', row.isDir);
        element.classList.toggle('link', row.entry?.isLink === true);
        element.classList.toggle('hidden-entry', row.entry?.hidden === true);
        element.classList.toggle('drop-target', this.#dropFolderName !== null && row.name === this.#dropFolderName);

        const nameCell = PanelView.#cell('col-name');
        const icon = document.createElement('span');
        icon.className = 'icon';
        this.#icons.render(icon, { name: row.name, isDir: row.isDir, isParent: row.isParent, drive: row.entry?.drive });
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = row.base;
        nameCell.append(icon, label);
        nameCell.title = row.name;

        const extension = PanelView.#cell('col-ext', row.extension);
        const size = PanelView.#cell('col-size', this.#sizeText(row));
        const sizeInfo = row.isDir ? this.#folderSizes.get(row.name) : undefined;
        size.classList.toggle('counting', sizeInfo !== undefined && !sizeInfo.done);
        const date = PanelView.#cell('col-date', this.#dateText(row));
        const attributes = PanelView.#cell('col-attrs', this.#attributesText(row));
        element.append(nameCell, extension, size, date, attributes);
        return element;
    }

    /**
     * @param {Row} row
     * @returns {string}
     */
    #sizeText(row) {
        if (row.isParent) {
            return '';
        }
        if (row.entry?.drive) {
            return row.entry.size === null ? '' : Format.size(row.entry.size, this.#state.sizeMode);
        }
        if (row.isDir) {
            const size = this.#folderSizes.get(row.name);
            if (!size) {
                return '<dir>';
            }
            const text = Format.size(size.bytes, this.#state.sizeMode);
            return size.done && size.skippedFolders > 0 ? `≥${text}` : text;
        }
        const fileSize = row.entry?.size;
        return fileSize === null || fileSize === undefined ? '' : Format.size(fileSize, this.#state.sizeMode);
    }

    /**
     * @param {Row} row
     * @returns {string}
     */
    #dateText(row) {
        if (row.entry?.drive) {
            const free = row.entry.drive.free;
            return free === null ? '' : I18n.t('panel.free', { size: Format.size(free, 'units') });
        }
        return row.entry ? Format.date(row.entry[this.#state.dateKind]) : '';
    }

    /**
     * @param {Row} row
     * @returns {string}
     */
    #attributesText(row) {
        const entry = row.entry;
        if (!entry || entry.drive) {
            return '';
        }
        if (entry.winAttributes !== null) {
            return Format.windowsAttributes(entry.winAttributes);
        }
        return entry.mode !== null ? Format.posixAttributes(entry.mode) : '';
    }

    #renderStatus() {
        let folders = 0;
        let files = 0;
        let selectedFolders = 0;
        let selectedFiles = 0;
        let totalBytes = 0;
        let selectedBytes = 0;
        for (const row of this.#rows) {
            if (row.isParent || row.entry?.drive) {
                continue;
            }
            const bytes = row.isDir ? (this.#folderSizes.get(row.name)?.bytes ?? 0) : (row.entry?.size ?? 0);
            const selected = this.#selected.has(row.name);
            totalBytes += bytes;
            if (row.isDir) {
                folders++;
            } else {
                files++;
            }
            if (selected) {
                selectedBytes += bytes;
                if (row.isDir) {
                    selectedFolders++;
                } else {
                    selectedFiles++;
                }
            }
        }
        this.#statusCounts.textContent = I18n.t('panel.status', { selectedFolders, folders, selectedFiles, files });
        const mode = this.#state.sizeMode;
        this.#statusSizes.textContent = `${Format.size(selectedBytes, mode)} / ${Format.size(totalBytes, mode)}`;
    }

    /**
     * @param {number} index
     */
    #moveCursor(index) {
        if (this.#rows.length === 0) {
            return;
        }
        this.#cursor = Math.min(Math.max(0, index), this.#rows.length - 1);
        this.#scrollCursorIntoView();
        this.#renderRows();
    }

    #scrollCursorIntoView() {
        const top = this.#cursor * this.#rowHeight;
        const bottom = top + this.#rowHeight;
        if (top < this.#viewport.scrollTop) {
            this.#viewport.scrollTop = top;
        } else if (bottom > this.#viewport.scrollTop + this.#viewport.clientHeight) {
            this.#viewport.scrollTop = bottom - this.#viewport.clientHeight;
        }
    }

    /**
     * @param {number} index
     */
    #toggleSelection(index) {
        const row = this.#rows[index];
        if (!PanelView.#isSelectable(row)) {
            return;
        }
        if (this.#selected.has(row.name)) {
            this.#selected.delete(row.name);
        } else {
            this.#selected.add(row.name);
        }
        this.#renderRows();
        this.#renderStatus();
    }

    /**
     * @param {number} index
     * @param {boolean} additive
     */
    #selectRange(index, additive) {
        const anchorIndex = this.#selectionAnchor === null
            ? -1
            : this.#rows.findIndex((row) => row.name === this.#selectionAnchor);
        const from = Math.min(anchorIndex === -1 ? this.#cursor : anchorIndex, index);
        const to = Math.max(anchorIndex === -1 ? this.#cursor : anchorIndex, index);
        if (!additive) {
            this.#selected.clear();
        }
        for (let i = from; i <= to; i++) {
            if (PanelView.#isSelectable(this.#rows[i])) {
                this.#selected.add(this.#rows[i].name);
            }
        }
        this.#renderRows();
        this.#renderStatus();
    }

    #clearSelection() {
        if (this.#selected.size === 0) {
            return;
        }
        this.#selected.clear();
        this.#renderRows();
        this.#renderStatus();
    }

    #toggleSelectionAndCount() {
        const row = this.#rows[this.#cursor];
        if (!row) {
            return;
        }
        this.#toggleSelection(this.#cursor);
        if (row.isDir && !row.isParent && !row.entry?.drive) {
            this.#callbacks.countFolderSizes([row.name]);
        }
    }

    #countAllFolderSizes() {
        const names = this.#rows
            .filter((row) => row.isDir && !row.isParent && !row.entry?.drive)
            .map((row) => row.name);
        if (names.length > 0) {
            this.#callbacks.countFolderSizes(names);
        }
    }

    /**
     * @param {Row | undefined} row
     */
    #openRow(row) {
        if (!row || this.#path === null) {
            return;
        }
        if (row.isParent) {
            this.#goToParent();
        } else if (row.entry?.drive) {
            this.#navigate(`${row.name}\\`, null);
        } else if (row.isDir || (Format.isArchiveName(row.name) && !this.#inArchive)) {
            this.#navigate(this.#childPath(row.name), null);
        } else {
            this.#callbacks.openFile(row.name);
        }
    }

    #goToParent() {
        if (this.#parent !== null && this.#path !== null) {
            this.#navigate(this.#parent, Format.lastSegment(this.#path));
        }
    }

    /**
     * @param {string} name
     * @returns {string}
     */
    #childPath(name) {
        const path = /** @type {string} */ (this.#path);
        const separator = this.#platform.kind === 'win' ? '\\' : '/';
        return path.endsWith(separator) ? `${path}${name}` : `${path}${separator}${name}`;
    }

    /**
     * @returns {string | null}
     */
    #currentName() {
        return this.#rows[this.#cursor]?.name ?? null;
    }

    /**
     * @param {HTMLElement} target
     * @returns {number | null}
     */
    #rowIndexOf(target) {
        const row = /** @type {HTMLElement | null} */ (target.closest('.row'));
        return row ? Number(row.dataset.index) : null;
    }

    /**
     * @param {Set<string>} names
     * @param {Set<string>} keep
     */
    #retainNames(names, keep) {
        for (const name of [...names]) {
            if (!keep.has(name)) {
                names.delete(name);
            }
        }
    }

    /**
     * A click on a part of the path opens that folder in this panel, with the cursor on the folder it came from;
     * a click on the free space after the path turns it into a text field.
     * @param {MouseEvent} event
     */
    #onBreadcrumbClick(event) {
        const target = /** @type {HTMLElement} */ (event.target);
        const segment = /** @type {HTMLElement | null} */ (target.closest('.crumb'));
        if (!segment) {
            this.#root.classList.add('editing-path');
            this.#pathInput.value = this.#path ?? '';
            this.#pathInput.focus();
            this.#pathInput.select();
            return;
        }
        const targetPath = String(segment.dataset.path);
        if (targetPath !== this.#path) {
            this.#navigate(targetPath, segment.dataset.child ?? null);
        }
        this.#viewport.focus();
    }

    /**
     * Every navigation of the panel: the path shows the target at once, and a spinner covers the list when the
     * answer takes longer than LOADING_DELAY_MS. The listing or the error that answers it removes both.
     * @param {string} target
     * @param {string | null} focusName
     */
    #navigate(target, focusName) {
        this.#stopLoading();
        if (this.#looksAbsolute(target)) {
            this.#showPath(target);
        }
        this.#loadingTimer = setTimeout(() => {
            this.#loadingTimer = null;
            this.#root.classList.add('loading');
        }, PanelView.#LOADING_DELAY_MS);
        this.#callbacks.navigate(target, focusName);
    }

    #stopLoading() {
        if (this.#loadingTimer) {
            clearTimeout(this.#loadingTimer);
            this.#loadingTimer = null;
        }
        this.#root.classList.remove('loading');
        this.#loadingText.textContent = '';
    }

    /**
     * A path typed relative to the current folder is shown only once the host has resolved it.
     * @param {string} target
     * @returns {boolean}
     */
    #looksAbsolute(target) {
        return this.#platform.kind === 'win'
            ? target === '' || /^([a-zA-Z]:|\\\\)/.test(target)
            : target.startsWith('/');
    }

    /**
     * @param {string} [path]
     */
    #showPath(path = this.#path ?? '') {
        this.#pathInput.value = path;
        const segments = Format.pathSegments(path, this.#platform.kind);
        const fragment = document.createDocumentFragment();
        segments.forEach((segment, index) => {
            if (segment.separatorBefore !== '') {
                const separator = document.createElement('span');
                separator.className = 'crumb-separator';
                separator.textContent = segment.separatorBefore;
                fragment.appendChild(separator);
            }
            const crumb = document.createElement('span');
            crumb.className = 'crumb';
            crumb.textContent = segment.label;
            crumb.dataset.path = segment.path;
            const child = segments[index + 1];
            if (child) {
                crumb.dataset.child = child.label;
            }
            fragment.appendChild(crumb);
        });
        this.#breadcrumbs.replaceChildren(fragment);
        this.#breadcrumbs.title = path;
    }

    #clearError() {
        if (this.#errorTimer) {
            clearTimeout(this.#errorTimer);
            this.#errorTimer = null;
        }
        this.#statusError.textContent = '';
        this.#root.classList.remove('has-error');
    }

    #applyStateToControls() {
        this.#hiddenToggle.innerHTML = this.#state.showHidden ? SvgIcons.HIDDEN : SvgIcons.HIDDEN_OFF;
        this.#hiddenToggle.title = I18n.t(this.#state.showHidden ? 'toolbar.hiddenShown' : 'toolbar.hiddenNotShown');
        this.#dateSelect.value = this.#state.dateKind;
        this.#sizeModeButton.textContent = this.#state.sizeMode === 'units' ? 'KB' : 'B';
        this.#sizeModeButton.title = this.#state.sizeMode === 'units'
            ? I18n.t('size.toBytes')
            : I18n.t('size.toUnits');
        for (const cell of this.#header.querySelectorAll('[data-sort]')) {
            const element = /** @type {HTMLElement} */ (cell);
            const sorted = element.dataset.sort === this.#state.sortKey;
            element.classList.toggle('sorted', sorted);
            element.classList.toggle('descending', sorted && this.#state.sortDescending);
        }
    }

    #measureRowHeight() {
        const probe = document.createElement('div');
        probe.className = 'row';
        probe.style.height = 'auto';
        probe.textContent = 'M';
        this.#rowsLayer.appendChild(probe);
        this.#rowHeight = Math.ceil(probe.getBoundingClientRect().height) || this.#rowHeight;
        probe.remove();
        this.#root.style.setProperty('--row-height', `${this.#rowHeight}px`);
    }

    /**
     * @template {HTMLElement} T
     * @param {string} selector
     * @returns {T}
     */
    #query(selector) {
        return /** @type {T} */ (this.#root.querySelector(selector));
    }

    /**
     * @param {Row | undefined} row
     * @returns {row is Row}
     */
    static #isSelectable(row) {
        return row !== undefined && !row.isParent && !row.entry?.drive;
    }

    /**
     * @param {string} className
     * @param {string} [text]
     * @returns {HTMLElement}
     */
    static #cell(className, text = '') {
        const cell = document.createElement('span');
        cell.className = `cell ${className}`;
        cell.textContent = text;
        return cell;
    }

    /**
     * @returns {string}
     */
    static #template() {
        const text = (/** @type {string} */ key) => Format.escapeHtml(I18n.t(key));
        return `
<div class="path-bar">
    <div class="breadcrumbs"></div>
    <input class="path-input" type="text" spellcheck="false" tabindex="-1">
</div>
<div class="list-header row-grid">
    <span class="cell col-name" data-sort="name">
        ${text('column.name')}<span class="column-grip" data-resizes="ext" data-direction="-1"></span>
    </span>
    <span class="cell col-ext" data-sort="ext">
        ${text('column.ext')}<span class="column-grip" data-resizes="ext" data-direction="1"></span>
    </span>
    <span class="cell col-size" data-sort="size">
        <button type="button" tabindex="-1" class="size-mode"></button>${text('column.size')}
        <span class="column-grip" data-resizes="size" data-direction="1"></span>
    </span>
    <span class="cell col-date" data-sort="date">
        <select class="date-kind" tabindex="-1">
            <option value="mtime">${text('date.modified')}</option>
            <option value="birthtime">${text('date.created')}</option>
            <option value="atime">${text('date.accessed')}</option>
        </select>
        <span class="column-grip" data-resizes="date" data-direction="1"></span>
    </span>
    <span class="cell col-attrs" data-sort="attrs">${text('column.attr')}</span>
</div>
<div class="viewport" tabindex="0">
    <div class="spacer"></div>
    <div class="rows"></div>
</div>
<div class="loading-overlay"><div class="spinner"></div><div class="loading-text"></div></div>
<div class="status">
    <span class="status-counts"></span>
    <span class="status-error"></span>
    <span class="status-sizes"></span>
</div>`;
    }
}
