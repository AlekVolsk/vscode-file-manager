// @ts-check
'use strict';

const { Platform } = require('./platform');

/** @typedef {'windows' | 'mac' | 'posix'} NameRules */

/**
 * Names typed by the user, checked before anything touches the disk. Under WSL the Windows rules apply: the same
 * folders are reached from Windows, and a name valid only for Linux breaks there.
 */
class NameValidator {
    static #WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/;
    static #WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
    static #MAC_FORBIDDEN = /[/:\u0000]/;
    static #POSIX_FORBIDDEN = /[/\u0000]/;
    static #MAX_NAME_LENGTH = 255;

    /**
     * @returns {NameRules}
     */
    static get rules() {
        if (Platform.kind === 'win' || Platform.isWsl) {
            return 'windows';
        }
        return Platform.kind === 'mac' ? 'mac' : 'posix';
    }

    /**
     * @param {string} name
     * @param {NameRules} [rules]
     * @returns {string | null}  what is wrong with the name, or null when it is valid
     */
    static problemOf(name, rules = NameValidator.rules) {
        if (name.trim() === '') {
            return 'The name is empty.';
        }
        if (name === '.' || name === '..') {
            return `"${name}" cannot be used as a name.`;
        }
        if (rules === 'windows') {
            return NameValidator.#windowsProblemOf(name);
        }
        const forbidden = rules === 'mac' ? NameValidator.#MAC_FORBIDDEN : NameValidator.#POSIX_FORBIDDEN;
        if (forbidden.test(name)) {
            return rules === 'mac' ? 'A name cannot contain / or :.' : 'A name cannot contain /.';
        }
        if (Buffer.byteLength(name, 'utf8') > NameValidator.#MAX_NAME_LENGTH) {
            return `A name cannot be longer than ${NameValidator.#MAX_NAME_LENGTH} bytes.`;
        }
        return null;
    }

    /**
     * @param {string} name
     * @returns {string | null}
     */
    static #windowsProblemOf(name) {
        if (NameValidator.#WINDOWS_FORBIDDEN.test(name)) {
            return 'A name cannot contain < > : " / \\ | ? * or control characters.';
        }
        if (NameValidator.#WINDOWS_RESERVED.test(name)) {
            return `"${name}" is a reserved device name in Windows.`;
        }
        if (/[. ]$/.test(name)) {
            return 'A name cannot end with a dot or a space in Windows.';
        }
        if (name.length > NameValidator.#MAX_NAME_LENGTH) {
            return `A name cannot be longer than ${NameValidator.#MAX_NAME_LENGTH} characters.`;
        }
        return null;
    }
}

module.exports.NameValidator = NameValidator;
