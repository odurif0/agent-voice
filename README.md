# Agent Voice

Ask your coding agent to add voice to the harness you are using (the application
that runs your agent). It inspects the application and machine, reuses compatible
audio components already installed, and selects state-of-the-art speech
recognition suited to your hardware and language.

## Use

Give your agent this request:

> Read https://github.com/odurif0/agent-voice/blob/main/METHOD.md and follow it to
> install voice support in the harness we're using.

The method covers dictation, spoken conversation or both according to your
request. The agent asks only for unresolved choices, proposes changes for
approval, then installs and tests the result where the application allows it.
Speech processing is local by default; the agent's model provider may still
receive the transcribed text.

This repository contains [instructions](METHOD.md), not an installable package.
Audio components can be shared between harnesses; their integrations stay
independent. [Forge Code](examples/forge.md) and [GooeyPi](examples/gooeypi.md)
illustrate application-specific decisions, not a fixed list of supported apps.

## Existing installations

The former runtime remains at [v0.5.0](https://github.com/odurif0/agent-voice/tree/v0.5.0).
This documentation-only branch is not a runtime update: do not pull it into a
working service or plugin checkout, or use the former `main/install.sh` command.
Updating an existing runtime requires a separate approved change, tests and rollback.

[MIT license](LICENSE). [Attribution](NOTICE).
