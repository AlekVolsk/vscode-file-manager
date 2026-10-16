// @ts-check
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.activate = activate;
exports.deactivate = deactivate;

const vscode = require('vscode');
const { Config } = require('./config');
const { FileManagerPanel } = require('./fileManagerPanel');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
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

function deactivate() {}
