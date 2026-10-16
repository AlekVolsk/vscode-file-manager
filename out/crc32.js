// @ts-check
'use strict';

const zlib = require('zlib');

/**
 * CRC-32 as zip stores it: zlib's when this Node has it, a table otherwise.
 */
class Crc32 {
    /** @type {((data: Buffer, value?: number) => number) | null} */
    static #native = typeof (/** @type {any} */ (zlib).crc32) === 'function'
        ? /** @type {any} */ (zlib).crc32
        : null;

    /** @type {Uint32Array | null} */
    static #table = null;

    #value = 0;

    /**
     * @param {Buffer} data
     */
    update(data) {
        if (Crc32.#native) {
            this.#value = Crc32.#native(data, this.#value);
            return;
        }
        const table = Crc32.#lookupTable();
        let crc = ~this.#value >>> 0;
        for (const byte of data) {
            crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        }
        this.#value = ~crc >>> 0;
    }

    /**
     * @returns {number}
     */
    get value() {
        return this.#value >>> 0;
    }

    /**
     * @returns {Uint32Array}
     */
    static #lookupTable() {
        if (!Crc32.#table) {
            const table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) {
                    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                }
                table[n] = c >>> 0;
            }
            Crc32.#table = table;
        }
        return Crc32.#table;
    }
}

module.exports.Crc32 = Crc32;
