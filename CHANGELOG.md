# Changelog

## 1.2.1 — 2026-10-26

- The README states that the extension is developed and maintained with the help of AI tools.

## 1.2.0 — 2026-10-23

- `Ctrl+Enter` pastes the name of the entry under the cursor into the active terminal, `Ctrl+Shift+Enter` its path from the project folder, `Ctrl+Alt+Enter` its absolute path.
- `Ctrl+double-click`, alone or with Shift or Alt, does the same as `Ctrl+Enter`, `Ctrl+Shift+Enter` and `Ctrl+Alt+Enter`.
- The pasted text goes in at the terminal cursor followed by a space, without Enter, and the terminal takes the focus.
- The project folder for `Ctrl+Shift+Enter` is the workspace folder holding the entry, the first workspace folder when none does, or the home folder without a workspace; `..` pastes the folder above.
- Names with spaces, quotes, `$`, `*`, `;` and similar characters are quoted for the shell of the terminal (POSIX shells, PowerShell, cmd); a name starting with `-` gets `./` in front.
- Names with control characters are refused, as are names cmd cannot quote (containing `"` or `%`); a warning is shown when no terminal is open.
- `Ctrl+Alt+Enter` is a keybinding of the extension, which keeps Replace All of the Search view, bound to the same key, from firing while the File Manager has the focus.
- Help (`F1`) lists the new keys and the Ctrl+double-click action.
- Right-click shows VS Code's Cut, Copy and Paste menu only in text fields; elsewhere in the File Manager it does nothing.
- Minor wording fixes in English, Czech, Polish and Turkish texts.

## 1.1.0 — 2026-10-17

- Interface translated into Čeština, Deutsch, Español, Français, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Türkçe, 简体中文 and 繁體中文; command titles and setting descriptions follow the language of VS Code.
- New setting `fileManager.language`: interface language, `auto` follows VS Code.
- New setting `fileManager.customTranslations`: your own dictionary for a language not in the list; missing keys are shown in English.
- New setting `fileManager.startFolder`: where a new tab opens — the folders last open in this workspace (default), the home folder, the project folder or the root.
- Table scale (Ctrl+mouse wheel), "Hide file extension" on rename, "unpack into a subfolder" and the pack format are now kept in the settings `fileManager.tableScale`, `fileManager.hideExtensionOnRename`, `fileManager.unpackIntoSubfolder` and `fileManager.packFormat`; a table scale and a "Hide file extension" choice saved by 1.0.0 are moved into the settings on first start.
- Help button (`F1`) at the right edge of the toolbar; buttons that do not fit a narrow panel go into a `⋯` menu next to it.
- macOS: ⌘ takes the place of Ctrl everywhere in the File Manager, including Ctrl+click and Ctrl at a drop; tooltips and help show keys with Mac symbols.
- License changed from MIT to BSD 3-Clause.

## 1.0.0 — 2026-10-16

- Two-panel file manager in an editor tab, opened from the editor title bar or the Command Palette; each tab reopens where it was left, also after a window reload.
- Panels with name, extension, size, date and attribute columns, sorting, folder size counting, clickable and editable path, live updates on disk changes (with polling for WSL `/mnt/c`, network shares and FUSE), icons from the active file icon theme.
- Toolbar and Total Commander style keys (`F2`–`F10`, `Shift+F4`, `Shift+F8`, `Alt+F5`, `Alt+F9` and others) for navigation, selection and operations; mouse selection with Ctrl, Shift and Ctrl+Shift.
- Drag and drop between panels: move, or copy with Ctrl.
- Copy and move with checksum verification of every copied file, name conflict and error dialogs, background progress with Cancel.
- Delete to trash where available, or permanently with a delayed confirmation.
- Rename, new file, new folder, with name validation (Windows rules under Windows and WSL).
- Attributes dialog (POSIX permission bits or Windows Read-only, Hidden, System, Archive), optionally recursive; properties dialog.
- Zip, tar and tar.gz archives: browse like folders (read only), unpack with path safety checks, pack with verification, test.
- Works on Windows, WSL, Linux and macOS, also in remote windows; requires VS Code 1.94 or later.
