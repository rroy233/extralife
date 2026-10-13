# ExtraLife — Command Reference

ExtraLife exports Codex sessions as portable handoff documents. For installation and a quick start, see the [README](../README.md).

- [Installation](#installation)
- [Command](#command)
- [Finding sessions](#finding-sessions)
- [Export options](#export-options)
- [Handoff contents](#handoff-contents)
- [Output formats](#output-formats)
- [Interactive controls](#interactive-controls)
- [Exit codes](#exit-codes)
- [Environment variables](#environment-variables)
- [Privacy](#privacy)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

## Installation

Requires Node.js 18 or newer.

```bash
npx @rroy233/extralife
```

Or install the command globally:

```bash
npm install -g @rroy233/extralife
extralife
```

Node.js 22.15 or newer is required to read compressed Codex sessions.

## Command

```text
extralife [session-id | transcript-path] [options]
```

Run without arguments to open the session picker. A session can be selected by its full ID, an unambiguous ID prefix, title text, or transcript path.

## Finding sessions

| Option | Description |
| --- | --- |
| `-l`, `--list` | Print matching sessions instead of opening the picker |
| `--here` | Show sessions associated with the current directory |
| `--cwd <dir>` | Show sessions associated with this directory or a child directory |
| `--all` | Include automatic security-review sessions |
| `--archived` | Include archived sessions |
| `--home <dir>` | Set the Codex home directory; defaults to `$CODEX_HOME` or `~/.codex` |
| `--no-cache` | Refresh the session list without using the saved index |

`--here` and `--cwd` also apply with `--list`. Automatic security-review sessions are hidden by default.

## Export options

| Option | Description |
| --- | --- |
| `-o`, `--out <file>` | Set the output path |
| `--stdout` | Write the document to standard output |
| `--copy` | Copy the document to the system clipboard |
| `--format <fmt>` | Select `handoff`, `markdown`, or `json` |
| `--json` | Write JSON to standard output |
| `--detail <level>` | Select `minimal`, `standard`, or `full` content |
| `--budget <n>` | Set a soft token budget, e.g. `32k` or `1.5M` |
| `--sections <list>` | Include a comma-separated list of section IDs |
| `--turns <n>` | Set how many recent conversation turns to include; default is `8` |
| `--no-redact` | Disable credential redaction |
| `--no-color` | Disable terminal colors |
| `-y`, `--yes` | Export using defaults without opening the options screen |
| `-q`, `--quiet` | Suppress progress and the closing summary |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show the installed version |
| `--help-sections` | List the available handoff sections |

Unless `--stdout` is used, exports are written to a file. The default filename includes the project and current time. `--copy` supports the system clipboard command available on macOS, Windows, and Linux.

### Detail levels

| Level | Included content |
| --- | --- |
| `minimal` | Instructions, task, next steps, failed approaches, constraints, files, and summary |
| `standard` | Minimal content plus current state, diffs, commands, research, and conversation |
| `full` | All available sections |

The `howto`, `mission`, and `next` sections are always included.

The token budget is soft. Lower-priority sections are shortened first. Mission and next steps are retained; if the requested budget is too small, the document notes that it exceeded the limit.

## Handoff contents

| Section ID | Contents |
| --- | --- |
| `howto` | Guidance for the receiving AI tool |
| `mission` | The user's request and task goal |
| `state` | Progress and current task status |
| `next` | Outstanding work and suggested next steps |
| `deadends` | Failed commands and abandoned approaches |
| `constraints` | Project requirements and environment constraints |
| `files` | Files relevant to the task |
| `diffs` | Recorded file changes |
| `commands` | Commands and their results |
| `research` | Web searches and external references from the session |
| `conversation` | Recent conversation history |
| `appendix` | Session identifiers and additional context |

## Output formats

### `handoff`

Plain UTF-8 text, suitable for pasting into another AI tool.

### `markdown`

Markdown headings with YAML front matter containing session and project details.

### `json`

Structured data for scripts and other tools. Includes the selected session context, handoff sections, and conversation details.

## Interactive controls

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j` | Move the selection |
| `PgUp` / `PgDn` | Move by ten rows |
| `Home` / `End` | Move to the first or last row |
| Type text | Filter the session list |
| `'term` | Search for an exact substring |
| `backspace` | Delete a character from the search |
| `ctrl-u` | Clear the search |
| `space` | Toggle a section in the options screen |
| `a` | Select or clear all filtered rows |
| `1` `2` `3` | Select minimal, standard, or full detail |
| `b` | Change the token budget |
| `enter` | Confirm or export |
| `?` | Show or hide help |
| `esc` | Clear search or go back |
| `ctrl-c` | Cancel |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Unexpected error |
| `2` | Invalid command or options |
| `3` | Codex home directory not found |
| `4` | Session not found |
| `5` | No sessions match the filters |
| `6` | Transcript could not be read |
| `7` | Transcript contains no usable content |
| `8` | Document rendering failed |
| `9` | Output could not be written |
| `130` | Cancelled |

## Environment variables

| Variable | Description |
| --- | --- |
| `CODEX_HOME` | Codex home directory; defaults to `~/.codex` |
| `EXTRALIFE_CACHE_DIR` | Directory for the local session index |
| `NO_COLOR` | Disable terminal colors |
| `FORCE_COLOR` | Enable terminal colors |

`--home` overrides `CODEX_HOME`.

## Privacy

ExtraLife processes sessions locally and makes no network requests or telemetry calls. Credential redaction is enabled by default. It covers common private keys, API tokens, authorization headers, URL passwords, credential flags, and credential-shaped values in environment, JSON, and YAML text.

Redaction cannot guarantee that every sensitive value is removed. Review the exported document before sharing it. Use `--no-redact` only when needed.

## Examples

```bash
# Open the interactive picker
extralife

# Export a session from the current project
extralife --here -y

# Export and copy to the clipboard
extralife --here -y --copy

# Create a smaller handoff
extralife --here -y --detail minimal --budget 8k -o context.txt

# List matching sessions
extralife --list --here

# Write JSON for another program
extralife 01a12926 --json > session.json

# Use a separate Codex home directory
CODEX_HOME=/path/to/codex-home extralife --list
```

## Troubleshooting

**Codex home directory not found**

Set `CODEX_HOME` or pass `--home /path/to/.codex`.

**No sessions found**

Check the current directory filter, or use `extralife --list --all --archived` to broaden the results.

**The picker needs a terminal**

In scripts, provide a session ID or use `--list`.

**A session has no quota percentage**

Quota information is shown when it is available in that session.

**A compressed session is skipped**

Use Node.js 22.15 or newer.

**The exported document is too large**

Choose `--detail minimal`, reduce `--turns`, or specify a shorter section list. The token budget can also shorten lower-priority content.

