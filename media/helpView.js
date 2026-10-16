// @ts-check
'use strict';

/**
 * The content of the F1 dialog: keys, mouse, drag and drop, toolbar buttons.
 */
class HelpView {
    static #KEYS = [
        ['Tab', 'Other panel'],
        ['↑ ↓ PgUp PgDn Home End', 'Move the cursor'],
        ['Enter, double-click', 'Open a folder or an archive; a file opens in an editor tab'],
        ['Backspace', 'Parent folder'],
        ['Insert', 'Select or unselect, cursor down'],
        ['Space', 'Select or unselect; on a folder, count its size'],
        ['Alt+Shift+Enter', 'Count the size of every folder'],
        ['Esc', 'Stop counting'],
        ['Ctrl+U', 'Swap the panels'],
        ['Ctrl+wheel', 'Scale the tables'],
        ['F1', 'This help'],
        ['F2', 'Rename'],
        ['F3', 'Properties'],
        ['F4', 'Open the file in an editor tab, even an archive'],
        ['Shift+F4', 'New file'],
        ['F5', 'Copy to the other panel'],
        ['F6', 'Move to the other panel'],
        ['F7', 'New folder'],
        ['F8, Delete', 'Delete (to the trash where there is one)'],
        ['Shift+F8, Shift+Delete', 'Delete permanently'],
        ['F9', 'Attributes'],
        ['Alt+F5', 'Pack into an archive'],
        ['Alt+F9', 'Unpack archives'],
        ['F10', 'Close this tab'],
    ];

    static #MOUSE = [
        ['Click on the icon, Ctrl+click', 'Select or unselect one entry'],
        ['Shift+click', 'Select a range; with Ctrl, add it'],
        ['Click on a row', 'Cursor there; clears the selection'],
        ['Click on a part of the path', 'Go to that folder'],
        ['Click after the path', 'Type a path'],
        ['Drag a column divider', 'Resize the column; double-click: automatic width'],
        ['Double-click the panel divider', 'Equal halves'],
    ];

    static #DRAG = [
        ['Drag to the other panel', 'Move; hold Ctrl at the drop to copy'],
        ['Drop on a folder row', 'Into that folder'],
        ['Drop anywhere else', 'Into the folder the panel shows'],
        ['Esc while dragging', 'Cancel'],
    ];

    /**
     * @returns {HTMLElement}
     */
    static element() {
        const root = document.createElement('div');
        root.className = 'help';
        root.append(
            HelpView.#section('Keys', HelpView.#KEYS),
            HelpView.#section('Mouse', HelpView.#MOUSE),
            HelpView.#section('Drag and drop', HelpView.#DRAG),
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
            keyCell.textContent = key;
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
            [SvgIcons.PARENT, 'Parent folder'],
            [SvgIcons.HOME, 'Home folder'],
            [SvgIcons.PROJECT, 'Project folder; a list when the workspace has several'],
            [SvgIcons.ROOT, 'Root, or the drive list on Windows'],
            [SvgIcons.REVEAL, 'Open this folder in the system file manager'],
            [SvgIcons.HIDDEN, 'Show or hide hidden files'],
            [SvgIcons.NEW_FOLDER, 'New folder'],
            [SvgIcons.NEW_FILE, 'New file'],
            [SvgIcons.RENAME, 'Rename'],
            [SvgIcons.COPY, 'Copy to the other panel'],
            [SvgIcons.MOVE, 'Move to the other panel'],
            [SvgIcons.PROPERTIES, 'Properties'],
            [SvgIcons.ATTRIBUTES, 'Attributes'],
            [SvgIcons.PACK, 'Pack into an archive'],
            [SvgIcons.UNPACK, 'Unpack archives'],
            [SvgIcons.TEST, 'Test archives without unpacking'],
            [SvgIcons.DELETE, 'Delete; with Shift, permanently'],
        ];
        const section = document.createElement('section');
        const heading = document.createElement('div');
        heading.className = 'help-heading';
        heading.textContent = 'Toolbar';
        const table = document.createElement('div');
        table.className = 'help-table';
        for (const [icon, meaning] of buttons) {
            const iconCell = document.createElement('div');
            iconCell.className = 'help-icon';
            iconCell.innerHTML = icon;
            const meaningCell = document.createElement('div');
            meaningCell.textContent = meaning;
            table.append(iconCell, meaningCell);
        }
        section.append(heading, table);
        return section;
    }
}
