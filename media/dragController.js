// @ts-check
'use strict';

/**
 * @typedef {object} DropTarget
 * @property {string} path         folder the entries go into
 * @property {string | null} folderName  the folder row they were dropped on; null for the panel's own folder
 */

/**
 * @typedef {object} DragState
 * @property {'left' | 'right'} side
 * @property {string[]} names
 * @property {number} startX
 * @property {number} startY
 * @property {boolean} dragging
 * @property {boolean} copy
 * @property {HTMLElement | null} ghost
 * @property {DropTarget | null} target
 */

/**
 * Dragging entries from one panel to the other: a move, or a copy with Ctrl held at the drop. Built on mouse
 * events rather than HTML drag and drop, which VS Code takes over in webviews for files from its Explorer.
 * Nothing is dropped inside the panel the drag started from.
 */
class DragController {
    static #THRESHOLD_PX = 5;

    #panels;
    #onDrop;
    /** @type {DragState | null} */
    #state = null;
    #onMouseMove = (/** @type {MouseEvent} */ event) => this.#move(event);
    #onMouseUp = (/** @type {MouseEvent} */ event) => this.#release(event);
    #onKey = (/** @type {KeyboardEvent} */ event) => this.#key(event);
    #onBlur = () => this.#cancel();

    /**
     * @param {() => { left: PanelView, right: PanelView } | null} panels
     * @param {(side: 'left' | 'right', names: string[], target: DropTarget, move: boolean) => void} onDrop
     */
    constructor(panels, onDrop) {
        this.#panels = panels;
        this.#onDrop = onDrop;
    }

    /**
     * A press on entries that may turn into a drag once the mouse has moved far enough.
     * @param {'left' | 'right'} side
     * @param {string[]} names
     * @param {MouseEvent} event
     */
    begin(side, names, event) {
        this.#cancel();
        this.#state = {
            side,
            names,
            startX: event.clientX,
            startY: event.clientY,
            dragging: false,
            copy: Keys.command(event),
            ghost: null,
            target: null,
        };
        document.addEventListener('mousemove', this.#onMouseMove, true);
        document.addEventListener('mouseup', this.#onMouseUp, true);
        document.addEventListener('keydown', this.#onKey, true);
        document.addEventListener('keyup', this.#onKey, true);
        window.addEventListener('blur', this.#onBlur);
    }

    /**
     * @param {MouseEvent} event
     */
    #move(event) {
        const state = this.#state;
        const panels = this.#panels();
        if (!state || !panels) {
            return;
        }
        if (!state.dragging) {
            const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
            if (distance < DragController.#THRESHOLD_PX) {
                return;
            }
            state.dragging = true;
            panels[state.side].dragStarted();
            state.ghost = document.createElement('div');
            state.ghost.className = 'drag-ghost';
            document.body.appendChild(state.ghost);
            document.body.classList.add('drag-active');
        }
        state.copy = Keys.command(event);
        const ghost = /** @type {HTMLElement} */ (state.ghost);
        ghost.style.left = `${event.clientX + 14}px`;
        ghost.style.top = `${event.clientY + 10}px`;
        const targetPanel = panels[state.side === 'left' ? 'right' : 'left'];
        const under = document.elementFromPoint(event.clientX, event.clientY);
        state.target = under && targetPanel.element.contains(under)
            ? targetPanel.dropTargetAt(event.clientX, event.clientY)
            : null;
        targetPanel.showDropTarget(state.target);
        this.#label();
    }

    /**
     * @param {MouseEvent} event
     */
    #release(event) {
        const state = this.#state;
        const panels = this.#panels();
        if (!state || !panels) {
            this.#cleanup();
            return;
        }
        if (!state.dragging) {
            this.#cleanup();
            panels[state.side].clickReleased();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const target = state.target;
        const copy = Keys.command(event);
        this.#cleanup();
        if (target) {
            this.#onDrop(state.side, state.names, target, !copy);
        }
    }

    /**
     * Esc drops nothing; Ctrl switches between move and copy while dragging.
     * @param {KeyboardEvent} event
     */
    #key(event) {
        const state = this.#state;
        if (!state?.dragging) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.#cancel();
            return;
        }
        if (event.key === 'Control') {
            state.copy = event.type === 'keydown';
            this.#label();
        }
    }

    #label() {
        const state = this.#state;
        if (!state?.ghost) {
            return;
        }
        const verb = I18n.t(state.copy ? 'drag.copy' : 'drag.move');
        const what = state.names.length === 1
            ? state.names[0]
            : I18n.t('common.selected', { count: state.names.length });
        const where = state.target ? ` → ${state.target.folderName ?? I18n.t('drag.thisFolder')}` : '';
        state.ghost.textContent = `${verb} ${what}${where}`;
        state.ghost.classList.toggle('copy', state.copy);
    }

    #cancel() {
        this.#cleanup();
    }

    #cleanup() {
        const state = this.#state;
        this.#state = null;
        document.removeEventListener('mousemove', this.#onMouseMove, true);
        document.removeEventListener('mouseup', this.#onMouseUp, true);
        document.removeEventListener('keydown', this.#onKey, true);
        document.removeEventListener('keyup', this.#onKey, true);
        window.removeEventListener('blur', this.#onBlur);
        document.body.classList.remove('drag-active');
        state?.ghost?.remove();
        const panels = this.#panels();
        panels?.left.showDropTarget(null);
        panels?.right.showDropTarget(null);
    }
}
