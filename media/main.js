// @ts-check
'use strict';

new FileManagerApp(
    /** @type {any} */ (globalThis).acquireVsCodeApi(),
    /** @type {HTMLScriptElement} */ (document.currentScript).nonce,
    /** @type {HTMLElement} */ (document.getElementById('app')),
).start();
