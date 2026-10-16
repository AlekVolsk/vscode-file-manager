// @ts-check
'use strict';

/**
 * Thrown when the user cancels or aborts an operation; carries no failure of its own.
 */
class OperationAborted extends Error {
    constructor() {
        super('Operation cancelled');
        this.name = 'OperationAborted';
    }
}

module.exports.OperationAborted = OperationAborted;
