// @ts-check
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');

/**
 * Checksum of a copied file and of its copy: CRC-32 from zlib when this Node has it, SHA-1 otherwise. Detecting a
 * damaged copy needs no cryptographic strength, and CRC-32 does not slow the copy down.
 */
class FileHasher {
    /** @type {((data: Buffer, value?: number) => number) | null} */
    static #crc32 = typeof (/** @type {any} */ (zlib).crc32) === 'function'
        ? /** @type {any} */ (zlib).crc32
        : null;

    #crc = 0;
    /** @type {crypto.Hash | null} */
    #sha1 = FileHasher.#crc32 ? null : crypto.createHash('sha1');

    /**
     * @returns {string}
     */
    static get algorithm() {
        return FileHasher.#crc32 ? 'CRC-32' : 'SHA-1';
    }

    /**
     * @param {Buffer} data
     */
    update(data) {
        if (this.#sha1) {
            this.#sha1.update(data);
        } else {
            this.#crc = /** @type {(data: Buffer, value?: number) => number} */ (FileHasher.#crc32)(data, this.#crc);
        }
    }

    /**
     * @returns {string}
     */
    digest() {
        return this.#sha1 ? this.#sha1.digest('hex') : this.#crc.toString(16);
    }
}

module.exports.FileHasher = FileHasher;
