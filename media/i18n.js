// @ts-check
'use strict';

/**
 * The texts of the interface, as the extension host chose them for the language in the settings.
 */
class I18n {
    /** @type {Record<string, string>} */
    static #strings = {};

    /**
     * @param {Record<string, string>} strings
     */
    static set(strings) {
        I18n.#strings = strings;
    }

    /**
     * @param {string} key
     * @param {Record<string, string | number>} [params]  replace {name} in the text; {ctrl}, {shift} and {alt}
     *     are the modifier keys of the platform
     * @returns {string}
     */
    static t(key, params = {}) {
        const template = I18n.#strings[key] ?? key;
        const values = { ...Keys.names, ...params };
        return template.replace(/\{(\w+)\}/g, (placeholder, name) => (
            name in values ? String(values[name]) : placeholder
        ));
    }
}
