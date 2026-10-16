// @ts-check
'use strict';

/**
 * Icons drawn in `currentColor`, so they follow the theme: toolbar buttons, and the list icons when no file icon
 * theme can be read.
 */
class SvgIcons {
    static FOLDER = SvgIcons.#svg('M1.5 3h4.3l1.5 1.5h7.2v8.5H1.5z');
    static FILE = SvgIcons.#svg('M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3');
    static DRIVE = SvgIcons.#svg('M1.5 9.5h13v4h-13zM2.5 9.5l2-6h7l2 6M11.5 11.5h1');
    static PARENT = SvgIcons.#svg('M8 13V3M3.5 7.5L8 3l4.5 4.5');
    static HOME = SvgIcons.#svg('M2 8l6-5.5L14 8M3.5 6.8v7h3.5v-4h2v4h3.5v-7');
    static PROJECT = SvgIcons.#svg('M1.5 3h4.3l1.5 1.5h7.2v8.5H1.5zM5 8.5h6M5 10.8h4');
    static REVEAL = SvgIcons.#svg('M1.5 3h4.3l1.5 1.5h7.2v8.5H1.5zM7 11l4-4M8 7h3v3');
    static ROOT = SvgIcons.#svg('M3 3h10M8 3v10M5 13h6');
    static NEW_FOLDER = SvgIcons.#svg('M1.5 3h4.3l1.5 1.5h7.2v8.5H1.5zM8 6.8v4.4M5.8 9h4.4');
    static NEW_FILE = SvgIcons.#svg('M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M8 7.3v4.4M5.8 9.5h4.4');
    static RENAME = SvgIcons.#svg('M1.5 5h13v6h-13zM9 3v10M7.8 3h2.4M7.8 13h2.4');
    static COPY = SvgIcons.#svg('M5.5 4.5h7v9h-7zM3.5 11.5v-9h7');
    static MOVE = SvgIcons.#svg('M1.5 8h8.5M7.5 5.5L10 8l-2.5 2.5M12.5 3v10');
    static PROPERTIES = SvgIcons.#svg('M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM8 7v4.5M8 4.6v.8');
    static ATTRIBUTES = SvgIcons.#svg('M2 4h12M2 8h12M2 12h12M5.5 2.5v3M10.5 6.5v3M7 10.5v3');
    static PACK = SvgIcons.#svg('M2.5 5.5h11v8h-11zM2.5 5.5l1.5-3h8l1.5 3M8 7v4M6.5 9.5L8 11l1.5-1.5');
    static UNPACK = SvgIcons.#svg('M2.5 5.5h11v8h-11zM2.5 5.5l1.5-3h8l1.5 3M8 11V7M6.5 8.5L8 7l1.5 1.5');
    static TEST = SvgIcons.#svg('M2.5 5.5h11v8h-11zM2.5 5.5l1.5-3h8l1.5 3M5.5 9.5l2 2 3-3.5');
    static DELETE = SvgIcons.#svg('M2.5 4.5h11M6.3 4.5V2.8h3.4v1.7M4 4.5l.8 9h6.4l.8-9');
    static HIDDEN = SvgIcons.#svg(
        'M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
    );

    /**
     * @param {string} path
     * @returns {string}
     */
    static #svg(path) {
        return `<svg class="svg-icon" viewBox="0 0 16 16" aria-hidden="true">`
            + `<path d="${path}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
    }
}
