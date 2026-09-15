# Agent Voice

A method for a coding agent to install voice support in an existing agent harness
(the application that runs your agent). It adapts to the application, its version
and the machine, rather than imposing one installer.

## Use

Give your coding agent this request, replacing the brackets:

> Read https://github.com/odurif0/agent-voice/blob/main/METHOD.md and follow its
> installation method to add [dictation / spoken conversation] to [my harness].
> Inspect my existing setup, reuse compatible components, and propose the changes
> before applying them. Perform the installation and verify it in the application.

The [method](METHOD.md) covers discovery, implementation, verification and removal.
[Forge Code](examples/forge.md) and [GooeyPi](examples/gooeypi.md) are separate
examples, not a list of supported applications or a combined installation.

This repository contains instructions, not an installable package. A local voice
backend can be shared; each harness integration remains independent. Local audio
processing does not make an agent that uses a cloud model offline.

## Existing installations

The former implementation is preserved at [v0.5.0](https://github.com/odurif0/agent-voice/tree/v0.5.0)
for reference. It is not the default installation path for this method, and
this branch does not provide a newer runtime release.
The old `main/install.sh` command no longer applies. Do not pull this
documentation-only branch into a checkout used by a running service or plugin;
read the method separately. Updating that runtime is a separate approved change
using actual runtime code, with its own tests and rollback.

[MIT license](LICENSE). [Attribution](NOTICE).
