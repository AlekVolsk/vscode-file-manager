// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { Common } = require('./common');
const { Config } = require('./config');

/**
 * @typedef {object} FolderSize
 * @property {number} bytes
 * @property {number} files    everything inside that is not a folder, links included
 * @property {number} folders  folders inside, not counting the root
 * @property {number} skippedFolders  subfolders that could not be read; the counts are then lower bounds
 */

/**
 * @typedef {object} CancellationFlag
 * @property {boolean} cancelled
 */

class FolderSizeCounter {
    /**
     * Total size of the files under `root`. Links are not followed, so a link loop or a link to a big folder
     * elsewhere does not inflate the total.
     * @param {string} root
     * @param {CancellationFlag} cancellation
     * @param {(progress: FolderSize) => void} onProgress  called at most every SIZE_PROGRESS_INTERVAL_MS
     * @returns {Promise<FolderSize | null>}  null when cancelled
     */
    static async count(root, cancellation, onProgress) {
        /** @type {FolderSize} */
        const total = { bytes: 0, files: 0, folders: 0, skippedFolders: 0 };
        const pending = [root];
        let lastProgressAt = Date.now();
        while (pending.length > 0) {
            if (cancellation.cancelled) {
                return null;
            }
            const dirPath = /** @type {string} */ (pending.pop());
            let dirents;
            try {
                dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
            } catch {
                total.skippedFolders++;
                continue;
            }
            const files = [];
            for (const dirent of dirents) {
                if (dirent.isDirectory()) {
                    total.folders++;
                    pending.push(path.join(dirPath, dirent.name));
                    continue;
                }
                total.files++;
                if (dirent.isFile()) {
                    files.push(path.join(dirPath, dirent.name));
                }
            }
            const sizes = await Common.mapLimited(files, Config.STAT_CONCURRENCY, async (filePath) => {
                try {
                    return (await fs.promises.lstat(filePath)).size;
                } catch {
                    return 0;
                }
            });
            for (const size of sizes) {
                total.bytes += size;
            }
            if (Date.now() - lastProgressAt >= Config.SIZE_PROGRESS_INTERVAL_MS) {
                lastProgressAt = Date.now();
                onProgress({ ...total });
            }
        }
        return total;
    }
}

module.exports.FolderSizeCounter = FolderSizeCounter;
