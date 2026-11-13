// @ts-check
'use strict';

/** Keyboard-accessible popup built from nonempty action groups. */
class ListContextMenu {
    /** @type {HTMLElement | null} */
    #menu = null;
    /** @type {(() => void) | null} */
    #cleanup = null;

    close() {
        this.#cleanup?.();
        this.#cleanup = null;
        this.#menu?.remove();
        this.#menu = null;
    }

    /** @returns {boolean} */
    get isOpen() {
        return this.#menu !== null;
    }

    /**
     * @param {MouseEvent} event
     * @param {string} title
     * @param {{ label: string, run: (shift: boolean) => void }[][]} groups
     * @param {() => void} restoreFocus
     */
    show(event, title, groups, restoreFocus) {
        this.close();
        const menu = document.createElement('div');
        menu.className = 'menu list-context-menu';
        menu.setAttribute('role', 'menu');
        Object.assign(menu.style, { position: 'fixed', zIndex: '1000', maxHeight: '100vh', overflowY: 'auto' });
        const heading = document.createElement('strong');
        heading.className = 'menu-heading';
        heading.textContent = title;
        menu.appendChild(heading);
        for (const [index, group] of groups.filter((items) => items.length > 0).entries()) {
            if (index > 0) {
                const separator = document.createElement('hr');
                separator.setAttribute('role', 'separator');
                separator.style.width = '100%';
                menu.appendChild(separator);
            }
            for (const item of group) {
                const button = document.createElement('button');
                button.className = 'menu-item';
                button.textContent = item.label;
                button.setAttribute('role', 'menuitem');
                button.addEventListener('click', (click) => {
                    this.close();
                    restoreFocus();
                    item.run(click.shiftKey);
                });
                menu.appendChild(button);
            }
        }
        document.body.appendChild(menu);
        this.#menu = menu;
        const bounds = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - bounds.width))}px`;
        menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - bounds.height))}px`;
        const outside = (/** @type {Event} */ click) => {
            if (!menu.contains(/** @type {Node} */ (click.target))) {
                this.close();
            }
        };
        const keydown = (/** @type {KeyboardEvent} */ key) => {
            key.stopPropagation();
            const buttons = [...menu.querySelectorAll('button')];
            const index = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key.key)) {
                key.preventDefault();
                const next = key.key === 'Home' ? 0 : key.key === 'End' ? buttons.length - 1
                    : index < 0 ? (key.key === 'ArrowUp' ? buttons.length - 1 : 0)
                        : (index + (key.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
                buttons[next]?.focus();
            } else if (key.key === 'Escape' || key.key === 'Tab') {
                key.preventDefault();
                this.close();
                restoreFocus();
            }
        };
        document.addEventListener('pointerdown', outside, true);
        menu.addEventListener('keydown', keydown);
        this.#cleanup = () => document.removeEventListener('pointerdown', outside, true);
        menu.tabIndex = -1;
        menu.style.outline = 'none';
        menu.focus({ preventScroll: true });
    }
}
