// @ts-check
'use strict';

const path = require('path');

/** @typedef {'posix' | 'powershell' | 'cmd'} ShellKind */

/**
 * A name or path typed into a terminal after whatever its command line holds, as one argument the shell takes
 * literally. It is quoted unless it has only letters, digits and plain path characters, and a leading dash gets
 * the current folder in front, so it does not read as an option. A control character is refused: a line break
 * would run the command line as it stands.
 */
class TerminalArgument {
    static #CONTROL = /[\u0000-\u001f\u007f]/;
    /** PowerShell takes the en dash, the em dash and the horizontal bar for "-" */
    static #LEADING_DASH = /^[-–—―]/;
    /** @type {Record<ShellKind, RegExp>} */
    static #PLAIN = {
        posix: /^[\p{L}\p{N}\p{M}_.\/:@%+,-]+$/u,
        powershell: /^[\p{L}\p{N}\p{M}_.\/\\:+-]+$/u,
        cmd: /^[\p{L}\p{N}\p{M}_.\/\\:+-]+$/u,
    };
    /** PowerShell ends a single-quoted string at the typographic single quotes too */
    static #POWERSHELL_QUOTES = /['‘’‚‛]/g;
    /** cmd expands %variables% inside double quotes, and a double quote cannot be escaped */
    static #CMD_UNQUOTABLE = /["%]/;

    /**
     * @param {string} shell  the shell type VS Code detected, or the path of the shell executable
     * @returns {ShellKind}
     */
    static shellKind(shell) {
        const name = (shell.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
        if (name === 'pwsh' || name === 'powershell') {
            return 'powershell';
        }
        return name === 'cmd' ? 'cmd' : 'posix';
    }

    /**
     * @param {string} text
     * @param {ShellKind} shellKind
     * @returns {string | null}  null when the text cannot be passed literally
     */
    static format(text, shellKind) {
        if (text === '' || TerminalArgument.#CONTROL.test(text)) {
            return null;
        }
        const argument = TerminalArgument.#LEADING_DASH.test(text) ? `.${path.sep}${text}` : text;
        if (TerminalArgument.#PLAIN[shellKind].test(argument)) {
            return argument;
        }
        switch (shellKind) {
            case 'powershell':
                return `'${argument.replace(TerminalArgument.#POWERSHELL_QUOTES, '$&$&')}'`;
            case 'cmd':
                return TerminalArgument.#CMD_UNQUOTABLE.test(argument) ? null : `"${argument}"`;
            default:
                return `'${argument.replaceAll("'", "'\\''")}'`;
        }
    }
}

module.exports.TerminalArgument = TerminalArgument;
