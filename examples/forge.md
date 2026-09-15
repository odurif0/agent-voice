# Forge Code example

Apply the [installation method](../METHOD.md) first. These observations come
from Forge Code 2.13.21 on Linux; inspect the installed version before using them.
[Upstream source](https://github.com/tailcallhq/forgecode) may evolve independently.

## Find the input owner

The terminal inside `forge` and the shell prompt are different editors. In the
Zsh plugin examined, a `: ...` request is edited by ZLE, then passed to Forge
through `_forge_exec_interactive -p ...`. Wrapping the Forge binary alone cannot
add dictation to that shell input. Edit ZLE's buffer directly for dictation;
`_forge_exec_interactive` runs only after the user accepts the line.

Inspect the current shell plugin and interactive editor. Prefer a native hook if
one is available. Otherwise, assess a pseudo-terminal (PTY) wrapper that forwards
interactive input/output and inserts the transcript as bracketed paste. This can
leave the binary unchanged; a missing editor hook does not itself require a fork.
The shell widget remains a separate integration point.

Keep the official Forge plugin and binary untouched. A source change is not an
acceptable substitute for a no-fork requirement. Report a blocker only if neither
a native hook nor an external adapter can meet the requirement.

`FORGE_BIN` also serves internal commands such as completion and configuration.
Do not redirect it blindly to an interactive wrapper. Preserve existing aliases,
functions and non-interactive calls.

## Preserve editing behavior

For a Forge shell request, insert text at the cursor. On an empty line, add the
request prefix only if it is the convention verified in this installation.
Leave ordinary shell commands untouched unless the user has explicitly requested
shell-wide dictation.

A start/stop shortcut may coexist with Enter to stop recording. Neither stop
action submits the result; another Enter after transcription sends the request.
Support cancellation without losing the draft or cursor. Do not confuse pasted
newlines with keyboard submission.

In ZLE, Ctrl+C is handled by terminal signal processing before ordinary key
bindings. An interrupted editor may skip its line-finish hook. Test recovery at
the next line initialization rather than relying only on a Ctrl+C widget.

Verify real key delivery, completion, history, editing modes, resize,
suspend/resume and worker cleanup. Terminal input injection alone cannot prove
that a desktop shortcut reaches the terminal.

## Keep the installation independent

Reuse compatible audio components or models already available through Pi or
another consumer, but do not require Pi or GooeyPi. Forge dictation does not need
a speech-output engine unless spoken replies are separately requested.

Install only the Forge adapter. Record how another adapter can find the shared
resources, and test reuse in both orders. Removing Forge's voice integration
must preserve the original shell configuration and other consumers' resources.
