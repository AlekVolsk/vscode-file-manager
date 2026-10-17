// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { Common } = require('./common');
const { Jsonc } = require('./jsonc');
const { I18n } = require('./i18n');

/**
 * @typedef {object} IconDefinition
 * @property {string} [src]       webview URI of an SVG/PNG
 * @property {string} [char]      glyph of an icon font
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
 * @typedef {object} LoadedIconTheme
 * @property {IconTheme} theme
 * @property {vscode.Uri} extensionUri  must be among the webview's local resource roots
 * @property {string} themeFile
 */

/**
 * @typedef {object} ThemeContribution
 * @property {string} extensionPath
 * @property {string} path  of the theme file, relative to the extension
 */

/**
 * Reads the file icon theme chosen in `workbench.iconTheme` from the extension that contributes it, so the panels
 * show the same icons as the Explorer.
 */
class IconThemeLoader {
    /**
     * @param {vscode.Webview} webview
     * @returns {Promise<{ theme: LoadedIconTheme | null, error: string | null }>}
     */
    static async load(webview) {
        const themeId = vscode.workspace.getConfiguration('workbench').get('iconTheme');
        if (typeof themeId !== 'string' || themeId === '') {
            return { theme: null, error: null };
        }
        const contribution = IconThemeLoader.#findContribution(themeId);
        if (!contribution) {
            return { theme: null, error: I18n.t('error.iconThemeMissing', { theme: themeId }) };
        }
        const themeFile = path.join(contribution.extensionPath, contribution.path);
        try {
            const text = await fs.promises.readFile(themeFile, 'utf8');
            const json = /** @type {Record<string, any>} */ (Jsonc.parse(text));
            const themeDir = path.dirname(themeFile);
            return {
                theme: {
                    theme: {
                        id: themeId,
                        definitions: IconThemeLoader.#definitions(json.iconDefinitions ?? {}, themeDir, webview),
                        fonts: IconThemeLoader.#fonts(json.fonts ?? [], themeDir, webview),
                        base: IconThemeLoader.#mapping(json),
                        light: json.light ? IconThemeLoader.#mapping(json.light) : null,
                        highContrast: json.highContrast ? IconThemeLoader.#mapping(json.highContrast) : null,
                        languages: IconThemeLoader.#languages(),
                    },
                    extensionUri: vscode.Uri.file(contribution.extensionPath),
                    themeFile,
                },
                error: null,
            };
        } catch (error) {
            const details = Common.errorMessage(error);
            return { theme: null, error: I18n.t('error.iconTheme', { theme: themeId, details }) };
        }
    }

    /**
     * Folder of the extension contributing the current icon theme, known before the theme file is read, so the
     * webview gets it as a resource root from the start.
     * @returns {vscode.Uri | null}
     */
    static currentThemeExtensionUri() {
        const themeId = vscode.workspace.getConfiguration('workbench').get('iconTheme');
        if (typeof themeId !== 'string') {
            return null;
        }
        const contribution = IconThemeLoader.#findContribution(themeId);
        return contribution ? vscode.Uri.file(contribution.extensionPath) : null;
    }

    /**
     * The theme's extension among those of this extension host, or else on disk next to this extension: under
     * Remote-WSL an extension that prefers the UI side runs on Windows and is not listed here, though its copy is
     * installed in the same folder as this one.
     * @param {string} themeId
     * @returns {ThemeContribution | null}
     */
    static #findContribution(themeId) {
        for (const extension of vscode.extensions.all) {
            const themePath = IconThemeLoader.#themePathIn(extension.packageJSON, themeId);
            if (themePath !== null) {
                return { extensionPath: extension.extensionPath, path: themePath };
            }
        }
        return IconThemeLoader.#findInstalled(themeId);
    }

    /**
     * @param {string} themeId
     * @returns {ThemeContribution | null}
     */
    static #findInstalled(themeId) {
        const extensionsDir = path.dirname(path.dirname(__dirname));
        let folders;
        try {
            folders = fs.readdirSync(extensionsDir, { withFileTypes: true })
                .filter((dirent) => dirent.isDirectory() || dirent.isSymbolicLink())
                .map((dirent) => dirent.name);
        } catch {
            return null;
        }
        const obsolete = IconThemeLoader.#obsoleteFolders(extensionsDir);
        const collator = new Intl.Collator(undefined, { numeric: true });
        folders.sort((a, b) => collator.compare(b, a));
        for (const folder of folders) {
            if (obsolete.has(folder)) {
                continue;
            }
            const extensionPath = path.join(extensionsDir, folder);
            try {
                const packageJson = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
                const themePath = IconThemeLoader.#themePathIn(packageJson, themeId);
                if (themePath !== null) {
                    return { extensionPath, path: themePath };
                }
            } catch {
                continue;
            }
        }
        return null;
    }

    /**
     * Folders of uninstalled or replaced versions that VS Code has not deleted yet.
     * @param {string} extensionsDir
     * @returns {Set<string>}
     */
    static #obsoleteFolders(extensionsDir) {
        try {
            const obsolete = JSON.parse(fs.readFileSync(path.join(extensionsDir, '.obsolete'), 'utf8'));
            return new Set(Object.keys(obsolete ?? {}));
        } catch {
            return new Set();
        }
    }

    /**
     * @param {any} packageJson
     * @param {string} themeId
     * @returns {string | null}
     */
    static #themePathIn(packageJson, themeId) {
        const themes = packageJson?.contributes?.iconThemes;
        if (!Array.isArray(themes)) {
            return null;
        }
        const theme = themes.find((candidate) => candidate?.id === themeId);
        return theme && typeof theme.path === 'string' ? theme.path : null;
    }

    /**
     * @param {Record<string, any>} source
     * @param {string} themeDir
     * @param {vscode.Webview} webview
     * @returns {Record<string, IconDefinition>}
     */
    static #definitions(source, themeDir, webview) {
        /** @type {Record<string, IconDefinition>} */
        const definitions = {};
        for (const [id, definition] of Object.entries(source)) {
            if (typeof definition?.iconPath === 'string') {
                definitions[id] = { src: IconThemeLoader.#webviewUri(webview, themeDir, definition.iconPath) };
            } else if (typeof definition?.fontCharacter === 'string') {
                definitions[id] = {
                    char: IconThemeLoader.#fontCharacter(definition.fontCharacter),
                    color: definition.fontColor,
                    fontId: definition.fontId,
                    fontSize: definition.fontSize,
                };
            }
        }
        return definitions;
    }

    /**
     * @param {any[]} source
     * @param {string} themeDir
     * @param {vscode.Webview} webview
     * @returns {IconFont[]}
     */
    static #fonts(source, themeDir, webview) {
        return source
            .filter((font) => typeof font?.id === 'string' && Array.isArray(font.src))
            .map((font) => ({
                id: font.id,
                src: font.src.map((/** @type {{ path: string, format: string }} */ src) => ({
                    src: IconThemeLoader.#webviewUri(webview, themeDir, src.path),
                    format: src.format,
                })),
                weight: font.weight,
                style: font.style,
                size: font.size,
            }));
    }

    /**
     * @param {Record<string, any>} source
     * @returns {IconMapping}
     */
    static #mapping(source) {
        return {
            file: source.file,
            folder: source.folder,
            fileExtensions: IconThemeLoader.#lowerCaseKeys(source.fileExtensions),
            fileNames: IconThemeLoader.#lowerCaseKeys(source.fileNames),
            folderNames: IconThemeLoader.#lowerCaseKeys(source.folderNames),
            languageIds: source.languageIds,
        };
    }

    /**
     * Language of a file by extension and by exact name, from every installed extension, for themes that map
     * icons to languages rather than to extensions.
     * @returns {{ byExtension: Record<string, string>, byFileName: Record<string, string> }}
     */
    static #languages() {
        /** @type {Record<string, string>} */
        const byExtension = {};
        /** @type {Record<string, string>} */
        const byFileName = {};
        for (const extension of vscode.extensions.all) {
            const languages = extension.packageJSON?.contributes?.languages;
            if (!Array.isArray(languages)) {
                continue;
            }
            for (const language of languages) {
                if (typeof language?.id !== 'string') {
                    continue;
                }
                for (const fileExtension of language.extensions ?? []) {
                    byExtension[String(fileExtension).replace(/^\./, '').toLowerCase()] ??= language.id;
                }
                for (const fileName of language.filenames ?? []) {
                    byFileName[String(fileName).toLowerCase()] ??= language.id;
                }
            }
        }
        return { byExtension, byFileName };
    }

    /**
     * @param {Record<string, string> | undefined} source
     * @returns {Record<string, string> | undefined}
     */
    static #lowerCaseKeys(source) {
        if (!source) {
            return undefined;
        }
        /** @type {Record<string, string>} */
        const result = {};
        for (const [key, value] of Object.entries(source)) {
            result[key.toLowerCase()] = value;
        }
        return result;
    }

    /**
     * Theme files write glyphs as CSS escapes: "\E001".
     * @param {string} fontCharacter
     * @returns {string}
     */
    static #fontCharacter(fontCharacter) {
        const escape = /^\\([0-9a-fA-F]{1,6})$/.exec(fontCharacter);
        return escape ? String.fromCodePoint(parseInt(escape[1], 16)) : fontCharacter;
    }

    /**
     * @param {vscode.Webview} webview
     * @param {string} themeDir
     * @param {string} relativePath
     * @returns {string}
     */
    static #webviewUri(webview, themeDir, relativePath) {
        return webview.asWebviewUri(vscode.Uri.file(path.join(themeDir, relativePath))).toString();
    }
}

module.exports.IconThemeLoader = IconThemeLoader;
