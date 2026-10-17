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
        [1, 'attributes.readOnly'],
        [2, 'attributes.hidden'],
        [4, 'attributes.system'],
        [32, 'attributes.archive'],
        [1024, 'attributes.reparsePoint'],
        [2048, 'attributes.compressed'],
        [16384, 'attributes.encrypted'],
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
        const partial = count.skippedFolders > 0 ? ` ${I18n.t('properties.unreadable')}` : '';
        const pending = count.done ? '' : ' …';
        if (this.#sizeCell) {
            this.#sizeCell.textContent = PropertiesView.#sizeText(this.#fileBytes + count.bytes) + pending + partial;
        }
        if (this.#contentCell) {
            const content = { files: Format.groupDigits(count.files), folders: Format.groupDigits(count.folders) };
            this.#contentCell.textContent = `${I18n.t('properties.content', content)}${pending}${partial}`;
        }
    }

    /**
     * @param {EntryProperties} entry
     */
    #buildSingle(entry) {
        this.#row('properties.name', entry.name);
        this.#row('properties.location', entry.location);
        this.#row('properties.type', PropertiesView.#typeText(entry));
        if (entry.kind === 'link') {
            const missing = entry.linkBroken ? ` ${I18n.t('properties.missing')}` : '';
            this.#row('properties.pointsTo', `${entry.linkTarget ?? '?'}${missing}`);
        }
        if (entry.kind === 'folder') {
            this.#sizeCell = this.#row('properties.size', I18n.t('properties.counting'));
            this.#contentCell = this.#row('properties.contains', I18n.t('properties.counting'));
        } else if (entry.size !== null) {
            this.#row('properties.size', PropertiesView.#sizeText(entry.size));
        }
        const created = entry.birthtime === null
            ? I18n.t('properties.notKept')
            : PropertiesView.#time(entry.birthtime);
        this.#row('properties.created', created);
        this.#row('properties.modified', PropertiesView.#time(entry.mtime));
        this.#row('properties.accessed', PropertiesView.#time(entry.atime));
        if (entry.ctime !== null) {
            this.#row('properties.metadataChanged', PropertiesView.#time(entry.ctime));
        }
        this.#row('properties.attributes', PropertiesView.#attributesText(entry));
        if (entry.owner !== null) {
            this.#row('properties.owner', entry.owner);
        }
    }

    #buildSelection() {
        const folders = this.#entries.filter((entry) => entry.kind === 'folder').length;
        const links = this.#entries.filter((entry) => entry.kind === 'link').length;
        const files = this.#entries.length - folders - links;
        const breakdown = { total: this.#entries.length, folders, files, links };
        this.#row('properties.items', I18n.t('properties.itemsBreakdown', breakdown));
        this.#row('properties.location', this.#entries[0].location);
        if (this.#hasFolders) {
            this.#sizeCell = this.#row('properties.size', I18n.t('properties.counting'));
            this.#contentCell = this.#row('properties.foldersContain', I18n.t('properties.counting'));
        } else {
            this.#row('properties.size', PropertiesView.#sizeText(this.#fileBytes));
        }
    }

    /**
     * @param {string} labelKey
     * @param {string} value
     * @returns {HTMLElement}  the value cell
     */
    #row(labelKey, value) {
        const name = document.createElement('div');
        name.className = 'properties-label';
        name.textContent = I18n.t(labelKey);
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
            return I18n.t('type.folder');
        }
        if (entry.kind === 'link') {
            if (entry.linkBroken) {
                return I18n.t('type.linkBroken');
            }
            return I18n.t(entry.linkTargetKind === 'folder' ? 'type.linkToFolder' : 'type.linkToFile');
        }
        if (entry.kind === 'other') {
            return I18n.t('type.special');
        }
        const { extension } = Format.splitName(entry.name, false);
        return extension ? I18n.t('type.fileWithExtension', { extension }) : I18n.t('type.file');
    }

    /**
     * @param {EntryProperties} entry
     * @returns {string}
     */
    static #attributesText(entry) {
        if (entry.winAttributes !== null) {
            const names = PropertiesView.#WINDOWS_ATTRIBUTES
                .filter(([bit]) => ((entry.winAttributes ?? 0) & /** @type {number} */ (bit)) !== 0)
                .map(([, labelKey]) => I18n.t(/** @type {string} */ (labelKey)));
            return names.length > 0 ? names.join(', ') : I18n.t('attributes.none');
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
        return bytes < 1024 ? units : I18n.t('properties.bytes', { size: units, bytes: Format.groupDigits(bytes) });
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
