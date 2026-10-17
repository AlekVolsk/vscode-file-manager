// @ts-check
'use strict';

class Format {
    static #UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

    /** 1024 = one unit step */
    static #UNIT_STEP = 1024;

    /** S_IFMT and the file type bits under it */
    static #TYPE_MASK = 0o170000;
    static #TYPE_CHARS = new Map([
        [0o040000, 'd'],
        [0o120000, 'l'],
        [0o020000, 'c'],
        [0o060000, 'b'],
        [0o010000, 'p'],
        [0o140000, 's'],
    ]);

    /** System.IO.FileAttributes: ReadOnly, Archive, Hidden, System — in the order Total Commander shows them. */
    static #WINDOWS_ATTRIBUTES = [
        [1, 'r'],
        [32, 'a'],
        [2, 'h'],
        [4, 's'],
    ];

    /**
     * @param {number} bytes
     * @param {'units' | 'bytes'} mode
     * @returns {string}
     */
    static size(bytes, mode) {
        if (mode === 'bytes' || bytes < Format.#UNIT_STEP) {
            return `${Format.groupDigits(bytes)}${mode === 'bytes' ? '' : ' B'}`;
        }
        let value = bytes / Format.#UNIT_STEP;
        let unit = 0;
        while (value >= Format.#UNIT_STEP && unit < Format.#UNITS.length - 1) {
            value /= Format.#UNIT_STEP;
            unit++;
        }
        return `${value.toFixed(2)} ${Format.#UNITS[unit]}`;
    }

    /**
     * @param {number} value
     * @returns {string}
     */
    static groupDigits(value) {
        return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }

    /**
     * @param {number | null} timestamp
     * @returns {string}
     */
    static date(timestamp) {
        if (timestamp === null) {
            return '';
        }
        const date = new Date(timestamp);
        const pad = (/** @type {number} */ value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
            + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * `drwxr-xr-x` from POSIX mode bits.
     * @param {number} mode
     * @returns {string}
     */
    static posixAttributes(mode) {
        const type = Format.#TYPE_CHARS.get(mode & Format.#TYPE_MASK) ?? '-';
        /**
         * @param {number} shift
         * @param {number} specialBit
         * @param {string} special
         */
        const triplet = (shift, specialBit, special) => {
            const read = mode & (4 << shift) ? 'r' : '-';
            const write = mode & (2 << shift) ? 'w' : '-';
            const execute = (mode & (1 << shift)) !== 0;
            const executeChar = mode & specialBit
                ? (execute ? special : special.toUpperCase())
                : (execute ? 'x' : '-');
            return `${read}${write}${executeChar}`;
        };
        return `${type}${triplet(6, 0o4000, 's')}${triplet(3, 0o2000, 's')}${triplet(0, 0o1000, 't')}`;
    }

    /**
     * `ra--` from System.IO.FileAttributes bits.
     * @param {number} attributes
     * @returns {string}
     */
    static windowsAttributes(attributes) {
        return Format.#WINDOWS_ATTRIBUTES
            .map(([bit, char]) => ((attributes & /** @type {number} */ (bit)) !== 0 ? char : '-'))
            .join('');
    }

    /**
     * Name and extension as the two columns show them. Folders and dot-files without a further dot have no extension.
     * @param {string} name
     * @param {boolean} isDir
     * @returns {{ base: string, extension: string }}
     */
    static splitName(name, isDir) {
        const dot = name.lastIndexOf('.');
        if (isDir || dot <= 0 || dot === name.length - 1) {
            return { base: name, extension: '' };
        }
        return { base: name.slice(0, dot), extension: name.slice(dot + 1) };
    }

    /**
     * Clickable parts of a path, from the root down: `/mnt/d` → "/", "mnt", "d"; `C:\Users` → "C:", "Users";
     * `\\server\share\x` → "\\server\share", "x"; the Windows drive list '' → "Drives".
     * @param {string} fullPath
     * @param {'win' | 'linux' | 'mac'} platformKind
     * @returns {{ label: string, path: string, separatorBefore: string }[]}
     */
    static pathSegments(fullPath, platformKind) {
        if (platformKind === 'win') {
            if (fullPath === '') {
                return [{ label: I18n.t('panel.drives'), path: '', separatorBefore: '' }];
            }
            const unc = /^(\\\\[^\\]+\\[^\\]+)\\?/.exec(fullPath);
            const drive = /^([a-zA-Z]:)\\?/.exec(fullPath);
            const rootMatch = unc ?? drive;
            if (!rootMatch) {
                return [{ label: fullPath, path: fullPath, separatorBefore: '' }];
            }
            const root = { label: rootMatch[1], path: `${rootMatch[1]}\\`, separatorBefore: '' };
            return Format.#appendSegments([root], fullPath.slice(rootMatch[0].length).split('\\'), '\\', '\\');
        }
        const root = { label: '/', path: '/', separatorBefore: '' };
        return Format.#appendSegments([root], fullPath.split('/'), '/', '');
    }

    /**
     * @param {{ label: string, path: string, separatorBefore: string }[]} segments  starting with the root
     * @param {string[]} parts
     * @param {string} separator
     * @param {string} separatorAfterRoot  shown between the root and the first part
     * @returns {{ label: string, path: string, separatorBefore: string }[]}
     */
    static #appendSegments(segments, parts, separator, separatorAfterRoot) {
        let current = segments[0].path;
        for (const part of parts.filter((candidate) => candidate !== '')) {
            current = current.endsWith(separator) ? `${current}${part}` : `${current}${separator}${part}`;
            const separatorBefore = segments.length === 1 ? separatorAfterRoot : separator;
            segments.push({ label: part, path: current, separatorBefore });
        }
        return segments;
    }

    /**
     * Text put into markup: translations may come from the user's own dictionary.
     * @param {string} text
     * @returns {string}
     */
    static escapeHtml(text) {
        return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
    }

    /**
     * The archives a panel can enter; the extension host decides the same by the same endings.
     * @param {string} name
     * @returns {boolean}
     */
    static isArchiveName(name) {
        return /\.(zip|tar\.gz|tgz|tar)$/i.test(name);
    }

    /**
     * Last segment of a path in either separator style; for a drive root "C:\" it is "C:".
     * @param {string} fullPath
     * @returns {string}
     */
    static lastSegment(fullPath) {
        const segments = fullPath.split(/[\\/]/).filter((segment) => segment !== '');
        return segments.length > 0 ? segments[segments.length - 1] : '';
    }
}
