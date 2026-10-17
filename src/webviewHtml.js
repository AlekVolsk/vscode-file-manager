// @ts-check
'use strict';

const vscode = require('vscode');
const { Common } = require('./common');

class WebviewHtml {
    static #SCRIPTS = [
        'keys.js',
        'i18n.js',
        'format.js',
        'svgIcons.js',
        'iconResolver.js',
        'dialogView.js',
        'attributesForm.js',
        'propertiesView.js',
        'helpView.js',
        'progressView.js',
        'operationsController.js',
        'dragController.js',
        'toolbarView.js',
        'panelView.js',
        'fileManagerApp.js',
        'main.js',
    ];

    /**
     * @param {vscode.Webview} webview
     * @param {vscode.Uri} extensionUri
     * @returns {string}
     */
    static render(webview, extensionUri) {
        const nonce = Common.createNonce();
        const media = (/** @type {string} */ file) => webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'media', file),
        );
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `font-src ${webview.cspSource}`,
            `style-src ${webview.cspSource} 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');
        const scripts = WebviewHtml.#SCRIPTS
            .map((file) => `    <script nonce="${nonce}" src="${media(file)}"></script>`)
            .join('\n');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${media('main.css')}">
    <title>File Manager</title>
</head>
<body>
    <div id="app" class="app"></div>
${scripts}
</body>
</html>`;
    }
}

module.exports.WebviewHtml = WebviewHtml;
