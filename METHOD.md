# Install voice in the current harness

Treat "install agent-voice" as a request to add voice to the harness from which
this method is invoked. Inspect the machine, reuse suitable audio components,
and choose current speech recognition that fits its capabilities. Perform the
integration yourself; the user should not have to assemble files or run an
installation procedure.

## 1. Inspect the harness and machine

Before asking questions or changing anything, identify the host application,
version, interface, launch command, settings and active session. A GUI may host
another agent runtime: trace which process owns input, submission and playback.
Read the matching documentation or source to find native voice features,
extensions and integration points; a button label alone does not prove capability.
Consult only the relevant [Forge](examples/forge.md) or
[GooeyPi](examples/gooeypi.md) example, rechecking its version-specific observations.

Inspect:

- OS, CPU, GPU, available RAM/VRAM and supported acceleration backends.
- Existing voice extensions, engines, models, caches and services: paths,
  versions, interfaces and other consumers. Do not replace a running runtime
  with this documentation checkout.
- Microphone and playback access, terminal key delivery where relevant, and
  where audio is processed. Local capture does not prove local transcription.
- Running applications, local customizations and update mechanisms.

Infer the intended workflow (dictation, spoken conversation or both), language,
controls and turn-ending behavior from the request and interface. Ask only for
unresolved choices or permissions, grouping questions when possible. Do not ask
the user to supply discoverable machine details or select technical components.

## 2. Select and share the audio components

Use local transcription and, when needed, speech synthesis unless the user
requests otherwise. The agent's existing model provider may still receive text.

Choose state-of-the-art speech recognition suitable for this machine instead
of defaulting to a fixed engine or the largest model. Compare current upstream
documentation and relevant benchmarks for language accuracy, latency, memory needs,
OS/acceleration support and license. Verify the chosen trade-off on this machine
during testing. Keep existing components when they meet these needs; justify any
replacement. [pi-transcribe](https://github.com/earendil-works/pi-transcribe) and
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) are possible resources, not
mandatory dependencies or a model shortlist.

Share compatible engines, services and model files independently of harness
adapters. Reuse their existing paths and standard caches without moving or
copying them. Check compatibility and ownership before changing a shared
component; preserve its other consumers. Add or replace only what the current
harness needs, without requiring or configuring another harness. Removing one
adapter must leave shared resources usable; recover or report clearly if a
borrowed component disappears.

## 3. Propose the integration

Prefer a suitable native feature, then a supported extension or configuration,
then a small adapter. Introduce a service only if the integration needs one.
If source changes are necessary, explain the build baseline, preservation of
existing customizations and update strategy. Do not silently replace the
application, disable updates or substitute another voice agent. Report a blocker
if neither a supported interface, an external adapter nor an approved source
change can deliver the requested behavior.

Present a brief plan: input/submission path, chosen and reused components,
changes, downloads, tests and rollback. Obtain approval before applying it.
Include any system-level installation, new data destination and real-agent test
prompts in that approval. Ask again only for changes outside the agreed scope.

## 4. Install and connect

Back up affected files. Match source changes to the installed build, retaining
customizations without bundling unrelated work; use an isolated worktree if
needed. Resolve an uncertain baseline with the user. Close applications before
editing settings they cache, without forcing a shutdown during active work.

Install dependencies under the user account where possible. Verify downloads
against trusted upstream checksums or signatures and retain license notices.
Provide appropriate startup for any service. Local HTTP endpoints must use
loopback, access protection and bounded requests. Never print credentials or
commit secrets. Keep private paths out of public logs and commits, and do not
persist audio without permission.

Preserve the existing interface, ordinary typing and non-interactive commands.
Bind audio work to its session; session, project or harness switches cancel stale
work. Closing the voice control releases the microphone and stops playback and
pending work. Apply only the requested workflows:

- **Dictation:** insert at the cursor without losing surrounding text. Stopping
  must not submit; require a separate send action. Cancellation and errors leave
  the draft and cursor intact. Consume any stop key and ignore submission keys
  during transcription; pasted newlines are not key presses.
- **Conversation:** send through the harness's normal message path, keeping the
  selected agent, session, model, history and tools. Read its replies aloud, not
  tool output. Define pauses and interruption, stop playback on mute, and prevent
  spoken replies from triggering new turns.

Do not silently reduce a conversation request to dictation.

## 5. Verify and leave a usable installation

Use an isolated configuration or test session first. Real-agent prompts need
approval because they may incur charges or invoke tools; disable tools for tests
where supported. Test the actual entry point; if replacing the application, test
the exact packaged artifact first. Compilation or a working development build
is insufficient. Run relevant automated tests and inspect the interface without
weakening general security checks.

Check the requested workflow:

- Transcribe representative speech in the target language. Check accuracy,
  latency and memory use, plus capture, decoding, channel count, sample rate,
  resampling and playback format as applicable.
- For dictation, verify insertion between existing text, stop without sending,
  cancellation, failures, repeated keys and normal editing.
- For conversation, put a distinctive fact in the test session in writing and
  ask about it by voice. Verify session identity and the spoken reply; also
  start a new conversation by voice. Test mute and interruption.
- Test closing and session, project or harness switches, including late results:
  no stray text insertion, send, playback or recording.
- Verify restart and removal. Removal must preserve intervening user edits and
  shared resources. If claiming sharing in either installation order, test both
  in isolation; third-party installers do not share automatically.

A virtual microphone does not validate the user's physical microphone or
shortcut. Report exactly what passed, what remains untested and any blocking
permission or application limitation; do not label a partial setup complete.

Record locally the integration location, component versions, resource paths,
shared-resource discovery, startup and removal procedure, without secrets.
Keep rollback until verification passes. Explain the start, stop and cancel
controls, and perform installation cleanup yourself.
