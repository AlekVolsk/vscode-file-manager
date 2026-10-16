// @ts-check
'use strict';

/**
 * @typedef {'on' | 'off' | 'mixed'} BitState
 */

/**
 * @typedef {object} AttributeBit
 * @property {number} bit
 * @property {string} label
 */

/**
 * The content of the attributes dialog: permission bits (POSIX) or attribute flags (Windows) as checkboxes.
 * For several entries a bit they do not share starts mixed and stays as each entry has it unless changed.
 * Only the bits the user changes are applied, so a recursive change never spreads the other bits of the first
 * entry onto everything inside.
 */
class AttributesForm {
    /** @type {AttributeBit[][]} */
    static #POSIX_ROWS = [
        [{ bit: 0o400, label: 'r' }, { bit: 0o200, label: 'w' }, { bit: 0o100, label: 'x' }],
        [{ bit: 0o040, label: 'r' }, { bit: 0o020, label: 'w' }, { bit: 0o010, label: 'x' }],
        [{ bit: 0o004, label: 'r' }, { bit: 0o002, label: 'w' }, { bit: 0o001, label: 'x' }],
        [{ bit: 0o4000, label: 'setuid' }, { bit: 0o2000, label: 'setgid' }, { bit: 0o1000, label: 'sticky' }],
    ];
    static #POSIX_ROW_LABELS = ['Owner', 'Group', 'Others', 'Special'];
    static #POSIX_SPECIAL_BITS = 0o7000;
    /** System.IO.FileAttributes */
    static #WINDOWS_BITS = [
        { bit: 1, label: 'Read-only' },
        { bit: 2, label: 'Hidden' },
        { bit: 4, label: 'System' },
        { bit: 32, label: 'Archive' },
    ];

    #element;
    #windows;
    /** @type {Map<number, { state: BitState, initial: BitState, box: HTMLInputElement }>} */
    #bits = new Map();
    /** @type {HTMLInputElement | null} */
    #octal = null;
    /** @type {HTMLInputElement | null} */
    #recursive = null;

    /**
     * @param {{ isDir: boolean, mode: number | null, winAttributes: number | null }[]} entries
     */
    constructor(entries) {
        this.#windows = entries.some((entry) => entry.winAttributes !== null);
        this.#element = document.createElement('div');
        this.#element.className = 'attributes-form';
        const values = entries.map((entry) => (this.#windows ? entry.winAttributes : entry.mode) ?? 0);
        if (this.#windows) {
            this.#buildWindows(values);
        } else {
            this.#buildPosix(values);
        }
        if (entries.some((entry) => entry.isDir)) {
            const label = document.createElement('label');
            label.className = 'dialog-checkbox';
            this.#recursive = document.createElement('input');
            this.#recursive.type = 'checkbox';
            label.append(this.#recursive, document.createTextNode('Also everything inside the folders'));
            this.#element.appendChild(label);
        }
    }

    /**
     * @returns {HTMLElement}
     */
    get element() {
        return this.#element;
    }

    /**
     * @returns {boolean}
     */
    get recursive() {
        return this.#recursive?.checked ?? false;
    }

    /**
     * Bits the user turned on and off; bits left as they were are in neither.
     * @returns {{ set: number, clear: number }}
     */
    get change() {
        let set = 0;
        let clear = 0;
        for (const [bit, info] of this.#bits) {
            if (info.state === info.initial || info.state === 'mixed') {
                continue;
            }
            if (info.state === 'on') {
                set |= bit;
            } else {
                clear |= bit;
            }
        }
        return { set, clear };
    }

    /**
     * @param {number[]} values
     */
    #buildPosix(values) {
        const grid = document.createElement('div');
        grid.className = 'attributes-grid';
        AttributesForm.#POSIX_ROWS.forEach((row, index) => {
            const label = document.createElement('span');
            label.className = 'attributes-row-label';
            label.textContent = AttributesForm.#POSIX_ROW_LABELS[index];
            grid.appendChild(label);
            for (const bit of row) {
                grid.appendChild(this.#checkbox(bit, values));
            }
        });
        this.#element.appendChild(grid);

        const octalLabel = document.createElement('label');
        octalLabel.className = 'attributes-octal';
        octalLabel.textContent = 'Octal ';
        this.#octal = document.createElement('input');
        this.#octal.type = 'text';
        this.#octal.className = 'dialog-input';
        this.#octal.maxLength = 4;
        this.#octal.spellcheck = false;
        this.#octal.addEventListener('input', () => this.#applyOctal());
        octalLabel.appendChild(this.#octal);
        this.#element.appendChild(octalLabel);
        this.#showOctal();
    }

    /**
     * @param {number[]} values
     */
    #buildWindows(values) {
        const list = document.createElement('div');
        list.className = 'attributes-list';
        for (const bit of AttributesForm.#WINDOWS_BITS) {
            list.appendChild(this.#checkbox(bit, values));
        }
        this.#element.appendChild(list);
    }

    /**
     * A checkbox that cycles on → off, and through mixed again when the entries started mixed.
     * @param {AttributeBit} bit
     * @param {number[]} values
     * @returns {HTMLElement}
     */
    #checkbox(bit, values) {
        const withBit = values.filter((value) => (value & bit.bit) !== 0).length;
        /** @type {BitState} */
        const initial = withBit === 0 ? 'off' : (withBit === values.length ? 'on' : 'mixed');
        const label = document.createElement('label');
        label.className = 'dialog-checkbox';
        const box = document.createElement('input');
        box.type = 'checkbox';
        const info = { state: initial, initial, box };
        this.#bits.set(bit.bit, info);
        AttributesForm.#showState(info);
        box.addEventListener('click', () => {
            if (info.state === 'mixed') {
                info.state = 'on';
            } else if (info.state === 'on') {
                info.state = 'off';
            } else {
                info.state = info.initial === 'mixed' ? 'mixed' : 'on';
            }
            AttributesForm.#showState(info);
            this.#showOctal();
        });
        label.append(box, document.createTextNode(bit.label));
        return label;
    }

    /**
     * @param {{ state: BitState, box: HTMLInputElement }} info
     */
    static #showState(info) {
        info.box.indeterminate = info.state === 'mixed';
        info.box.checked = info.state === 'on';
    }

    #showOctal() {
        if (!this.#octal || document.activeElement === this.#octal) {
            return;
        }
        let mode = 0;
        for (const [bit, info] of this.#bits) {
            if (info.state === 'mixed') {
                this.#octal.value = '';
                this.#octal.placeholder = 'mixed';
                return;
            }
            if (info.state === 'on') {
                mode |= bit;
            }
        }
        const digits = (mode & AttributesForm.#POSIX_SPECIAL_BITS) !== 0 ? 4 : 3;
        this.#octal.value = mode.toString(8).padStart(digits, '0');
    }

    #applyOctal() {
        const octal = /** @type {HTMLInputElement} */ (this.#octal);
        if (!/^[0-7]{3,4}$/.test(octal.value)) {
            return;
        }
        const mode = parseInt(octal.value, 8);
        for (const [bit, info] of this.#bits) {
            info.state = (mode & bit) !== 0 ? 'on' : 'off';
            AttributesForm.#showState(info);
        }
    }
}
