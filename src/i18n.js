// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

/**
 * Texts of the interface in the language of the `fileManager.language` setting, or of VS Code with "auto".
 * A non-empty `fileManager.customTranslations` is a language of its own and wins over the setting. Whatever a
 * dictionary lacks comes from English. The webview gets the same dictionary.
 */
class I18n {
    /** the languages VS Code itself ships language packs for */
    static #LANGUAGES = new Set([
        'en', 'cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'zh-cn', 'zh-tw',
    ]);
    static #TRADITIONAL_CHINESE = new Set(['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant']);

    /** @type {Record<string, string>} */
    static #strings = {};
    static #language = 'en';

    /**
     * Reads the dictionaries again; called at activation and whenever the language settings change.
     * @param {string} extensionPath
     */
    static load(extensionPath) {
        const english = I18n.#read(extensionPath, 'en') ?? {};
        const settings = vscode.workspace.getConfiguration('fileManager');
        const custom = I18n.#customStrings(settings.get('customTranslations'));
        if (Object.keys(custom).length > 0) {
            I18n.#language = 'custom';
            I18n.#strings = { ...english, ...custom };
            return;
        }
        const chosen = settings.get('language');
        const language = I18n.#resolve(typeof chosen === 'string' && chosen !== 'auto' ? chosen : vscode.env.language);
        I18n.#language = language;
        I18n.#strings = language === 'en' ? english : { ...english, ...(I18n.#read(extensionPath, language) ?? {}) };
    }

    /**
     * @returns {Record<string, string>}
     */
    static get strings() {
        return I18n.#strings;
    }

    /**
     * @returns {string}
     */
    static get language() {
        return I18n.#language;
    }

    /**
     * @param {string} key
     * @param {Record<string, string | number>} [params]  replace {name} in the text
     * @returns {string}
     */
    static t(key, params = {}) {
        const template = I18n.#strings[key] ?? key;
        return template.replace(/\{(\w+)\}/g, (placeholder, name) => (
            name in params ? String(params[name]) : placeholder
        ));
    }

    /**
     * "pt" and "pt-pt" use the Brazilian dictionary, "zh-hk" the traditional Chinese one; anything without a
     * dictionary falls back to English.
     * @param {string} requested
     * @returns {string}
     */
    static #resolve(requested) {
        const language = requested.toLowerCase();
        if (I18n.#LANGUAGES.has(language)) {
            return language;
        }
        const base = language.split('-')[0];
        if (base === 'pt') {
            return 'pt-br';
        }
        if (base === 'zh') {
            return I18n.#TRADITIONAL_CHINESE.has(language) ? 'zh-tw' : 'zh-cn';
        }
        return I18n.#LANGUAGES.has(base) ? base : 'en';
    }

    /**
     * @param {string} extensionPath
     * @param {string} language
     * @returns {Record<string, string> | null}
     */
    static #read(extensionPath, language) {
        try {
            const file = path.join(extensionPath, 'i18n', `${language}.json`);
            return I18n.#customStrings(JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch {
            return null;
        }
    }

    /**
     * Only string values are taken; anything else in a user's dictionary is ignored.
     * @param {unknown} source
     * @returns {Record<string, string>}
     */
    static #customStrings(source) {
        /** @type {Record<string, string>} */
        const strings = {};
        if (source && typeof source === 'object' && !Array.isArray(source)) {
            for (const [key, value] of Object.entries(source)) {
                if (typeof value === 'string') {
                    strings[key] = value;
                }
            }
        }
        return strings;
    }
}

module.exports.I18n = I18n;
