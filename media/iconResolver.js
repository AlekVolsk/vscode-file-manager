// @ts-check
'use strict';

/**
 * @typedef {object} IconDefinition
 * @property {string} [src]
 * @property {string} [char]
 * @property {string} [color]
 * @property {string} [fontId]
 * @property {string} [fontSize]
 */

/**
 * @typedef {object} IconFont
 * @property {string} id
 * @property {{ src: string, format: string }[]} src
 * @property {string} [weight]
 * @property {string} [style]
 * @property {string} [size]
 */

/**
 * @typedef {object} IconMapping
 * @property {string} [file]
 * @property {string} [folder]
 * @property {Record<string, string>} [fileExtensions]
 * @property {Record<string, string>} [fileNames]
 * @property {Record<string, string>} [folderNames]
 * @property {Record<string, string>} [languageIds]
 */

/**
 * @typedef {object} IconTheme
 * @property {string} id
 * @property {Record<string, IconDefinition>} definitions
 * @property {IconFont[]} fonts
 * @property {IconMapping} base
 * @property {IconMapping | null} light
 * @property {IconMapping | null} highContrast
 * @property {{ byExtension: Record<string, string>, byFileName: Record<string, string> }} languages
 */

/**
 * Picks the icon of a list entry from the file icon theme in the order VS Code uses: file name, extension from the
 * longest, language, then the generic file or folder icon. Falls back to SvgIcons when there is no theme.
 */
class IconResolver {
    /** @type {IconTheme | null} */
    #theme = null;
    #nonce;
    /** @type {HTMLStyleElement | null} */
    #fontStyle = null;

    /**
     * @param {string} nonce  lets the font-face rules of the theme pass the content security policy
     */
    constructor(nonce) {
        this.#nonce = nonce;
    }

    /**
     * @param {IconTheme | null} theme
     */
    setTheme(theme) {
        this.#theme = theme;
        this.#fontStyle?.remove();
        this.#fontStyle = null;
        if (!theme || theme.fonts.length === 0) {
            return;
        }
        const style = document.createElement('style');
        style.nonce = this.#nonce;
        style.textContent = theme.fonts.map((font) => {
            const sources = font.src.map((source) => `url("${source.src}") format("${source.format}")`).join(', ');
            return `@font-face { font-family: "${IconResolver.#fontFamily(font.id)}"; src: ${sources};`
                + ` font-weight: ${font.weight ?? 'normal'}; font-style: ${font.style ?? 'normal'}; }`;
        }).join('\n');
        document.head.appendChild(style);
        this.#fontStyle = style;
    }

    /**
     * Fills `target` with the icon of an entry.
     * @param {HTMLElement} target
     * @param {{ name: string, isDir: boolean, isParent?: boolean, drive?: unknown }} entry
     */
    render(target, entry) {
        if (entry.isParent) {
            target.innerHTML = SvgIcons.PARENT;
            return;
        }
        if (entry.drive) {
            target.innerHTML = SvgIcons.DRIVE;
            return;
        }
        const definition = this.#theme ? this.#definitionFor(this.#theme, entry.name, entry.isDir) : null;
        if (definition?.src) {
            const image = document.createElement('img');
            image.className = 'theme-icon';
            image.src = definition.src;
            image.alt = '';
            target.replaceChildren(image);
            return;
        }
        if (definition?.char && this.#theme) {
            const glyph = document.createElement('span');
            glyph.className = 'theme-glyph';
            glyph.textContent = definition.char;
            const fontId = definition.fontId ?? this.#theme.fonts[0]?.id;
            if (fontId) {
                glyph.style.fontFamily = `"${IconResolver.#fontFamily(fontId)}"`;
            }
            const font = this.#theme.fonts.find((candidate) => candidate.id === fontId);
            const fontSize = definition.fontSize ?? font?.size;
            if (fontSize) {
                glyph.style.fontSize = fontSize;
            }
            if (definition.color) {
                glyph.style.color = definition.color;
            }
            target.replaceChildren(glyph);
            return;
        }
        target.innerHTML = entry.isDir ? SvgIcons.FOLDER : SvgIcons.FILE;
    }

    /**
     * @param {IconTheme} theme
     * @param {string} name
     * @param {boolean} isDir
     * @returns {IconDefinition | null}
     */
    #definitionFor(theme, name, isDir) {
        const mappings = [this.#variantMapping(theme), theme.base].filter((mapping) => mapping !== null);
        const lowerName = name.toLowerCase();
        const lookup = (/** @type {(mapping: IconMapping) => string | undefined} */ pick) => {
            for (const mapping of mappings) {
                const id = pick(mapping);
                if (id !== undefined && theme.definitions[id]) {
                    return theme.definitions[id];
                }
            }
            return null;
        };
        if (isDir) {
            return lookup((mapping) => mapping.folderNames?.[lowerName]) ?? lookup((mapping) => mapping.folder);
        }
        const suffixes = IconResolver.#extensionSuffixes(lowerName);
        const byName = lookup((mapping) => mapping.fileNames?.[lowerName]);
        if (byName) {
            return byName;
        }
        for (const suffix of suffixes) {
            const byExtension = lookup((mapping) => mapping.fileExtensions?.[suffix]);
            if (byExtension) {
                return byExtension;
            }
        }
        const language = theme.languages.byFileName[lowerName]
            ?? suffixes.map((suffix) => theme.languages.byExtension[suffix]).find((id) => id !== undefined);
        const byLanguage = language ? lookup((mapping) => mapping.languageIds?.[language]) : null;
        return byLanguage ?? lookup((mapping) => mapping.file);
    }

    /**
     * @param {IconTheme} theme
     * @returns {IconMapping | null}
     */
    #variantMapping(theme) {
        const classes = document.body.classList;
        if (classes.contains('vscode-high-contrast') || classes.contains('vscode-high-contrast-light')) {
            return theme.highContrast;
        }
        return classes.contains('vscode-light') ? theme.light : null;
    }

    /**
     * "a.test.ts" → ["test.ts", "ts"]; ".eslintrc.json" → ["eslintrc.json", "json"].
     * @param {string} lowerName
     * @returns {string[]}
     */
    static #extensionSuffixes(lowerName) {
        const suffixes = [];
        let dot = lowerName.indexOf('.');
        while (dot !== -1 && dot < lowerName.length - 1) {
            suffixes.push(lowerName.slice(dot + 1));
            dot = lowerName.indexOf('.', dot + 1);
        }
        return suffixes;
    }

    /**
     * @param {string} fontId
     * @returns {string}
     */
    static #fontFamily(fontId) {
        return `fm-icon-font-${fontId}`;
    }
}
