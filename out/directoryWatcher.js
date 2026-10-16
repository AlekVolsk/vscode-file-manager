// @ts-check
'use strict';

const fs = require('fs');
const { Config } = require('./config');

/**
 * Calls `refresh` when the open folder changes: on watcher events, at most once per WATCH_THROTTLE_MS, or by polling
 * on file systems that send no events. Refreshes never overlap; one that is asked for while another runs follows it.
 */
class DirectoryWatcher {
    static #EVENT_GATHER_MS = 50;

    #refresh;
    /** @type {fs.FSWatcher | null} */
    #watcher = null;
    /** @type {NodeJS.Timeout | null} */
    #timer = null;
    #polling = false;
    #pollInterval = Config.POLL_MIN_INTERVAL_MS;
    #running = false;
    #requestedWhileRunning = false;
    #lastRunAt = 0;
    #generation = 0;

    /**
     * @param {() => Promise<void>} refresh
     */
    constructor(refresh) {
        this.#refresh = refresh;
    }

    /**
     * @param {string} dirPath
     * @param {'events' | 'polling'} mode
     * @param {number} [pollInterval]
     */
    watch(dirPath, mode, pollInterval = Config.POLL_MIN_INTERVAL_MS) {
        this.stop();
        this.#polling = mode === 'polling';
        this.#pollInterval = pollInterval;
        if (this.#polling) {
            this.#schedule(this.#pollInterval);
            return;
        }
        try {
            this.#watcher = fs.watch(dirPath, { persistent: false }, () => this.#onEvent());
            this.#watcher.on('error', () => this.#onEvent());
        } catch {
            this.#polling = true;
            this.#schedule(this.#pollInterval);
        }
    }

    /**
     * Slow file systems are polled less often: the pause grows with the time the last read took.
     * @param {number} readDurationMs
     */
    reportReadDuration(readDurationMs) {
        this.#pollInterval = Math.max(
            Config.POLL_MIN_INTERVAL_MS,
            readDurationMs * Config.POLL_READ_DURATION_FACTOR,
        );
    }

    stop() {
        this.#generation++;
        this.#watcher?.close();
        this.#watcher = null;
        if (this.#timer) {
            clearTimeout(this.#timer);
            this.#timer = null;
        }
        this.#requestedWhileRunning = false;
    }

    #onEvent() {
        if (this.#timer) {
            return;
        }
        const sinceLastRun = Date.now() - this.#lastRunAt;
        this.#schedule(Math.max(DirectoryWatcher.#EVENT_GATHER_MS, Config.WATCH_THROTTLE_MS - sinceLastRun));
    }

    /**
     * @param {number} delayMs
     */
    #schedule(delayMs) {
        const generation = this.#generation;
        this.#timer = setTimeout(() => {
            this.#timer = null;
            if (generation === this.#generation) {
                void this.#run(generation);
            }
        }, delayMs);
    }

    /**
     * @param {number} generation
     */
    async #run(generation) {
        if (this.#running) {
            this.#requestedWhileRunning = true;
            return;
        }
        this.#running = true;
        this.#lastRunAt = Date.now();
        try {
            await this.#refresh();
        } finally {
            this.#running = false;
        }
        if (generation !== this.#generation) {
            return;
        }
        if (this.#requestedWhileRunning) {
            this.#requestedWhileRunning = false;
            this.#onEvent();
        } else if (this.#polling) {
            this.#schedule(this.#pollInterval);
        }
    }
}

module.exports.DirectoryWatcher = DirectoryWatcher;
