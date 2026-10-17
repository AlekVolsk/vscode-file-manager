// @ts-check
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** @typedef {'win' | 'linux' | 'mac'} PlatformKind */

class Platform {
    /** @type {boolean | undefined} */
    static #wsl;

    /**
     * @returns {PlatformKind}
     */
    static get kind() {
        if (process.platform === 'win32') {
            return 'win';
        }
        return process.platform === 'darwin' ? 'mac' : 'linux';
    }

    /**
     * Linux running under WSL: names have to stay valid for Windows, whose drives are mounted under /mnt.
     * @returns {boolean}
     */
    static get isWsl() {
        if (Platform.#wsl === undefined) {
            Platform.#wsl = Platform.kind === 'linux' && Platform.#detectWsl();
        }
        return Platform.#wsl;
    }

    /**
     * The folder above `dirPath`, or null at the top. On Windows the top is the drive list, addressed by ''.
     * @param {string} dirPath
     * @returns {string | null}
     */
    static parentOf(dirPath) {
        if (dirPath === '') {
            return null;
        }
        const parent = path.dirname(dirPath);
        if (parent !== dirPath) {
            return parent;
        }
        return Platform.kind === 'win' ? '' : null;
    }

    /**
     * @returns {string}
     */
    static homeDirectory() {
        return os.homedir();
    }

    /**
     * @returns {boolean}
     */
    static #detectWsl() {
        if (process.env.WSL_DISTRO_NAME) {
            return true;
        }
        try {
            return /microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
        } catch {
            return false;
        }
    }
}

module.exports.Platform = Platform;
