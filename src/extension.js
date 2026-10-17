// @ts-check
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.activate = activate;
exports.deactivate = deactivate;

const vscode = require('vscode');
const { Config } = require('./config');
const { FileManagerPanel } = require('./fileManagerPanel');
const { I18n } = require('./i18n');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    I18n.load(context.extensionPath);
    void moveViewStateToSettings(context);
    context.subscriptions.push(
        vscode.commands.registerCommand(Config.COMMAND_OPEN, () => FileManagerPanel.open(context)),
        vscode.commands.registerCommand(Config.COMMAND_ACTION, (action) => FileManagerPanel.runAction(action)),
        vscode.window.registerWebviewPanelSerializer(Config.VIEW_TYPE, {
            async deserializeWebviewPanel(panel, state) {
                FileManagerPanel.restore(panel, context, state);
            },
        }),
    );
}

/**
 * A saved view state may hold `fontSizeDelta` and `hideExtension`; they go to the settings `tableScale` and
 * `hideExtensionOnRename`, unless the user has set those, and leave the state.
 * @param {vscode.ExtensionContext} context
 */
async function moveViewStateToSettings(context) {
    const state = context.globalState.get(Config.GLOBAL_STATE_KEY);
    if (!state || typeof state !== 'object') {
        return;
    }
    const { fontSizeDelta, hideExtension, ...rest } = /** @type {Record<string, unknown>} */ (state);
    if (fontSizeDelta === undefined && hideExtension === undefined) {
        return;
    }
    const settings = vscode.workspace.getConfiguration('fileManager');
    const scaleUnset = settings.inspect('tableScale')?.globalValue === undefined;
    if (Number.isInteger(fontSizeDelta) && fontSizeDelta !== 0 && scaleUnset) {
        await settings.update('tableScale', fontSizeDelta, vscode.ConfigurationTarget.Global);
    }
    if (hideExtension === false && settings.inspect('hideExtensionOnRename')?.globalValue === undefined) {
        await settings.update('hideExtensionOnRename', false, vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(Config.GLOBAL_STATE_KEY, rest);
}

function deactivate() {}
