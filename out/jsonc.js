// @ts-check
'use strict';

class Jsonc {
    /**
     * JSON with comments and trailing commas, as VS Code accepts in theme files.
     * @param {string} text
     * @returns {unknown}
     */
    static parse(text) {
        return JSON.parse(Jsonc.#stripTrailingCommas(Jsonc.#stripComments(text)));
    }

    /**
     * @param {string} text
     * @returns {string}
     */
    static #stripComments(text) {
        let result = '';
        let i = 0;
        while (i < text.length) {
            const char = text[i];
            if (char === '"') {
                const end = Jsonc.#stringEnd(text, i);
                result += text.slice(i, end);
                i = end;
            } else if (char === '/' && text[i + 1] === '/') {
                while (i < text.length && text[i] !== '\n') {
                    i++;
                }
            } else if (char === '/' && text[i + 1] === '*') {
                const end = text.indexOf('*/', i + 2);
                i = end === -1 ? text.length : end + 2;
            } else {
                result += char;
                i++;
            }
        }
        return result;
    }

    /**
     * @param {string} text
     * @returns {string}
     */
    static #stripTrailingCommas(text) {
        let result = '';
        let i = 0;
        while (i < text.length) {
            const char = text[i];
            if (char === '"') {
                const end = Jsonc.#stringEnd(text, i);
                result += text.slice(i, end);
                i = end;
                continue;
            }
            if (char === ',') {
                let next = i + 1;
                while (next < text.length && /\s/.test(text[next])) {
                    next++;
                }
                if (text[next] === '}' || text[next] === ']') {
                    i++;
                    continue;
                }
            }
            result += char;
            i++;
        }
        return result;
    }

    /**
     * Index just past the closing quote of the string that opens at `start`.
     * @param {string} text
     * @param {number} start
     * @returns {number}
     */
    static #stringEnd(text, start) {
        let i = start + 1;
        while (i < text.length && text[i] !== '"') {
            i += text[i] === '\\' ? 2 : 1;
        }
        return i + 1;
    }
}

module.exports.Jsonc = Jsonc;
