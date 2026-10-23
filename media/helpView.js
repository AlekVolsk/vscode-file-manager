// @ts-check
'use strict';

/**
 * The content of the F1 dialog: keys, mouse, drag and drop, toolbar buttons.
 */
class HelpView {
    /** key names as they are on the keyboard, and what they do */
    static #KEYS = [
        ['Tab', 'help.key.tab'],
        ['↑ ↓ PgUp PgDn Home End', 'help.key.move'],
        ['Enter', 'help.key.enter'],
        ['Backspace', 'help.key.backspace'],
        ['Insert', 'help.key.insert'],
        ['Space', 'help.key.space'],
        ['Ctrl+Enter', 'help.key.terminalName'],
        ['Ctrl+Shift+Enter', 'help.key.terminalProject'],
        ['Ctrl+Alt+Enter', 'help.key.terminalAbsolute'],
        ['Alt+Shift+Enter', 'help.key.countAll'],
        ['Esc', 'help.key.esc'],
        ['Ctrl+U', 'help.key.swap'],
        ['Ctrl+wheel', 'help.key.scale'],
        ['F1', 'help.key.f1'],
        ['F2', 'help.key.f2'],
        ['F3', 'help.key.f3'],
        ['F4', 'help.key.f4'],
        ['Shift+F4', 'help.key.shiftF4'],
        ['F5', 'help.key.f5'],
        ['F6', 'help.key.f6'],
        ['F7', 'help.key.f7'],
        ['F8, Delete', 'help.key.f8'],
        ['Shift+F8, Shift+Delete', 'help.key.shiftF8'],
        ['F9', 'help.key.f9'],
        ['Alt+F5', 'help.key.altF5'],
        ['Alt+F9', 'help.key.altF9'],
        ['F10', 'help.key.f10'],
    ];

    /** both columns translated: "<key>.keys" names the gesture */
    static #MOUSE = [
        'help.mouse.icon',
        'help.mouse.range',
        'help.mouse.row',
        'help.mouse.double',
        'help.mouse.terminal',
        'help.mouse.crumb',
        'help.mouse.typePath',
        'help.mouse.column',
        'help.mouse.splitter',
    ];

    static #DRAG = [
        'help.drag.panel',
        'help.drag.folder',
        'help.drag.elsewhere',
        'help.drag.esc',
    ];

    /**
     * @returns {HTMLElement}
     */
    static element() {
        const root = document.createElement('div');
        root.className = 'help';
        const gestures = (/** @type {string[]} */ keys) => keys.map((key) => [I18n.t(`${key}.keys`), I18n.t(key)]);
        root.append(
            HelpView.#section(I18n.t('help.keys'), HelpView.#KEYS.map(([key, meaning]) => [key, I18n.t(meaning)])),
            HelpView.#section(I18n.t('help.mouse'), gestures(HelpView.#MOUSE)),
            HelpView.#section(I18n.t('help.drag'), gestures(HelpView.#DRAG)),
            HelpView.#toolbarSection(),
        );
        return root;
    }

    /**
     * @param {string} title
     * @param {string[][]} rows
     * @returns {HTMLElement}
     */
    static #section(title, rows) {
        const section = document.createElement('section');
        const heading = document.createElement('div');
        heading.className = 'help-heading';
        heading.textContent = title;
        const table = document.createElement('div');
        table.className = 'help-table';
        for (const [key, meaning] of rows) {
            const keyCell = document.createElement('div');
            keyCell.className = 'help-key';
            keyCell.textContent = Keys.label(key);
            const meaningCell = document.createElement('div');
            meaningCell.textContent = meaning;
            table.append(keyCell, meaningCell);
        }
        section.append(heading, table);
        return section;
    }

    /**
     * @returns {HTMLElement}
     */
    static #toolbarSection() {
        const buttons = [
            [SvgIcons.PARENT, 'help.key.backspace'],
            [SvgIcons.HOME, 'toolbar.home'],
            [SvgIcons.PROJECT, 'help.toolbar.project'],
            [SvgIcons.ROOT, 'help.toolbar.root'],
            [SvgIcons.REVEAL, 'toolbar.reveal'],
            [SvgIcons.HIDDEN, 'help.toolbar.hidden'],
            [SvgIcons.NEW_FOLDER, 'toolbar.newFolder'],
            [SvgIcons.NEW_FILE, 'toolbar.newFile'],
            [SvgIcons.RENAME, 'toolbar.rename'],
            [SvgIcons.COPY, 'toolbar.copy'],
            [SvgIcons.MOVE, 'toolbar.move'],
            [SvgIcons.PROPERTIES, 'toolbar.properties'],
            [SvgIcons.ATTRIBUTES, 'toolbar.attributes'],
            [SvgIcons.PACK, 'toolbar.pack'],
            [SvgIcons.UNPACK, 'toolbar.unpack'],
            [SvgIcons.TEST, 'help.toolbar.test'],
            [SvgIcons.DELETE, 'help.toolbar.delete'],
            [SvgIcons.HELP, 'help.toolbar.help'],
            [SvgIcons.MORE, 'toolbar.more'],
        ];
        const section = document.createElement('section');
        const heading = document.createElement('div');
        heading.className = 'help-heading';
        heading.textContent = I18n.t('help.toolbar');
        const table = document.createElement('div');
        table.className = 'help-table';
        for (const [icon, meaningKey] of buttons) {
            const iconCell = document.createElement('div');
            iconCell.className = 'help-icon';
            iconCell.innerHTML = icon;
            const meaningCell = document.createElement('div');
            meaningCell.textContent = I18n.t(meaningKey);
            table.append(iconCell, meaningCell);
        }
        section.append(heading, table);
        return section;
    }
}
