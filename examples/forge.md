# Forge Code example

Integration notes for the [method](../METHOD.md), observed with Forge Code
2.13.21 on Linux. Recheck against the installed version and
[upstream source](https://github.com/tailcallhq/forgecode).

## Two input owners

The editor inside `forge` and the shell prompt are separate. In the examined
Zsh plugin, ZLE edits `: ...` requests, then passes them to
`_forge_exec_interactive -p ...` after line acceptance. Dictation there must edit
ZLE's buffer; wrapping the Forge binary cannot affect that input. Add the request
prefix on an empty line only if it matches the installed convention. Leave
ordinary shell commands untouched unless shell-wide dictation was requested.

For the interactive Forge editor, look for a native hook. If none exists, assess
a pseudo-terminal (PTY) adapter forwarding input/output and inserting transcripts
as bracketed paste. Keep the official plugin and binary untouched; a missing
hook does not by itself require a fork. The shell widget remains separate.

`FORGE_BIN` also serves completion and configuration. Do not point it at an
interactive-only wrapper; preserve aliases, functions and non-interactive calls.

## Terminal-specific checks

A start/stop shortcut and Enter-to-stop must both preserve the method's separate
submission action. Verify that the chosen shortcut actually reaches the terminal;
input injection alone cannot establish this.

ZLE handles Ctrl+C through terminal signal processing before ordinary key
bindings. An interrupted editor may skip its line-finish hook: check recovery at
the next line initialization rather than relying only on a Ctrl+C widget.

Check completion, history, editing modes, resize, suspend/resume and worker cleanup
alongside the method's dictation tests.
