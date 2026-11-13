// @ts-check
'use strict';

/**
 * @typedef {object} ToolbarItem
 * @property {string} [action]     data-action of the button; absent for a separator
 * @property {string} [operation]  data-operation, for buttons of file operations
 * @property {string} [icon]
 * @property {string} [titleKey]
 * @property {string} [shortcut]   shown after the title, so the button teaches its key
 * @property {boolean} [disabled]
 */

/**
 * The toolbar of a panel. Buttons that do not fit the panel's width go, from the end, into the "⋯" menu; the
 * help, favorites and history buttons stay at the right edge. Menu entries press hidden buttons to reuse their handlers.
 */
class ToolbarView {
    /** @type {ToolbarItem[]} */
    static #ITEMS = [
        { action: 'parent', icon: SvgIcons.PARENT, titleKey: 'toolbar.parent', shortcut: 'Backspace' },
        { action: 'home', icon: SvgIcons.HOME, titleKey: 'toolbar.home' },
        { action: 'project', icon: SvgIcons.PROJECT, titleKey: 'toolbar.project', disabled: true },
        { action: 'root', icon: SvgIcons.ROOT, titleKey: 'toolbar.root' },
        { action: 'reveal', icon: SvgIcons.REVEAL, titleKey: 'toolbar.reveal', disabled: true },
        {},
        { action: 'hidden', icon: SvgIcons.HIDDEN, titleKey: 'toolbar.hiddenShown' },
        {},
        {
            action: 'op',
            operation: 'newFolder',
            icon: SvgIcons.NEW_FOLDER,
            titleKey: 'toolbar.newFolder',
            shortcut: 'F7',
        },
        {
            action: 'op',
            operation: 'newFile',
            icon: SvgIcons.NEW_FILE,
            titleKey: 'toolbar.newFile',
            shortcut: 'Shift+F4',
        },
        { action: 'op', operation: 'rename', icon: SvgIcons.RENAME, titleKey: 'toolbar.rename', shortcut: 'F2' },
        {},
        { action: 'op', operation: 'copy', icon: SvgIcons.COPY, titleKey: 'toolbar.copy', shortcut: 'F5' },
        { action: 'op', operation: 'move', icon: SvgIcons.MOVE, titleKey: 'toolbar.move', shortcut: 'F6' },
        {
            action: 'op',
            operation: 'delete',
            icon: SvgIcons.DELETE,
            titleKey: 'toolbar.delete',
            shortcut: 'F8, Shift+F8',
        },
        {},
        { action: 'op', operation: 'pack', icon: SvgIcons.PACK, titleKey: 'toolbar.pack', shortcut: 'Alt+F5' },
        { action: 'op', operation: 'unpack', icon: SvgIcons.UNPACK, titleKey: 'toolbar.unpack', shortcut: 'Alt+F9' },
        { action: 'op', operation: 'test', icon: SvgIcons.TEST, titleKey: 'toolbar.test' },
        {},
        {
            action: 'op',
            operation: 'attributes',
            icon: SvgIcons.ATTRIBUTES,
            titleKey: 'toolbar.attributes',
            shortcut: 'F9',
        },
        {
            action: 'op',
            operation: 'properties',
            icon: SvgIcons.PROPERTIES,
            titleKey: 'toolbar.properties',
            shortcut: 'F3',
        },
    ];

    #element;
    #items;
    #more;
    /** @type {HTMLElement | null} */
    #menu = null;
    /** @type {((event: MouseEvent) => void) | null} */
    #closeListener = null;

    /**
     * @param {boolean} isWsl
     */
    constructor(isWsl) {
        this.#element = document.createElement('div');
        this.#element.className = 'toolbar';
        this.#items = document.createElement('div');
        this.#items.className = 'toolbar-items';
        for (const item of ToolbarView.#ITEMS) {
            if (item.action === 'home') {
                this.#items.appendChild(ToolbarView.#button({
                    action: 'neighbor', icon: SvgIcons.NEIGHBOR, titleKey: 'toolbar.neighbor',
                }));
            }
            if (isWsl && item.action === 'home') {
                this.#items.appendChild(ToolbarView.#button({
                    action: 'mounts', icon: SvgIcons.MOUNTS, titleKey: 'toolbar.mounts',
                }));
            }
            this.#items.appendChild(item.action ? ToolbarView.#button(item) : ToolbarView.#separator());
        }
        const end = document.createElement('div');
        end.className = 'toolbar-end';
        this.#more = ToolbarView.#button({ action: 'more', icon: SvgIcons.MORE, titleKey: 'toolbar.more' });
        this.#more.hidden = true;
        this.#more.addEventListener('click', (event) => {
            event.stopPropagation();
            this.#toggleMenu();
        });
        end.append(this.#more, ToolbarView.#button({
            action: 'help',
            icon: SvgIcons.HELP,
            titleKey: 'toolbar.help',
            shortcut: 'F1',
        }), ToolbarView.#button({
            action: 'favorites',
            icon: SvgIcons.FAVORITES,
            titleKey: 'favorites.title',
        }), ToolbarView.#button({
            action: 'history',
            icon: SvgIcons.CLOCK,
            titleKey: 'history.title',
        }));
        this.#element.append(this.#items, end);
        new ResizeObserver(() => this.fit()).observe(this.#element);
    }

    /**
     * @returns {HTMLElement}
     */
    get element() {
        return this.#element;
    }

    /**
     * Applies control visibility without changing action availability.
     * @param {Record<string, boolean>} visibility
     */
    setVisibility(visibility) {
        this.#element.hidden = visibility.toolbar === false;
        for (const button of this.#element.querySelectorAll('button')) {
            const action = button.dataset.action;
            const operation = button.dataset.operation;
            const group = action === 'op'
                ? (['pack', 'unpack', 'test'].includes(operation ?? '') ? 'archives'
                    : operation === 'attributes' ? 'attributes'
                        : operation === 'properties' ? 'properties' : 'files')
                : action === 'hidden' ? 'hiddenFiles'
                    : action === 'help' ? 'help'
                        : action === 'history' ? 'history'
                            : action === 'favorites' ? 'favorites' : 'navigation';
            button.dataset.visibilityHidden = String(action !== 'more' && visibility[group] === false);
        }
        this.fit();
    }

    /**
     * Shows every button, then hides from the end until the rest fits; a separator never ends the visible row.
     */
    fit() {
        this.#closeMenu();
        const all = /** @type {HTMLElement[]} */ ([...this.#items.children]);
        for (const child of all) {
            child.hidden = child.dataset.visibilityHidden === 'true';
        }
        for (const button of this.#element.querySelectorAll('button')) {
            button.hidden = button.dataset.visibilityHidden === 'true';
        }
        const children = all.filter((child) => child.dataset.visibilityHidden !== 'true');
        for (const child of children) {
            child.hidden = false;
        }
        let hasButton = false;
        for (let index = 0; index < children.length; index++) {
            const child = children[index];
            if (child.tagName === 'BUTTON') {
                hasButton = true;
            } else {
                child.hidden = !hasButton || !children.slice(index + 1).some((next) => next.tagName === 'BUTTON');
                hasButton = false;
            }
        }
        this.#more.hidden = false;
        if (this.#element.getBoundingClientRect().width === 0) {
            return;
        }
        let last = children.length - 1;
        while (last >= 0 && this.#items.scrollWidth > this.#items.clientWidth) {
            children[last].hidden = true;
            last--;
        }
        while (last >= 0 && children[last].classList.contains('toolbar-separator')) {
            children[last].hidden = true;
            last--;
        }
        this.#more.hidden = !children.some((child) => child.hidden && child.tagName === 'BUTTON');
    }

    #toggleMenu() {
        if (this.#menu) {
            this.#closeMenu();
            return;
        }
        const menu = document.createElement('div');
        menu.className = 'menu toolbar-menu';
        const hiddenButtons = [...this.#items.querySelectorAll('button')].filter((button) => button.hidden && button.dataset.visibilityHidden !== 'true');
        for (const button of hiddenButtons) {
            const entry = document.createElement('button');
            entry.type = 'button';
            entry.tabIndex = -1;
            entry.className = 'menu-item';
            entry.disabled = button.disabled;
            const icon = document.createElement('span');
            icon.className = 'menu-icon';
            icon.innerHTML = button.innerHTML;
            const label = document.createElement('span');
            label.textContent = button.title;
            entry.append(icon, label);
            entry.addEventListener('click', () => {
                this.#closeMenu();
                button.click();
            });
            menu.appendChild(entry);
        }
        const panel = /** @type {HTMLElement} */ (this.#element.closest('.panel'));
        const panelBounds = panel.getBoundingClientRect();
        const moreBounds = this.#more.getBoundingClientRect();
        menu.style.right = `${panelBounds.right - moreBounds.right}px`;
        menu.style.top = `${moreBounds.bottom - panelBounds.top}px`;
        panel.appendChild(menu);
        this.#menu = menu;
        this.#closeListener = (event) => {
            const target = /** @type {Node} */ (event.target);
            if (!menu.contains(target) && !this.#more.contains(target)) {
                this.#closeMenu();
            }
        };
        document.addEventListener('mousedown', this.#closeListener, true);
    }

    #closeMenu() {
        this.#menu?.remove();
        this.#menu = null;
        if (this.#closeListener) {
            document.removeEventListener('mousedown', this.#closeListener, true);
            this.#closeListener = null;
        }
    }

    /**
     * @param {ToolbarItem} item
     * @returns {HTMLButtonElement}
     */
    static #button(item) {
        const button = document.createElement('button');
        button.type = 'button';
        button.tabIndex = -1;
        button.dataset.action = item.action;
        if (item.operation) {
            button.dataset.operation = item.operation;
        }
        button.disabled = item.disabled === true;
        const title = item.titleKey ? I18n.t(item.titleKey) : '';
        button.title = item.shortcut ? `${title} (${Keys.label(item.shortcut)})` : title;
        button.innerHTML = item.icon ?? '';
        return button;
    }

    /**
     * @returns {HTMLElement}
     */
    static #separator() {
        const separator = document.createElement('span');
        separator.className = 'toolbar-separator';
        return separator;
    }
}
