// @ts-check
'use strict';

/**
 * @typedef {object} DialogButton
 * @property {string} action
 * @property {string} label
 * @property {boolean} [primary]
 * @property {number} [countdownSeconds]  disabled, counting down on its label, before it can be pressed
 */

/**
 * @typedef {object} DialogCheckbox
 * @property {string} label
 * @property {boolean} checked
 * @property {(checked: boolean, input: HTMLInputElement | null) => void} [onToggle]
 */

/**
 * @typedef {object} DialogResult
 * @property {string} action
 * @property {string} value
 * @property {boolean} checked
 */

/**
 * @typedef {object} DialogOptions
 * @property {string} title
 * @property {string} [message]
 * @property {string[]} [lines]
 * @property {{ value: string, selectionEnd?: number }} [input]
 * @property {DialogCheckbox} [checkbox]
 * @property {HTMLElement} [body]  custom content below the message, built by the caller
 * @property {DialogButton[]} buttons
 * @property {string} cancelAction  what Esc does
 * @property {(result: DialogResult) => Promise<string | null>} [submit]
 *     for the primary action: an error keeps the dialog open and is shown in it; null closes it
 */

/**
 * Modal dialogs inside the webview, one at a time; a dialog asked for while another is open waits for it.
 * Names from the file system are put in as text, never as markup.
 */
class DialogView {
    #root;
    /** @type {Promise<unknown>} */
    #queue = Promise.resolve();
    #open = false;

    /**
     * @param {HTMLElement} root
     */
    constructor(root) {
        this.#root = root;
    }

    /**
     * @returns {boolean}
     */
    get isOpen() {
        return this.#open;
    }

    /**
     * @param {DialogOptions} options
     * @returns {Promise<DialogResult>}
     */
    show(options) {
        const shown = this.#queue.then(() => this.#present(options));
        this.#queue = shown.catch(() => undefined);
        return shown;
    }

    /**
     * Enter presses the main button from a text field or the dialog itself, not from a checkbox or another button.
     * @param {EventTarget | null} target
     * @param {HTMLElement} dialog
     * @returns {boolean}
     */
    static #submitsOnEnter(target, dialog) {
        return target === dialog || (target instanceof HTMLInputElement && target.type === 'text');
    }

    /**
     * @param {DialogOptions} options
     * @returns {Promise<DialogResult>}
     */
    #present(options) {
        return new Promise((resolve) => {
            this.#open = true;
            const backdrop = document.createElement('div');
            backdrop.className = 'dialog-backdrop';
            const dialog = document.createElement('div');
            dialog.className = 'dialog';
            dialog.setAttribute('role', 'dialog');
            backdrop.appendChild(dialog);

            const title = document.createElement('div');
            title.className = 'dialog-title';
            title.textContent = options.title;
            dialog.appendChild(title);

            if (options.message) {
                const message = document.createElement('div');
                message.className = 'dialog-message';
                message.textContent = options.message;
                dialog.appendChild(message);
            }
            if (options.lines && options.lines.length > 0) {
                const list = document.createElement('div');
                list.className = 'dialog-lines';
                for (const line of options.lines) {
                    const item = document.createElement('div');
                    item.textContent = line;
                    list.appendChild(item);
                }
                dialog.appendChild(list);
            }

            if (options.body) {
                dialog.appendChild(options.body);
            }

            /** @type {HTMLInputElement | null} */
            let input = null;
            if (options.input) {
                input = document.createElement('input');
                input.type = 'text';
                input.className = 'dialog-input';
                input.spellcheck = false;
                input.value = options.input.value;
                dialog.appendChild(input);
            }

            /** @type {HTMLInputElement | null} */
            let checkbox = null;
            if (options.checkbox) {
                const label = document.createElement('label');
                label.className = 'dialog-checkbox';
                checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = options.checkbox.checked;
                const onToggle = options.checkbox.onToggle;
                const box = checkbox;
                box.addEventListener('change', () => onToggle?.(box.checked, input));
                label.append(checkbox, document.createTextNode(options.checkbox.label));
                dialog.appendChild(label);
            }

            const error = document.createElement('div');
            error.className = 'dialog-error';
            dialog.appendChild(error);

            const buttonRow = document.createElement('div');
            buttonRow.className = 'dialog-buttons';
            dialog.appendChild(buttonRow);
            /** @type {Map<string, HTMLButtonElement>} */
            const buttons = new Map();
            /** @type {ReturnType<typeof setInterval>[]} */
            const timers = [];
            let busy = false;

            const finish = (/** @type {string} */ action) => {
                for (const timer of timers) {
                    clearInterval(timer);
                }
                backdrop.remove();
                this.#open = false;
                resolve({ action, value: input?.value ?? '', checked: checkbox?.checked ?? false });
            };
            const press = async (/** @type {DialogButton} */ button) => {
                const element = buttons.get(button.action);
                if (busy || !element || element.disabled) {
                    return;
                }
                if (!button.primary || !options.submit) {
                    finish(button.action);
                    return;
                }
                busy = true;
                dialog.classList.add('busy');
                const problem = await options.submit({
                    action: button.action,
                    value: input?.value ?? '',
                    checked: checkbox?.checked ?? false,
                });
                busy = false;
                dialog.classList.remove('busy');
                if (problem === null) {
                    finish(button.action);
                    return;
                }
                error.textContent = problem;
                input?.focus();
            };

            for (const button of options.buttons) {
                const element = document.createElement('button');
                element.type = 'button';
                element.className = button.primary ? 'dialog-button primary' : 'dialog-button';
                element.textContent = button.label;
                element.addEventListener('click', () => void press(button));
                if (button.countdownSeconds) {
                    let remaining = button.countdownSeconds;
                    element.disabled = true;
                    element.textContent = `${button.label} (${remaining})`;
                    const timer = setInterval(() => {
                        remaining--;
                        if (remaining > 0) {
                            element.textContent = `${button.label} (${remaining})`;
                            return;
                        }
                        clearInterval(timer);
                        element.disabled = false;
                        element.textContent = button.label;
                    }, 1000);
                    timers.push(timer);
                }
                buttons.set(button.action, element);
                buttonRow.appendChild(element);
            }

            dialog.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    if (!busy) {
                        finish(options.cancelAction);
                    }
                } else if (event.key === 'Enter' && DialogView.#submitsOnEnter(event.target, dialog)) {
                    event.preventDefault();
                    const primary = options.buttons.find((button) => button.primary);
                    if (primary) {
                        void press(primary);
                    }
                }
            });

            dialog.tabIndex = -1;
            this.#root.appendChild(backdrop);
            if (input) {
                input.focus();
                input.setSelectionRange(0, options.input?.selectionEnd ?? input.value.length);
            } else {
                const primary = options.buttons.find((button) => button.primary);
                const primaryElement = primary ? buttons.get(primary.action) : undefined;
                (primaryElement && !primaryElement.disabled ? primaryElement : dialog).focus();
            }
        });
    }
}
