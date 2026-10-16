// @ts-check
'use strict';

/**
 * File names in zip archives. The UTF-8 flag and the Info-ZIP Unicode path field are handled by yauzl; a name
 * with neither is in the DOS code page of the machine that packed it. The standard says CP437, Windows archivers
 * in Russia write CP866, and a Cyrillic name read as CP437 turns into box-drawing symbols. Such a name is read as
 * CP866 when its non-ASCII bytes fall where CP866 keeps the Cyrillic letters.
 */
class ZipNames {
    /** bytes 0x80–0xFF of code page 866 */
    static #CP866_HIGH = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп'
        + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀'
        + 'рстуфхцчшщъыьэюяЁёЄєЇїЎў°∙·√№¤■\u00A0';

    static #UTF8_FLAG = 0x800;
    static #UNICODE_PATH_FIELD = 0x7075;

    /**
     * @param {import('yauzl').Entry} entry
     * @returns {string}
     */
    static decode(entry) {
        const hasUnicodeName = (entry.generalPurposeBitFlag & ZipNames.#UTF8_FLAG) !== 0
            || entry.extraFields.some((field) => field.id === ZipNames.#UNICODE_PATH_FIELD);
        if (hasUnicodeName || !ZipNames.#looksCyrillic(entry.fileNameRaw)) {
            return entry.fileName;
        }
        let name = '';
        for (const byte of entry.fileNameRaw) {
            name += byte < 0x80 ? String.fromCharCode(byte) : ZipNames.#CP866_HIGH[byte - 0x80];
        }
        return name.replace(/\\/g, '/');
    }

    /**
     * Cyrillic letters of CP866 are 0x80–0xAF and 0xE0–0xF1; CP437 has accented Latin letters there and the
     * box-drawing range 0xB0–0xDF in between, which no file name uses.
     * @param {Buffer} raw
     * @returns {boolean}
     */
    static #looksCyrillic(raw) {
        let high = 0;
        let cyrillic = 0;
        for (const byte of raw) {
            if (byte < 0x80) {
                continue;
            }
            high++;
            if (byte <= 0xAF || (byte >= 0xE0 && byte <= 0xF1)) {
                cyrillic++;
            }
        }
        return high > 0 && cyrillic === high;
    }
}

module.exports.ZipNames = ZipNames;
