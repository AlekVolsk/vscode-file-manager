// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { ArchiveCatalog } = require('./archiveCatalog');
const { Common } = require('./common');
const { Config } = require('./config');
const { DeleteOperation } = require('./deleteOperation');
const { DirectoryReader } = require('./directoryReader');
const { IconThemeLoader } = require('./iconThemeLoader');
const { OperationHost } = require('./operationHost');
const { PanelSession } = require('./panelSession');
const { Platform } = require('./platform');
const { TerminalArgument } = require('./terminalArgument');
const { WebviewHtml } = require('./webviewHtml');
const { WindowsShell } = require('./windowsShell');
const { I18n } = require('./i18n');

/** @typedef {import('./panelSession').Side} Side */

/**
 * A File Manager tab: one webview with two panels, each backed by a PanelSession. Several tabs may be open.
 */
class FileManagerPanel {
    /** @type {Set<FileManagerPanel>} */
    static #instances = new Set();
    /** @type {FileManagerPanel | null} */
    static #lastActive = null;

    #panel;
    #context;
    /** @type {WindowsShell | null} */
    #windowsShell;
    /** @type {Record<Side, PanelSession>} */
    #sessions;
    /** @type {OperationHost} */
    #operations;
    /** @type {vscode.Disposable[]} */
    #disposables = [];
    /** @type {fs.FSWatcher | null} */
    #iconThemeWatcher = null;
    /** @type {vscode.Uri | null} */
    #iconThemeRoot = null;
    /** @type {Partial<Record<Side, string>>} */
    #restoredPaths;

    /**
     * From another editor: shows the File Manager tab used last, creating one when there is none.
     * From a File Manager tab: opens one more next to it.
     * @param {vscode.ExtensionContext} context
     */
    static open(context) {
        const fromFileManager = [...FileManagerPanel.#instances].some((instance) => instance.#panel.active);
        const existing = FileManagerPanel.#lastActive ?? FileManagerPanel.#instances.values().next().value;
        if (existing && !fromFileManager) {
            existing.#panel.reveal(existing.#panel.viewColumn);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            Config.VIEW_TYPE,
            Config.PANEL_TITLE,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        new FileManagerPanel(panel, context, {});
    }

    /**
     * A key of the active File Manager tab. VS Code reserves some function keys inside webviews (F1, F5, …), so
     * they reach the tab as keybindings of this extension, active only while the tab is; the webview does the rest.
     * @param {unknown} action
     */
    static runAction(action) {
        const active = [...FileManagerPanel.#instances].find((instance) => instance.#panel.active);
        if (!active || typeof action !== 'string') {
            return;
        }
        if (action === 'close') {
            active.#panel.dispose();
            return;
        }
        void active.#panel.webview.postMessage({ type: 'action', action });
    }

    /**
     * Takes over a tab that VS Code brings back after a reload, in the folders that tab showed.
     * @param {vscode.WebviewPanel} panel
     * @param {vscode.ExtensionContext} context
     * @param {unknown} webviewState
     */
    static restore(panel, context, webviewState) {
        const paths = /** @type {{ paths?: Partial<Record<Side, unknown>> } | null} */ (webviewState)?.paths ?? {};
        /** @type {Partial<Record<Side, string>>} */
        const restoredPaths = {};
        for (const side of /** @type {Side[]} */ (['left', 'right'])) {
            const restoredPath = paths[side];
            if (typeof restoredPath === 'string') {
                restoredPaths[side] = restoredPath;
            }
        }
        new FileManagerPanel(panel, context, restoredPaths);
    }

    /**
     * @param {vscode.WebviewPanel} panel
     * @param {vscode.ExtensionContext} context
     * @param {Partial<Record<Side, string>>} restoredPaths
     */
    constructor(panel, context, restoredPaths) {
        this.#panel = panel;
        this.#context = context;
        this.#restoredPaths = restoredPaths;
        FileManagerPanel.#instances.add(this);
        FileManagerPanel.#lastActive = this;
        this.#windowsShell = Platform.kind === 'win' ? new WindowsShell() : null;
        const reader = new DirectoryReader(this.#windowsShell);
        const post = (/** @type {Record<string, unknown>} */ message) => {
            void this.#panel.webview.postMessage(message);
        };
        this.#sessions = {
            left: new PanelSession('left', reader, post),
            right: new PanelSession('right', reader, post),
        };
        this.#operations = new OperationHost(post, () => this.#sessions, this.#windowsShell);
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'images', 'fm.svg');
        this.#iconThemeRoot = IconThemeLoader.currentThemeExtensionUri();
        this.#applyWebviewOptions();
        panel.webview.html = WebviewHtml.render(panel.webview, context.extensionUri);
        this.#disposables.push(
            panel.onDidDispose(() => this.#dispose()),
            panel.onDidChangeViewState(() => {
                if (panel.active) {
                    FileManagerPanel.#lastActive = this;
                }
            }),
            panel.webview.onDidReceiveMessage((message) => this.#onMessage(message)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('workbench.iconTheme')) {
                    void this.#sendIconTheme();
                }
                if (event.affectsConfiguration('fileManager.language')
                    || event.affectsConfiguration('fileManager.customTranslations')) {
                    I18n.load(context.extensionPath);
                    panel.webview.html = WebviewHtml.render(panel.webview, context.extensionUri);
                } else if (event.affectsConfiguration('fileManager')) {
                    void panel.webview.postMessage({ type: 'settings', settings: FileManagerPanel.#settings() });
                }
            }),
            vscode.extensions.onDidChange(() => void this.#sendIconTheme()),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.#sendWorkspaceFolders()),
        );
    }

    /**
     * @param {any} message
     */
    async #onMessage(message) {
        if (this.#operations.handle(message)) {
            return;
        }
        /** @type {unknown} */
        const side = message?.side;
        const session = side === 'left' || side === 'right' ? this.#sessions[side] : null;
        switch (message?.type) {
            case 'ready':
                await this.#start();
                break;
            case 'navigate':
                if (session && typeof message.path === 'string') {
                    const focusName = typeof message.focusName === 'string' ? message.focusName : null;
                    await session.navigate(message.path, focusName);
                    this.#savePaths();
                }
                break;
            case 'openFile':
                if (session && typeof message.name === 'string') {
                    await this.#openFile(session, message.name, message.asFile === true);
                }
                break;
            case 'pasteToTerminal':
                if (session && typeof message.name === 'string') {
                    FileManagerPanel.#pasteToTerminal(session, message.name, message.pathKind);
                }
                break;
            case 'countFolderSizes':
                if (session && Array.isArray(message.names)) {
                    const names = message.names.filter((/** @type {unknown} */ name) => typeof name === 'string');
                    session.countFolderSizes(names);
                }
                break;
            case 'cancelFolderSizes':
                session?.cancelFolderSizes();
                break;
            case 'swapPanels':
                this.#swapPanels();
                break;
            case 'revealInOs':
                if (session) {
                    await this.#revealInOs(session, typeof message.name === 'string' ? message.name : null);
                }
                break;
            case 'saveViewState':
                await this.#context.globalState.update(Config.GLOBAL_STATE_KEY, message.state);
                break;
            case 'updateSetting':
                await FileManagerPanel.#updateSetting(message.key, message.value);
                break;
        }
    }

    /**
     * The webview started: on opening, after a window reload, or after a language change rebuilt it. The panels
     * show what they showed before; a new tab starts where `fileManager.startFolder` says.
     */
    async #start() {
        this.#panel.webview.postMessage({
            type: 'init',
            platform: { kind: Platform.kind, isWsl: Platform.isWsl, home: Platform.homeDirectory() },
            capabilities: { trash: DeleteOperation.trashAvailable, revealInOs: FileManagerPanel.#canRevealInOs() },
            viewState: this.#context.globalState.get(Config.GLOBAL_STATE_KEY) ?? null,
            settings: FileManagerPanel.#settings(),
            strings: I18n.strings,
        });
        this.#sendWorkspaceFolders();
        await this.#sendIconTheme();
        await Promise.all((/** @type {Side[]} */ (['left', 'right'])).map((side) => {
            const session = this.#sessions[side];
            return session.navigateToFirstReadable(this.#startCandidates(side, session.path));
        }));
    }

    /**
     * @param {Side} side
     * @param {string | null} currentPath  what the panel shows when the webview was only rebuilt
     * @returns {string[]}  tried in order; the home folder is the last resort anyway
     */
    #startCandidates(side, currentPath) {
        const projectFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const project = projectFolder?.scheme === 'file' ? projectFolder.fsPath : Platform.homeDirectory();
        const remembered = currentPath ?? this.#restoredPaths[side];
        if (remembered !== undefined) {
            return [remembered, project];
        }
        switch (vscode.workspace.getConfiguration('fileManager').get('startFolder')) {
            case 'home':
                return [Platform.homeDirectory()];
            case 'project':
                return [project];
            case 'root':
                return [Platform.kind === 'win' ? '' : '/'];
            default: {
                const saved = /** @type {Partial<Record<Side, string>>} */ (
                    this.#context.workspaceState.get(Config.WORKSPACE_STATE_KEY) ?? {}
                );
                const savedPath = saved[side];
                return typeof savedPath === 'string' ? [savedPath, project] : [project];
            }
        }
    }

    /**
     * The settings the webview uses; the same for both panels and every tab.
     * @returns {Record<string, unknown>}
     */
    static #settings() {
        const settings = vscode.workspace.getConfiguration('fileManager');
        return {
            tableScale: settings.get('tableScale', 0),
            hideExtensionOnRename: settings.get('hideExtensionOnRename', true),
            unpackIntoSubfolder: settings.get('unpackIntoSubfolder', false),
            packFormat: settings.get('packFormat', 'zip'),
        };
    }

    /**
     * A choice made in the panel itself (Ctrl+wheel, a checkbox of a dialog) saved to the user settings.
     * @param {unknown} key
     * @param {unknown} value
     */
    static async #updateSetting(key, value) {
        const valid = (key === 'tableScale' && Number.isInteger(value))
            || ((key === 'hideExtensionOnRename' || key === 'unpackIntoSubfolder') && typeof value === 'boolean')
            || (key === 'packFormat' && (value === 'zip' || value === 'tgz' || value === 'tar'));
        if (valid) {
            await vscode.workspace.getConfiguration('fileManager')
                .update(/** @type {string} */ (key), value, vscode.ConfigurationTarget.Global);
        }
    }

    /**
     * Opens a file in an editor tab; an archive is entered instead, unless `asFile` asks for the file itself (F4).
     * @param {PanelSession} session
     * @param {string} name
     * @param {boolean} asFile
     */
    async #openFile(session, name, asFile) {
        if (session.path === null || session.isInArchive || name.includes('/') || name.includes('\\')) {
            return;
        }
        const filePath = path.join(session.path, name);
        if (ArchiveCatalog.formatOf(name) && !asFile) {
            await session.navigate(filePath, null);
            this.#savePaths();
            return;
        }
        try {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), { preview: false });
        } catch (error) {
            const details = Common.errorMessage(error);
            void vscode.window.showErrorMessage(I18n.t('error.cannotOpen', { path: filePath, details }));
        }
    }

    /**
     * Ctrl+Enter and Ctrl+double-click: the entry goes into the active terminal at its cursor, without Enter, to
     * complete the command typed there, and the terminal takes the focus, so the next Enter runs it. By name; with
     * Shift by path from the project folder; with Alt by absolute path. ".." stands for the folder above.
     * @param {PanelSession} session
     * @param {string} name
     * @param {unknown} pathKind
     */
    static #pasteToTerminal(session, name, pathKind) {
        const dir = session.path;
        if (dir === null || dir === '' || session.isInArchive || /[\\/]/.test(name)) {
            return;
        }
        if (pathKind !== 'name' && pathKind !== 'project' && pathKind !== 'absolute') {
            return;
        }
        const terminal = vscode.window.activeTerminal;
        if (!terminal) {
            void vscode.window.showWarningMessage(I18n.t('error.noTerminal'));
            return;
        }
        const entryPath = name === '..' ? path.dirname(dir) : path.join(dir, name);
        const text = pathKind === 'name' ? name : FileManagerPanel.#terminalPath(entryPath, pathKind);
        const argument = TerminalArgument.format(text, FileManagerPanel.#shellKindOf(terminal));
        if (argument === null) {
            void vscode.window.showErrorMessage(I18n.t('error.terminalUnsafe', { name }));
            return;
        }
        terminal.sendText(`${argument} `, false);
        terminal.show();
    }

    /**
     * The project folder is the workspace folder holding the entry, the first one when none does, and the home
     * folder without a workspace.
     * @param {string} entryPath
     * @param {'project' | 'absolute'} pathKind
     * @returns {string}
     */
    static #terminalPath(entryPath, pathKind) {
        if (pathKind === 'absolute') {
            return entryPath;
        }
        const folders = (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === 'file')
            .map((folder) => folder.uri.fsPath);
        const holding = folders
            .filter((folder) => FileManagerPanel.#isInside(entryPath, folder))
            .sort((a, b) => b.length - a.length);
        const base = holding[0] ?? folders[0] ?? Platform.homeDirectory();
        return path.relative(base, entryPath) || '.';
    }

    /**
     * @param {string} entryPath
     * @param {string} folder
     * @returns {boolean}
     */
    static #isInside(entryPath, folder) {
        const relative = path.relative(folder, entryPath);
        return relative === ''
            || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }

    /**
     * `Terminal.state.shell` is newer than the VS Code this extension requires; without it, the shell the
     * terminal was created with, then the default shell.
     * @param {vscode.Terminal} terminal
     * @returns {import('./terminalArgument').ShellKind}
     */
    static #shellKindOf(terminal) {
        const state = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (terminal.state));
        const options = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (terminal.creationOptions));
        const shell = [state.shell, options.shellPath, vscode.env.shell]
            .find((value) => typeof value === 'string' && value !== '');
        return TerminalArgument.shellKind(typeof shell === 'string' ? shell : '');
    }

    /**
     * The sessions trade sides before the webview moves its panels, so whatever they post from now on reaches the
     * panel that shows their folder.
     */
    #swapPanels() {
        const { left, right } = this.#sessions;
        left.side = 'right';
        right.side = 'left';
        this.#sessions = { left: right, right: left };
        this.#savePaths();
        void this.#panel.webview.postMessage({ type: 'panelsSwapped' });
    }

    /**
     * Folders of the workspace on this machine's file system, in workspace order, for the project button.
     */
    #sendWorkspaceFolders() {
        const folders = (vscode.workspace.workspaceFolders ?? [])
            .filter((folder) => folder.uri.scheme === 'file')
            .map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
        void this.#panel.webview.postMessage({ type: 'workspaceFolders', folders });
    }

    /**
     * The system file manager can be reached from a local VS Code, and from WSL through the WSL extension;
     * other remote hosts (SSH, containers) have none to show.
     * @returns {boolean}
     */
    static #canRevealInOs() {
        return vscode.env.remoteName === undefined || vscode.env.remoteName === 'wsl';
    }

    /**
     * Opens the panel's folder in the system file manager: Explorer, Finder, or the Linux desktop's own. The WSL
     * extension can only reveal an entry in its folder, so under WSL an entry inside is revealed — the one under
     * the cursor, or any — which opens the folder itself; an empty folder can only be shown in its parent.
     * @param {PanelSession} session
     * @param {string | null} cursorName
     */
    async #revealInOs(session, cursorName) {
        const dir = session.path;
        if (dir === null || dir === '' || session.isInArchive || !FileManagerPanel.#canRevealInOs()) {
            return;
        }
        try {
            if (vscode.env.remoteName === 'wsl') {
                const inside = await FileManagerPanel.#entryToReveal(dir, cursorName);
                await vscode.commands.executeCommand(
                    'remote-wsl.revealInExplorer',
                    vscode.Uri.file(inside ? path.join(dir, inside) : dir),
                );
            } else {
                await vscode.env.openExternal(vscode.Uri.file(dir));
            }
        } catch (error) {
            const reason = Common.errorMessage(error);
            void vscode.window.showErrorMessage(I18n.t('error.cannotReveal', { path: dir, details: reason }));
        }
    }

    /**
     * @param {string} dir
     * @param {string | null} cursorName
     * @returns {Promise<string | null>}
     */
    static async #entryToReveal(dir, cursorName) {
        if (cursorName && !/[\\/]/.test(cursorName) && cursorName !== '..') {
            const exists = await fs.promises.lstat(path.join(dir, cursorName)).then(() => true, () => false);
            if (exists) {
                return cursorName;
            }
        }
        const names = await fs.promises.readdir(dir).catch(() => []);
        return names.length > 0 ? names.sort()[0] : null;
    }

    #savePaths() {
        void this.#context.workspaceState.update(Config.WORKSPACE_STATE_KEY, {
            left: this.#sessions.left.path,
            right: this.#sessions.right.path,
        });
    }

    async #sendIconTheme() {
        const { theme, error } = await IconThemeLoader.load(this.#panel.webview);
        this.#iconThemeWatcher?.close();
        this.#iconThemeWatcher = null;
        const root = theme ? theme.extensionUri : null;
        if (root?.toString() !== this.#iconThemeRoot?.toString()) {
            this.#iconThemeRoot = root;
            this.#applyWebviewOptions();
        }
        if (theme) {
            try {
                this.#iconThemeWatcher = fs.watch(
                    theme.themeFile,
                    { persistent: false },
                    () => void this.#sendIconTheme(),
                );
            } catch {
                this.#iconThemeWatcher = null;
            }
        }
        this.#panel.webview.postMessage({ type: 'iconTheme', theme: theme ? theme.theme : null, error });
    }

    #applyWebviewOptions() {
        const roots = [
            vscode.Uri.joinPath(this.#context.extensionUri, 'media'),
            vscode.Uri.joinPath(this.#context.extensionUri, 'images'),
        ];
        if (this.#iconThemeRoot) {
            roots.push(this.#iconThemeRoot);
        }
        this.#panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    }

    #dispose() {
        FileManagerPanel.#instances.delete(this);
        if (FileManagerPanel.#lastActive === this) {
            FileManagerPanel.#lastActive = null;
        }
        this.#operations.dispose();
        this.#sessions.left.dispose();
        this.#sessions.right.dispose();
        this.#iconThemeWatcher?.close();
        this.#windowsShell?.dispose();
        for (const disposable of this.#disposables) {
            disposable.dispose();
        }
        this.#disposables = [];
    }
}

module.exports.FileManagerPanel = FileManagerPanel;
