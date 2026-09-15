# Agent Voice

Local dictation for **Forge Code without modifying its binary**, with a Pi
extension that shares the same components. Forge does not depend on Pi.

## Install and use

Forge or Pi must already be installed. On Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/odurif0/agent-voice/main/install.sh | sh -s -- forge --yes
```

This installs and enables the module in your user account, without `sudo`.
It reuses Node.js >= 22 and npm if available; otherwise, it adds a private Node.js
runtime, verified by SHA-256, without replacing yours. `--yes` allows a model
download (~706 MiB) if no compatible model is available. No clone or manual file
management is needed. From a source checkout, use `./install.sh`.

Open a **new Zsh terminal**, then use Forge normally:

- At the Zsh prompt, **Ctrl+Alt+Z** starts/stops dictation. An empty line becomes
  `: dictated text`; a `: …` or `:muse …` request receives text at the cursor.
  Existing shell commands are left untouched.
- Inside **`forge`**, use the same shortcut and the usual command.
- **Enter** also stops dictation, without submitting the text. Press Enter again
  after transcription to submit it. **Esc** cancels.

The `agent-voice` Oh My Zsh plugin is registered automatically, without changing
Forge's plugin or initialization block. It loads the official plugin if needed,
without imposing a theme. Zsh without Oh My Zsh is also supported.
Outside Zsh, use `forge-voice`. Forge subcommands, `-p` requests and pipes bypass
the voice terminal. Existing `forge` aliases and functions are preserved.

The first launch offers multilingual Parakeet (~706 MiB) if no compatible model
is available. Audio is never sent online or recorded to disk.

To add Pi, run `agent-voice install pi`. For a first installation with Pi only,
use `./install.sh pi`. In the remote install command, replace `forge` with `pi`
or `all` to choose Pi only or both integrations.

Run `/reload` in Pi, then use the same shortcut. `/voice` configures the model,
language and microphone. The installer disables pi-transcribe if present, but
preserves its files and settings. Installing for Forge alone does not change Pi.

## Shared resources

- If Pi/pi-transcribe is already installed, its compatible libraries and model
  are reused without moving or copying them. Settings are adopted on first use.
- If Forge is installed first, the Pi integration **in this package** finds the
  same resources. Installation order does not matter.
- Models use the standard Hugging Face cache. New libraries are installed under
  `~/.local/share/agent-voice` on Linux.
- If a borrowed library disappears when Pi is removed, it is reinstalled on the
  next use. Only tested versions are considered compatible.

Other integrations can use `src/index.mjs`, including `registerInstallation()`
to register their components. Third-party extensions do not share libraries
automatically: their installers must implement this connection. No background
service is required.

## Settings and diagnostics

```sh
agent-voice setup --language en
agent-voice setup --shortcut f2       # if the terminal intercepts Ctrl+Alt+Z
agent-voice microphones
agent-voice setup --microphone 2
agent-voice doctor
```

Restart Forge after changing settings. After changing the shortcut, open a new
Zsh terminal; in Pi, run `/reload`.
Shared settings: `~/.local/share/agent-voice/settings.json`.
`AGENT_VOICE_HOME` overrides this directory. Standard Hugging Face variables
(`HF_HUB_CACHE`, `HF_HOME`) and `PI_CODING_AGENT_DIR` are respected.
Dictation and audio files are limited to 10 minutes. Only file transcription
(`agent-voice transcribe file.wav`, Pi tool `transcribe_file`) requires FFmpeg.

`agent-voice uninstall forge` removes only the Zsh/Oh My Zsh integration, for
future terminals. Personal `.zshrc` changes outside the Agent Voice block are
preserved; a manually edited block is not overwritten. `agent-voice uninstall pi`
reactivates the previous extension if its settings have not changed.
Shared resources remain installed in both cases.

## Verification

Dictation has been tested on Linux with Forge 2.13.21 and Pi 0.85.1. It has not
yet been validated on macOS or Windows. The launchers and shell installer target
Linux/macOS. The Forge launcher adds a status line to the terminal; it is not a
native Forge extension.

From the sources, with Zsh installed: `npm ci && npm test && npm run check`.
GitHub Actions runs these checks on Linux and macOS with Node.js 22 and 24.
The tests use no microphone or network access. Installer tests simulate
downloads, including installation without Node.js, reinstallation and download
failures.

`npm run test:native` is an opt-in Linux test requiring Forge, Pi, Oh My Zsh,
PipeWire/PulseAudio (`pactl`, `paplay`) and an already configured model. It creates
a private virtual microphone, synthesizes an English sentence and checks Zsh,
Forge, Pi and resource sharing. Test Zsh settings and histories are isolated.
No requests are sent to the agents.
