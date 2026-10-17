// @ts-check
'use strict';

const { spawn } = require('child_process');

/**
 * @typedef {object} DriveInfo
 * @property {string} name      "C:"
 * @property {string} label
 * @property {string} type      Fixed, Removable, Network, CDRom, Ram, NoRootDirectory, Unknown
 * @property {boolean} ready
 * @property {number | null} total
 * @property {number | null} free
 */

/**
 * @typedef {object} PendingRequest
 * @property {(lines: string[]) => void} resolve
 * @property {(error: Error) => void} reject
 */

/**
 * One long-lived PowerShell process for what Node cannot read on Windows: the R/H/S/A attributes of a folder's
 * entries and the drive list. Requests go one per stdin line, paths base64-encoded, so no path ever reaches a parser
 * of PowerShell or cmd; a response ends with a NUL line.
 */
class WindowsShell {
    static #SCRIPT = [
        "$ErrorActionPreference = 'Stop'",
        '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
        '$T = [char]9',
        '$N = [char]10',
        'while ($null -ne ($request = [Console]::In.ReadLine())) {',
        '    $out = New-Object System.Text.StringBuilder',
        '    try {',
        "        if ($request -eq 'D') {",
        '            foreach ($d in [System.IO.DriveInfo]::GetDrives()) {',
        "                $ready = $d.IsReady; $label = ''; $total = ''; $free = ''",
        '                if ($ready) { $label = $d.VolumeLabel; $total = $d.TotalSize; $free = $d.AvailableFreeSpace }',
        '                [void]$out.Append($d.Name).Append($T).Append($d.DriveType).Append($T)',
        '                [void]$out.Append($ready).Append($T)',
        '                [void]$out.Append($total).Append($T).Append($free).Append($T).Append($label).Append($N)',
        '            }',
        "        } elseif ($request.StartsWith('A ')) {",
        "            $fields = $request.Substring(2).Split(' ')",
        '            $target = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($fields[0]))',
        '            $item = Get-Item -LiteralPath $target -Force',
        '            $value = ([int]$item.Attributes -bor [int]$fields[1]) -band (-bnot [int]$fields[2])',
        '            if (($value -band (-bnot 16)) -eq 0) { $value = $value -bor 128 }',
        '            $item.Attributes = [System.IO.FileAttributes]$value',
        '        } else {',
        '            $dir = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.Substring(2)))',
        '            foreach ($i in (New-Object System.IO.DirectoryInfo $dir).EnumerateFileSystemInfos()) {',
        '                [void]$out.Append($i.Name).Append($T).Append([int]$i.Attributes).Append($N)',
        '            }',
        '        }',
        '    } catch {',
        '        $out = New-Object System.Text.StringBuilder',
        "        [void]$out.Append('!').Append($T).Append(($_.Exception.Message -replace '\\s+', ' ')).Append($N)",
        '    }',
        '    [void]$out.Append([char]0).Append($N)',
        '    [Console]::Out.Write($out.ToString())',
        '    [Console]::Out.Flush()',
        '}',
    ].join('\n');

    #executable;
    /** @type {import('child_process').ChildProcessWithoutNullStreams | null} */
    #process = null;
    /** @type {PendingRequest[]} */
    #pending = [];
    #buffer = '';
    /** @type {string[]} */
    #lines = [];

    /**
     * @param {string} [executable]
     */
    constructor(executable = 'powershell.exe') {
        this.#executable = executable;
    }

    /**
     * Attribute bits (System.IO.FileAttributes) of every entry of a folder, by name.
     * @param {string} dirPath
     * @returns {Promise<Map<string, number>>}
     */
    async readAttributes(dirPath) {
        const lines = await this.#request(`L ${Buffer.from(dirPath, 'utf8').toString('base64')}`);
        /** @type {Map<string, number>} */
        const attributes = new Map();
        for (const line of lines) {
            const tab = line.lastIndexOf('\t');
            attributes.set(line.slice(0, tab), Number(line.slice(tab + 1)));
        }
        return attributes;
    }

    /**
     * Sets and clears System.IO.FileAttributes bits of one entry; with nothing left it becomes Normal, which
     * Windows wants instead of no attributes at all.
     * @param {string} entryPath
     * @param {number} set
     * @param {number} clear
     */
    async changeAttributes(entryPath, set, clear) {
        const encoded = Buffer.from(entryPath, 'utf8').toString('base64');
        await this.#request(`A ${encoded} ${set} ${clear}`);
    }

    /**
     * @returns {Promise<DriveInfo[]>}
     */
    async readDrives() {
        const lines = await this.#request('D');
        return lines.map((line) => {
            const [root, type, ready, total, free, ...label] = line.split('\t');
            return {
                name: root.replace(/\\$/, ''),
                label: label.join('\t'),
                type,
                ready: ready === 'True',
                total: total === '' ? null : Number(total),
                free: free === '' ? null : Number(free),
            };
        });
    }

    dispose() {
        this.#process?.kill();
        this.#process = null;
        this.#failPending(new Error('PowerShell stopped'));
    }

    /**
     * @param {string} request
     * @returns {Promise<string[]>}
     */
    #request(request) {
        return new Promise((resolve, reject) => {
            const shell = this.#ensureProcess();
            this.#pending.push({ resolve, reject });
            shell.stdin.write(`${request}\n`);
        });
    }

    /**
     * @returns {import('child_process').ChildProcessWithoutNullStreams}
     */
    #ensureProcess() {
        if (this.#process) {
            return this.#process;
        }
        const encoded = Buffer.from(WindowsShell.#SCRIPT, 'utf16le').toString('base64');
        const shell = spawn(
            this.#executable,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
            { windowsHide: true },
        );
        shell.stdout.setEncoding('utf8');
        shell.stdout.on('data', (chunk) => this.#consume(chunk));
        shell.on('error', (error) => this.#onExit(error));
        shell.on('exit', (code) => this.#onExit(new Error(`PowerShell exited with code ${code}`)));
        this.#process = shell;
        return shell;
    }

    /**
     * @param {string} chunk
     */
    #consume(chunk) {
        this.#buffer += chunk;
        let newline;
        while ((newline = this.#buffer.indexOf('\n')) !== -1) {
            const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
            this.#buffer = this.#buffer.slice(newline + 1);
            if (line !== '\0') {
                this.#lines.push(line);
                continue;
            }
            const lines = this.#lines;
            this.#lines = [];
            const request = this.#pending.shift();
            if (lines.length === 1 && lines[0].startsWith('!\t')) {
                request?.reject(new Error(lines[0].slice(2)));
            } else {
                request?.resolve(lines);
            }
        }
    }

    /**
     * @param {Error} error
     */
    #onExit(error) {
        this.#process = null;
        this.#buffer = '';
        this.#lines = [];
        this.#failPending(error);
    }

    /**
     * @param {Error} error
     */
    #failPending(error) {
        const pending = this.#pending;
        this.#pending = [];
        for (const request of pending) {
            request.reject(error);
        }
    }
}

module.exports.WindowsShell = WindowsShell;
