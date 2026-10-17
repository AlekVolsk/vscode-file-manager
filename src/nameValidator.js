// @ts-check
'use strict';

const { Platform } = require('./platform');
const { I18n } = require('./i18n');

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
            return I18n.t('error.nameEmpty');
        }
        if (name === '.' || name === '..') {
            return I18n.t('error.nameDots', { name });
        }
        if (rules === 'windows') {
            return NameValidator.#windowsProblemOf(name);
        }
        const forbidden = rules === 'mac' ? NameValidator.#MAC_FORBIDDEN : NameValidator.#POSIX_FORBIDDEN;
        if (forbidden.test(name)) {
            return I18n.t(rules === 'mac' ? 'error.nameSlashMac' : 'error.nameSlash');
        }
        if (Buffer.byteLength(name, 'utf8') > NameValidator.#MAX_NAME_LENGTH) {
            return I18n.t('error.nameTooLongBytes', { max: NameValidator.#MAX_NAME_LENGTH });
        }
        return null;
    }

    /**
     * @param {string} name
     * @returns {string | null}
     */
    static #windowsProblemOf(name) {
        if (NameValidator.#WINDOWS_FORBIDDEN.test(name)) {
            return I18n.t('error.nameWindowsChars');
        }
        if (NameValidator.#WINDOWS_RESERVED.test(name)) {
            return I18n.t('error.nameReserved', { name });
        }
        if (/[. ]$/.test(name)) {
            return I18n.t('error.nameTrailing');
        }
        if (name.length > NameValidator.#MAX_NAME_LENGTH) {
            return I18n.t('error.nameTooLong', { max: NameValidator.#MAX_NAME_LENGTH });
        }
        return null;
    }
}

module.exports.NameValidator = NameValidator;
