// @ts-check
'use strict';

/**
 * @typedef {object} EntryProperties
 * @property {string} name
 * @property {string} location
 * @property {'folder' | 'file' | 'link' | 'other'} kind
 * @property {string | null} linkTarget
 * @property {boolean} linkBroken
 * @property {'folder' | 'file' | 'other' | null} linkTargetKind
 * @property {number | null} size
 * @property {number | null} birthtime
 * @property {number} mtime
 * @property {number} atime
 * @property {number | null} ctime
 * @property {number | null} mode
 * @property {string | null} owner
 * @property {number | null} winAttributes
 */

/**
 * @typedef {object} ContentCount
 * @property {number} bytes
 * @property {number} files
 * @property {number} folders
 * @property {number} skippedFolders
 * @property {boolean} done
 */

/**
 * The table of the properties dialog, for one entry or a selection. The size and content of folders arrive while
 * they are counted and fill in the same rows.
 */
class PropertiesView {
    /** System.IO.FileAttributes */
    static #WINDOWS_ATTRIBUTES = [
        [1, 'Read-only'],
        [2, 'Hidden'],
        [4, 'System'],
        [32, 'Archive'],
        [1024, 'Reparse point'],
        [2048, 'Compressed'],
        [16384, 'Encrypted'],
    ];

    #element;
    #entries;
    /** @type {HTMLElement | null} */
    #sizeCell = null;
    /** @type {HTMLElement | null} */
    #contentCell = null;
    #fileBytes;
    #hasFolders;

    /**
     * @param {EntryProperties[]} entries
     */
    constructor(entries) {
        this.#entries = entries;
        this.#fileBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
        this.#hasFolders = entries.some((entry) => entry.kind === 'folder');
        this.#element = document.createElement('div');
        this.#element.className = 'properties-table';
        if (entries.length === 1) {
            this.#buildSingle(entries[0]);
        } else {
            this.#buildSelection();
        }
    }

    /**
     * @returns {HTMLElement}
     */
    get element() {
        return this.#element;
    }

    /**
     * @param {ContentCount} count
     */
    updateContent(count) {
        const partial = count.skippedFolders > 0 ? ' (some folders could not be read)' : '';
        const pending = count.done ? '' : ' …';
        if (this.#sizeCell) {
            this.#sizeCell.textContent = PropertiesView.#sizeText(this.#fileBytes + count.bytes) + pending + partial;
        }
        if (this.#contentCell) {
            this.#contentCell.textContent = `${Format.groupDigits(count.files)} files, `
                + `${Format.groupDigits(count.folders)} folders${pending}${partial}`;
        }
    }

    /**
     * @param {EntryProperties} entry
     */
    #buildSingle(entry) {
        this.#row('Name', entry.name);
        this.#row('Location', entry.location);
        this.#row('Type', PropertiesView.#typeText(entry));
        if (entry.kind === 'link') {
            this.#row('Points to', `${entry.linkTarget ?? '?'}${entry.linkBroken ? ' (missing)' : ''}`);
        }
        if (entry.kind === 'folder') {
            this.#sizeCell = this.#row('Size', 'counting …');
            this.#contentCell = this.#row('Contains', 'counting …');
        } else if (entry.size !== null) {
            this.#row('Size', PropertiesView.#sizeText(entry.size));
        }
        const created = entry.birthtime === null
            ? 'not kept by this file system'
            : PropertiesView.#time(entry.birthtime);
        this.#row('Created', created);
        this.#row('Modified', PropertiesView.#time(entry.mtime));
        this.#row('Accessed', PropertiesView.#time(entry.atime));
        if (entry.ctime !== null) {
            this.#row('Metadata changed', PropertiesView.#time(entry.ctime));
        }
        this.#row('Attributes', PropertiesView.#attributesText(entry));
        if (entry.owner !== null) {
            this.#row('Owner', entry.owner);
        }
    }

    #buildSelection() {
        const folders = this.#entries.filter((entry) => entry.kind === 'folder').length;
        const links = this.#entries.filter((entry) => entry.kind === 'link').length;
        const files = this.#entries.length - folders - links;
        const parts = [`${folders} folders`, `${files} files`];
        if (links > 0) {
            parts.push(`${links} links`);
        }
        this.#row('Items', `${this.#entries.length}: ${parts.join(', ')}`);
        this.#row('Location', this.#entries[0].location);
        if (this.#hasFolders) {
            this.#sizeCell = this.#row('Size', 'counting …');
            this.#contentCell = this.#row('Folders contain', 'counting …');
        } else {
            this.#row('Size', PropertiesView.#sizeText(this.#fileBytes));
        }
    }

    /**
     * @param {string} label
     * @param {string} value
     * @returns {HTMLElement}  the value cell
     */
    #row(label, value) {
        const name = document.createElement('div');
        name.className = 'properties-label';
        name.textContent = label;
        const cell = document.createElement('div');
        cell.className = 'properties-value';
        cell.textContent = value;
        this.#element.append(name, cell);
        return cell;
    }

    /**
     * @param {EntryProperties} entry
     * @returns {string}
     */
    static #typeText(entry) {
        if (entry.kind === 'folder') {
            return 'Folder';
        }
        if (entry.kind === 'link') {
            const target = entry.linkTargetKind === 'folder' ? 'a folder' : 'a file';
            return entry.linkBroken ? 'Link, broken' : `Link to ${target}`;
        }
        if (entry.kind === 'other') {
            return 'Special file (device, socket or pipe)';
        }
        const { extension } = Format.splitName(entry.name, false);
        return extension ? `File (.${extension})` : 'File';
    }

    /**
     * @param {EntryProperties} entry
     * @returns {string}
     */
    static #attributesText(entry) {
        if (entry.winAttributes !== null) {
            const names = PropertiesView.#WINDOWS_ATTRIBUTES
                .filter(([bit]) => ((entry.winAttributes ?? 0) & /** @type {number} */ (bit)) !== 0)
                .map(([, label]) => label);
            return names.length > 0 ? names.join(', ') : 'none';
        }
        if (entry.mode !== null) {
            return `${Format.posixAttributes(entry.mode)}  (${(entry.mode & 0o7777).toString(8).padStart(3, '0')})`;
        }
        return '';
    }

    /**
     * @param {number} bytes
     * @returns {string}
     */
    static #sizeText(bytes) {
        const units = Format.size(bytes, 'units');
        return bytes < 1024 ? units : `${units} (${Format.groupDigits(bytes)} bytes)`;
    }

    /**
     * @param {number} timestamp
     * @returns {string}
     */
    static #time(timestamp) {
        const seconds = String(new Date(timestamp).getSeconds()).padStart(2, '0');
        return `${Format.date(timestamp)}:${seconds}`;
    }
}
