// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');

class Common {
    /**
     * Maps items with at most `limit` calls of `mapper` in flight; the result keeps the order of `items`.
     * @template T, R
     * @param {readonly T[]} items
     * @param {number} limit
     * @param {(item: T) => Promise<R>} mapper
     * @returns {Promise<R[]>}
     */
    static async mapLimited(items, limit, mapper) {
        /** @type {R[]} */
        const results = new Array(items.length);
        let next = 0;
        const worker = async () => {
            while (next < items.length) {
                const index = next++;
                results[index] = await mapper(items[index]);
            }
        };
        const workers = [];
        for (let i = 0; i < Math.min(limit, items.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return results;
    }

    /**
     * @param {unknown} error
     * @returns {string}
     */
    static errorCode(error) {
        return error instanceof Error && 'code' in error ? String(error.code) : '';
    }

    /**
     * @param {unknown} error
     * @returns {string}
     */
    static errorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }

    /**
     * "report.txt" → "report (1).txt", "report (2).txt", …; folders get the number at the end of the whole name.
     * @param {string} target
     * @param {boolean} isDir
     * @returns {Promise<string>}
     */
    static async freeName(target, isDir) {
        const dir = path.dirname(target);
        const name = path.basename(target);
        const dot = name.lastIndexOf('.');
        const hasExtension = !isDir && dot > 0;
        const base = hasExtension ? name.slice(0, dot) : name;
        const extension = hasExtension ? name.slice(dot) : '';
        for (let number = 1; ; number++) {
            const candidate = path.join(dir, `${base} (${number})${extension}`);
            const taken = await fs.promises.lstat(candidate).then(() => true, () => false);
            if (!taken) {
                return candidate;
            }
        }
    }

    /**
     * @returns {string}
     */
    static createNonce() {
        return require('crypto').randomBytes(16).toString('base64');
    }
}

module.exports.Common = Common;
