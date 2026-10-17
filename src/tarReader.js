// @ts-check
'use strict';

const fs = require('fs');
const tar = require('tar');
const { OperationAborted } = require('./operationAborted');

/**
 * Reads a tar or tar.gz (compression is detected) entry by entry. The handler of an entry may take its time —
 * ask the user, write a file — and the next entry waits for it: an entry's data is read only when the handler
 * consumes it, and a handler that does not want it calls `entry.resume()`. Damaged archives fail: checksums of
 * the tar headers, of gzip and its length are checked.
 */
class TarReader {
    /**
     * @param {string} archivePath
     * @param {(entry: import('tar').ReadEntry) => Promise<void>} onEntry
     * @param {{ cancelled: boolean }} cancellation
     * @param {(bytesRead: number, totalBytes: number) => void} [onProgress]  bytes of the archive file
     * @returns {Promise<void>}
     */
    static read(archivePath, onEntry, cancellation, onProgress) {
        return new Promise((resolve, reject) => {
            const totalBytes = fs.statSync(archivePath).size;
            const input = fs.createReadStream(archivePath);
            const parser = new tar.Parser({ strict: true, noResume: true });
            let bytesRead = 0;
            let settled = false;
            let chain = Promise.resolve();
            const fail = (/** @type {unknown} */ error) => {
                if (settled) {
                    return;
                }
                settled = true;
                input.destroy();
                reject(error);
            };
            parser.on('entry', (/** @type {import('tar').ReadEntry} */ entry) => {
                chain = chain.then(async () => {
                    if (settled) {
                        entry.resume();
                        return;
                    }
                    if (cancellation.cancelled) {
                        throw new OperationAborted();
                    }
                    await onEntry(entry);
                }).catch(fail);
            });
            parser.on('error', fail);
            parser.on('end', () => {
                void chain.then(() => {
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                });
            });
            input.on('data', (chunk) => {
                bytesRead += chunk.length;
                onProgress?.(bytesRead, totalBytes);
            });
            input.on('error', fail);
            input.pipe(parser);
        });
    }
}

module.exports.TarReader = TarReader;
