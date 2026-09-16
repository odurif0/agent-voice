# GooeyPi example

Integration notes for the [method](../METHOD.md), observed with
[GooeyPi v1.1.17](https://github.com/am-will/gooey-pi/tree/v1.1.17).
Recheck the installed interface and source before applying them.

## Dictation and the orb are separate

The composer microphone is dictation; the floating orb is a conversation
feature. In this version, self-hosted dictation settings do not disconnect the
orb from OpenAI Realtime. A working composer microphone does not validate the orb.

The native self-hosted provider in
[voice.ts](https://github.com/am-will/gooey-pi/blob/v1.1.17/electron/main/voice.ts)
accepts multipart WAV input and JSON `{text}` output. An empty model ID forces
`en-US`; use an identifier accepted by the chosen service. Browser WAV capture
may need resampling or channel conversion.

## Route the orb through the selected agent

Trace the normal composer send path in
[App.tsx](https://github.com/am-will/gooey-pi/blob/v1.1.17/src/App.tsx) and
[useWorkspaceActions.ts](https://github.com/am-will/gooey-pi/blob/v1.1.17/src/hooks/useWorkspaceActions.ts).
The selected agent need not be Pi just because the host is GooeyPi.

Replacing the orb's OpenAI path requires an application change in this version;
a transcription URL alone is insufficient. Retain the orb and its controls,
connecting local capture, turn detection and playback to that send path. Apply
the method's approval, build-baseline and session-safety rules; do not reuse an
old adapted AppImage merely because it worked on another machine.

## Packaged audio permissions

In the tested build, both the HTML policy and packaged response headers
constrained audio. Local WASM needed `wasm-unsafe-eval`; blob WAV playback needed
`media-src 'self' blob:`. Determine the minimum policy for the chosen integration,
without enabling general JavaScript `unsafe-eval` or removing the policy.
Exercise the method's conversation tests in the exact artifact to be installed.
