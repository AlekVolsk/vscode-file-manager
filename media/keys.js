// @ts-check
'use strict';

/**
 * Modifier keys of the platform. On macOS ⌘ does what Ctrl does elsewhere, and shortcuts are written with the
 * Mac symbols: ⌘U, ⌥⇧Enter. Elsewhere Shift is written short: Sh+F4.
 */
class Keys {
    static #mac = false;
    /** the order Apple writes modifiers in */
    static #ORDER = '⌥⇧⌘';

    /**
     * @param {'win' | 'linux' | 'mac'} platformKind
     */
    static setPlatform(platformKind) {
        Keys.#mac = platformKind === 'mac';
    }

    /**
     * Names for the {ctrl}, {shift} and {alt} placeholders of the texts.
     * @returns {Record<string, string>}
     */
    static get names() {
        return Keys.#mac
            ? { ctrl: '⌘', shift: '⇧', alt: '⌥' }
            : { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' };
    }

    /**
     * Ctrl, or ⌘ on macOS, where Control+click opens the context menu.
     * @param {MouseEvent | KeyboardEvent} event
     * @returns {boolean}
     */
    static command(event) {
        return Keys.#mac ? event.metaKey : event.ctrlKey;
    }

    /**
     * The other of Ctrl and ⌘, which no shortcut here uses.
     * @param {MouseEvent | KeyboardEvent} event
     * @returns {boolean}
     */
    static unused(event) {
        return Keys.#mac ? event.ctrlKey : event.metaKey;
    }

    /**
     * Writes a shortcut such as "Alt+Shift+Enter" the way of the platform. A modifier before a word in lower case
     * keeps its "+": ⌘+click.
     * @param {string} shortcut
     * @returns {string}
     */
    static label(shortcut) {
        if (!Keys.#mac) {
            return shortcut.replace(/\bShift\+/g, 'Sh+');
        }
        return shortcut
            .replace(/\bCtrl\+/g, '⌘+')
            .replace(/\bShift\+/g, '⇧+')
            .replace(/\bAlt\+/g, '⌥+')
            .replace(/([⌘⇧⌥])\+(?!\p{Ll})/gu, '$1')
            .replace(/[⌘⇧⌥]{2,}/g, (run) => (
                [...run].sort((x, y) => Keys.#ORDER.indexOf(x) - Keys.#ORDER.indexOf(y)).join('')
            ));
    }
}
