# Installation method

These instructions are for the coding agent performing the installation. Work
from the actual machine and the installed harness, not from a fixed recipe.
The method applies to other harnesses too; it does not guarantee that every
application exposes a usable integration point.

## 1. Establish the requested behavior

Distinguish two workflows before choosing components:

- **Dictation:** speech becomes editable text in the existing input. Stopping a
  recording must not submit the prompt.
- **Spoken conversation:** a spoken turn reaches the selected agent through its
  normal message path, and its reply is read aloud. Keep the same session,
  model, history and tools. Do not create a second agent for the voice interface.

Identify the intended control: shell shortcut, editor microphone, floating orb
or another surface. A dictation button and a conversation orb may use different
backends. If the request leaves this unclear, ask before making changes. A
reduced scope needs approval: dictation alone does not complete a request for
spoken conversation.
Establish the spoken language, turn-ending behavior and desired privacy. Use
local transcription and speech synthesis unless the user requests otherwise;
the agent's existing model provider may still receive the transcribed text.

## 2. Inspect without changing anything

Find the installed application and version, OS, shell or GUI, configuration
location, launch command, and active session. Read the documentation and, where
needed, the source corresponding to that version. Trace which process owns
input, message submission and audio playback. Do not infer capability from a
button label or a configuration field alone.

Inventory existing voice extensions, services, speech engines, models, caches
and runtimes. Check their actual paths, versions and interfaces. Treat an
installed Agent Voice runtime as existing software to inspect, not as a reason
to overwrite it with this documentation checkout. Verify where audio is processed,
including built-in or OS dictation: local capture does not prove local transcription.

Look for supported extensions, editor hooks, local audio APIs or ordinary message
APIs. Check microphone access, playback, service startup and terminal key delivery
on this machine. Note running applications, local source edits and update behavior.
Ask the user only for choices or permissions you cannot determine by inspection;
never print credentials or private endpoint tokens while investigating.

## 3. Propose the smallest integration

Prefer an existing native feature, then a supported extension or configuration,
then a small adapter. A local audio service is useful when the interface can call
it; it is not a requirement for every harness. Do not impose a language, package
manager, model or daemon just because a previous installation used one.

If the application needs a source change, identify that requirement explicitly.
Explain how the adapted build will be maintained and updated. Do not silently
replace the application, disable updates, or substitute a cloud voice agent.
If no usable interface or source access exists, report the blocker rather than
claiming the method can bypass it.

Present a brief plan naming the chosen input/submission path, reused and missing
components, files or settings to change, downloads, tests and rollback. Obtain
approval before making changes. Work within that approval without repeatedly
asking the user to perform installation steps. Seek further approval if the scope
changes or a system-level installation or additional data destination is needed.

## 4. Install only what is missing

Select compatible components using their current upstream documentation,
licenses, language support and hardware requirements. Existing native features
may need no additional audio backend. Projects such as
[pi-transcribe](https://github.com/earendil-works/pi-transcribe) and
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) are possible resources, not
mandatory dependencies or a package set to install wholesale.

Reuse compatible libraries and model files without moving or duplicating them.
Use an existing standard cache where possible. Document how a later integration
can discover the same resources, and check both installation orders in an
isolated test setup when claiming reciprocal sharing. Third-party installers
do not share automatically.

Install missing dependencies within the user account when possible. Verify
artifacts against trusted upstream checksums or signatures, retain required
attributions, and record the versions actually installed. Keep credentials and
private machine paths out of public commits and logs.

Keep shared audio resources independent of harness adapters. Installing for one
harness must not require another harness or alter its configuration. Provide
startup appropriate to this machine if a service is necessary; for a local HTTP
service, restrict access to loopback, protect the endpoint, and bound requests.
Keep audio out of persistent storage unless the user explicitly requests it.

## 5. Connect the requested interface

For dictation, insert at the cursor, preserve existing text, and require a
separate submission action. Cancellation and failed transcription must leave the
draft intact. If Enter stops recording, consume that key rather than submitting
it; ignore submission keys during transcription. Pasted newlines are not presses
of the stop key. Discover a usable shortcut instead of assuming the terminal
will deliver a particular key combination.

For conversation, use the harness's normal send path. Bind each recording and
reply to its session; a session, project or harness switch must cancel stale
work. Define how pauses, mute and interruption work. Do not capture the spoken
reply as the user's next turn, or read tool output as an assistant reply.
Closing must release the microphone and stop playback and pending audio work.

Preserve the existing interface and ordinary non-voice behavior. Add only the
necessary adapter. Do not redirect every invocation of a CLI through an
interactive wrapper or modify another harness to make sharing work.

Back up only affected settings or application files, then apply reversible
changes. Establish the installed build's baseline, including existing custom
changes. Preserve those changes without mixing in unrelated work in progress;
if the source and installed build differ, resolve the baseline with the user.
Use an isolated working tree when needed. If an application caches its settings,
close it before editing its files; do not force it closed with active work.
Do not install an untested build just because it compiles.

## 6. Verify the installed result

First use an isolated configuration or a test session. Obtain permission before
sending test prompts to a real agent: they may incur charges or invoke tools.
Prefer a harmless test with tools disabled where the harness supports it.

Check the actual application and entry point the user will run:

- Speech in the requested language is captured, transcribed and delivered to the
  intended control. Check channel count, sample rate, resampling and playback
  format rather than assuming a microphone's output matches the model's input.
- Dictation preserves text on both sides of the cursor and does not submit on
  stop. Cancellation, errors and repeated key presses leave the draft intact.
- Conversation uses the selected agent and existing history. For example, place
  a distinctive fact in a test session in writing, then ask about it by voice.
  Verify the session identity and the spoken reply. Also test a new conversation.
- Mute, close, session switches and late results cannot send to another session
  or leave the microphone recording. Ordinary typing and application controls
  still work.
- Restart loads the integration and any required service. Removal restores only
  this integration, preserves intervening user edits and leaves shared resources
  usable by other consumers.

Run relevant automated tests and inspect the rendered interface. Test the
packaged application too if distributing one; development and packaged builds
can have different permissions and security policies. Never weaken general
security checks to make an audio feature pass.

A virtual microphone can verify the audio path but does not prove the user's
physical microphone or shortcut works. State what you actually exercised. If an
OS permission, application shutdown or unsupported interface blocks completion,
report the exact remaining action instead of calling the installation complete.

## 7. Leave a usable installation

Record the integration location, component versions, resource paths, startup
mechanism and removal procedure locally, without exposing secrets. Preserve a
rollback until verification passes. Shared dependencies must survive removal of
one consumer; recover or report clearly if a borrowed component disappears.

Tell the user how to start, stop and cancel voice input, what was verified, and
what remains untested. The coding agent performs the setup and cleanup; the user
should not have to assemble files or follow a sequence of installation commands.

## Examples

Read only the relevant example, and recheck its observations for the installed
version. Examples explain integration decisions; they are not universal patches.

- [Forge Code: terminal and shell dictation](examples/forge.md)
- [GooeyPi: distinguish dictation from the agent conversation orb](examples/gooeypi.md)
