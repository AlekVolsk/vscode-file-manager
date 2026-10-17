// @ts-check
'use strict';

/**
 * @typedef {object} OperationProgress
 * @property {'copy' | 'move' | 'delete' | 'attributes' | 'unpack' | 'pack' | 'test'} kind
 * @property {string} [phase]
 * @property {string} currentName
 * @property {number} [currentDone]
 * @property {number} [currentTotal]
 * @property {number} [done]
 * @property {number} [total]
 * @property {number} doneFiles
 * @property {number} totalFiles
 */

/**
 * The window of a running operation, in a corner of the tab so the panels stay usable. It appears only when the
 * operation lasts longer than SHOW_DELAY_MS. The bar of the current file is always there but fills only for big
 * files; small ones move the total bar alone, and the window keeps its height.
 */
class ProgressView {
    static #SHOW_DELAY_MS = 300;
    /** operations whose byte totals hold every byte twice: written, then read back to check */
    static #COUNTED_TWICE = new Set(['copy', 'move', 'pack']);
    /** 16 MB = 16 × 1024 × 1024, counted twice: copy and check */
    static #CURRENT_BAR_MIN_BYTES = 33_554_432;
    static #PHASES = new Set([
        'scanning',
        'copying',
        'verifying',
        'moving',
        'deleting',
        'applying',
        'unpacking',
        'packing',
        'testing',
    ]);

    #root;
    #onCancel;
    /** @type {HTMLElement | null} */
    #box = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    #showTimer = null;
    /** @type {number | null} */
    #transferStartedAt = null;
    /** @type {OperationProgress | null} */
    #last = null;
    #title = '';

    /**
     * @param {HTMLElement} root
     * @param {() => void} onCancel
     */
    constructor(root, onCancel) {
        this.#root = root;
        this.#onCancel = onCancel;
    }

    /**
     * @param {string} title
     */
    start(title) {
        this.finish();
        this.#title = title;
        this.#transferStartedAt = null;
        this.#showTimer = setTimeout(() => {
            this.#showTimer = null;
            this.#build();
            this.#render();
        }, ProgressView.#SHOW_DELAY_MS);
    }

    /**
     * @param {OperationProgress} progress
     */
    update(progress) {
        this.#last = progress;
        this.#render();
    }

    finish() {
        if (this.#showTimer) {
            clearTimeout(this.#showTimer);
            this.#showTimer = null;
        }
        this.#box?.remove();
        this.#box = null;
        this.#last = null;
    }

    #build() {
        const box = document.createElement('div');
        box.className = 'progress-box';
        box.innerHTML = `
<div class="progress-title"></div>
<div class="progress-name"></div>
<div class="progress-bar current"><div class="progress-fill"></div></div>
<div class="progress-bar total"><div class="progress-fill"></div></div>
<div class="progress-counts"></div>
<div class="progress-actions"><button type="button" class="dialog-button"></button></div>`;
        const cancel = /** @type {HTMLButtonElement} */ (box.querySelector('button'));
        cancel.textContent = I18n.t('button.cancel');
        cancel.addEventListener('click', () => this.#onCancel());
        this.#root.appendChild(box);
        this.#box = box;
    }

    #render() {
        const box = this.#box;
        if (!box) {
            return;
        }
        const progress = this.#last;
        const knownPhase = progress?.phase !== undefined && ProgressView.#PHASES.has(progress.phase);
        const phase = knownPhase ? I18n.t(`phase.${progress?.phase}`) : '';
        this.#text(box, '.progress-title', phase ? `${this.#title} — ${phase}` : this.#title);
        this.#text(box, '.progress-name', progress?.currentName ?? '');
        const currentBar = /** @type {HTMLElement} */ (box.querySelector('.progress-bar.current'));
        const currentTotal = progress?.currentTotal ?? 0;
        const currentIsBig = currentTotal >= ProgressView.#CURRENT_BAR_MIN_BYTES;
        this.#fill(currentBar, currentIsBig ? progress?.currentDone ?? 0 : 0, currentTotal);
        const totalBar = /** @type {HTMLElement} */ (box.querySelector('.progress-bar.total'));
        if (progress?.total !== undefined) {
            this.#fill(totalBar, progress.done ?? 0, progress.total);
        } else {
            this.#fill(totalBar, progress?.doneFiles ?? 0, progress?.totalFiles ?? 0);
        }
        this.#text(box, '.progress-counts', this.#countsText(progress));
    }

    /**
     * @param {OperationProgress | null} progress
     * @returns {string}
     */
    #countsText(progress) {
        if (!progress) {
            return '';
        }
        const divisor = ProgressView.#COUNTED_TWICE.has(progress.kind) ? 2 : 1;
        if (progress.phase === 'scanning') {
            const bytes = progress.total ? `, ${Format.size(Math.round(progress.total / divisor), 'units')}` : '';
            return `${I18n.t('progress.found', { count: progress.totalFiles })}${bytes}`;
        }
        this.#transferStartedAt ??= Date.now();
        const files = I18n.t('progress.items', { done: progress.doneFiles, total: progress.totalFiles });
        if (progress.total === undefined || progress.total === 0) {
            return files;
        }
        const seconds = (Date.now() - this.#transferStartedAt) / 1000;
        const transferred = Math.round((progress.done ?? 0) / divisor);
        const speed = seconds > 0
            ? `, ${I18n.t('progress.speed', { speed: Format.size(Math.round(transferred / seconds), 'units') })}`
            : '';
        const total = Format.size(Math.round(progress.total / divisor), 'units');
        const bytes = I18n.t('progress.bytes', { done: Format.size(transferred, 'units'), total });
        return `${files}, ${bytes}${speed}`;
    }

    /**
     * @param {HTMLElement} bar
     * @param {number} done
     * @param {number} total
     */
    #fill(bar, done, total) {
        const fill = /** @type {HTMLElement} */ (bar.firstElementChild);
        const share = total > 0 ? Math.min(1, done / total) : 0;
        fill.style.width = `${(share * 100).toFixed(1)}%`;
    }

    /**
     * @param {HTMLElement} box
     * @param {string} selector
     * @param {string} text
     */
    #text(box, selector, text) {
        /** @type {HTMLElement} */ (box.querySelector(selector)).textContent = text;
    }
}
