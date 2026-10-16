// @ts-check
'use strict';

class Config {
    static VIEW_TYPE = 'fileManager';
    static COMMAND_OPEN = 'fileManager.open';
    static COMMAND_ACTION = 'fileManager.action';
    static PANEL_TITLE = 'File Manager';
    static GLOBAL_STATE_KEY = 'fileManager.viewState';
    static WORKSPACE_STATE_KEY = 'fileManager.paths';

    static STAT_CONCURRENCY = 64;

    /** System.IO.FileAttributes.Hidden */
    static WINDOWS_ATTRIBUTE_HIDDEN = 2;

    /** Minimum pause between two re-reads of a watched folder while events keep coming. */
    static WATCH_THROTTLE_MS = 300;

    /** Polling of folders on file systems without change notifications. */
    static POLL_MIN_INTERVAL_MS = 1500;
    static POLL_READ_DURATION_FACTOR = 3;
    static DRIVE_POLL_INTERVAL_MS = 3000;

    static SIZE_PROGRESS_INTERVAL_MS = 200;
    static PROGRESS_INTERVAL_MS = 100;

    /**
     * File systems whose changes do not reach inotify: WSL drvfs (9p), network shares, FUSE.
     * @type {ReadonlySet<string>}
     */
    static POLLED_FILE_SYSTEMS = new Set([
        '9p',
        'drvfs',
        'cifs',
        'smb3',
        'smbfs',
        'nfs',
        'nfs4',
        'sshfs',
        'davfs',
        'fuse',
    ]);
}

module.exports.Config = Config;
