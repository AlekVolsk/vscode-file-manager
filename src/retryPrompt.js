// @ts-check
'use strict';

const { Common } = require('./common');
const { OperationAborted } = require('./operationAborted');

/** @typedef {import('./copyOperation').OperationQuestion} OperationQuestion */
/** @typedef {import('./copyOperation').OperationAnswer} OperationAnswer */

/**
 * What an operation does when one entry fails: asks retry, skip, skip all or abort. After "skip all" further
 * failures are skipped without asking.
 */
class RetryPrompt {
    #ask;
    #skipAll = false;

    /**
     * @param {(question: OperationQuestion) => Promise<OperationAnswer>} ask
     */
    constructor(ask) {
        this.#ask = ask;
    }

    /**
     * @param {string} name  shown in the question
     * @param {() => Promise<unknown>} action
     * @returns {Promise<boolean>}  false when skipped
     */
    async attempt(name, action) {
        for (;;) {
            try {
                await action();
                return true;
            } catch (error) {
                if (error instanceof OperationAborted) {
                    throw error;
                }
                if (this.#skipAll) {
                    return false;
                }
                const answer = await this.#ask({ kind: 'error', name, message: Common.errorMessage(error) });
                if (answer.action === 'abort' || answer.action === 'cancel') {
                    throw new OperationAborted();
                }
                if (answer.action === 'retry') {
                    continue;
                }
                if (answer.action === 'skipAll') {
                    this.#skipAll = true;
                }
                return false;
            }
        }
    }
}

module.exports.RetryPrompt = RetryPrompt;
