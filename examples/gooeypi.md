# GooeyPi example

Apply the [installation method](../METHOD.md) first. These observations come
from [GooeyPi v1.1.17](https://github.com/am-will/gooey-pi/tree/v1.1.17), not a
promise about later versions. Recheck the installed interface and source.

## Choose the right voice control

The composer microphone is dictation. The floating realtime orb is a separate
conversation feature. In the version examined, configuring self-hosted dictation
does not disconnect the orb from OpenAI Realtime. Testing the composer microphone
is not evidence that the orb uses the selected agent.

For dictation, inspect the native provider options before writing an adapter.
The self-hosted path in
[voice.ts](https://github.com/am-will/gooey-pi/blob/v1.1.17/electron/main/voice.ts)
accepts a transcription service with multipart WAV input and JSON `{text}` output.
Check the actual request contract and language handling: in this version an empty
model ID forces `en-US`. Use a model identifier accepted by the chosen service,
rather than copying a label from another backend.

Browser WAV capture may not match the speech model's rate or channel count.
Test decoding and resampling with real captured audio. If the application keeps
settings in memory, editing its settings file while it is running is unsafe.

## Connect conversation to the selected agent

For the orb, trace the normal composer send path in
[App.tsx](https://github.com/am-will/gooey-pi/blob/v1.1.17/src/App.tsx) and
[useWorkspaceActions.ts](https://github.com/am-will/gooey-pi/blob/v1.1.17/src/hooks/useWorkspaceActions.ts).
Reuse that path so voice inherits the selected harness, session, model, context
and tools. Do not call a model API directly or start another runtime for a spoken
turn. The selected agent need not be Pi just because the application is GooeyPi.

In the version examined, replacing the orb's OpenAI path requires an application
change; setting a transcription URL alone is insufficient. Obtain approval for
that change and agree how future updates will be handled. Identify the source
baseline of the installed build, including its existing customizations; a version
label alone is insufficient. Build the voice change in isolation from unrelated
work in progress. If it is unclear which changes belong in the installed version,
ask the user rather than silently resetting to upstream or including everything.
Do not install an old adapted AppImage merely because it worked on another machine.

Keep the existing orb and controls. Add local capture with turn detection,
transcription and speech playback using available compatible components. Cancel
late results when the target session changes, stop playback on mute, and prevent
speaker audio from triggering another turn. Share audio resources if useful,
but do not install or configure a Forge adapter as a dependency.

## Test the distributed application

Verify a spoken question about a fact already in the selected test session, the
reply read aloud, and a conversation started entirely by voice. Check session
identity, cancellation, closing and microphone release.

A working development build is insufficient. In the tested application, both the
HTML policy and packaged response headers constrained audio. Local WASM needed
`wasm-unsafe-eval`; WAV playback from a blob needed `media-src 'self' blob:`.
Determine the minimum policy required by the chosen implementation. Do not enable
general JavaScript `unsafe-eval` or remove the policy.

Replace the application only after testing the exact artifact to be installed,
with a rollback and an explicit update strategy. This adaptation belongs to the
GooeyPi installation, not to a combined Forge/GooeyPi distribution.
