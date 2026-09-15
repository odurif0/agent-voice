#!/bin/sh
# One installer for a checkout and curl | sh. The function is parsed in full
# before execution, so child commands never consume the incoming script.
main() (
    set -eu
    target=${1:-forge}
    case "$target" in
        -h|--help) echo 'Usage: install.sh [forge|pi|gooeypi|all] [--yes] [setup options]'; exit 0 ;;
        forge|pi|gooeypi|all) ;;
        *) echo 'Choose forge, pi, gooeypi or all.' >&2; exit 2 ;;
    esac
    if [ "$#" -gt 0 ]; then shift; fi
    fail() { printf 'agent-voice: %s\n' "$*" >&2; exit 1; }
    download() { curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --retry 2 "$1" --output "$2"; }
    node_ready() { command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; }

    case "$(uname -s)" in
        Linux) platform=linux; data=${XDG_DATA_HOME:-"$HOME/.local/share"} ;;
        Darwin) platform=darwin; data="$HOME/Library/Application Support" ;;
        *) fail 'This installer supports Linux and macOS only.' ;;
    esac
    prefix=${AGENT_VOICE_PREFIX:-"$HOME/.local"}
    mkdir -p "$prefix"
    prefix=$(CDPATH= cd -- "$prefix" && pwd -P)
    temp=$(mktemp -d)
    trap 'rm -rf "$temp"' 0
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    root=''
    case "$0" in
        */install.sh|install.sh)
            candidate=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
            if [ -f "$candidate/package.json" ] && [ -f "$candidate/src/cli.mjs" ]; then root=$candidate; fi ;;
    esac
    if [ -z "$root" ]; then
        command -v curl >/dev/null 2>&1 || fail 'curl is required to download the module.'
        download 'https://github.com/odurif0/agent-voice/archive/refs/heads/main.tar.gz' "$temp/source.tar.gz"
        root="$temp/source"
        mkdir "$root"
        tar -xzf "$temp/source.tar.gz" -C "$root" --strip-components=1
        [ -f "$root/package.json" ] && [ -f "$root/bin/launch.sh" ] || fail 'Incomplete Agent Voice archive.'
    fi

    # Reuse a suitable Node first. A fallback belongs to Agent Voice only:
    # no sudo, no global node/npm links, no replacement of an existing runtime.
    node_home=''
    if ! node_ready; then
        node_home="${AGENT_VOICE_HOME:-"$data/agent-voice"}/runtime/node/24.18.1"
        if ! (PATH="$node_home/bin:$PATH"; node_ready); then
            command -v curl >/dev/null 2>&1 || fail 'curl is required to install Node.js.'
            case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) fail 'Unsupported architecture (x64 and arm64 only).' ;; esac
            # Official https://nodejs.org/dist/v24.18.1/SHASUMS256.txt
            case "$platform-$arch" in
                linux-x64) sha=9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca ;;
                linux-arm64) sha=df224555a083b918e46260cc969838501b9f9a87140c1195e5b9597b56d5dae2 ;;
                darwin-x64) sha=6fb20fceacbb157c2f95825b80df4a454a0f6d81cdcd7bb81eeae9147e0e76ec ;;
                darwin-arm64) sha=eb02f7fab96d3d67de40c5ec8566096fcb4c2026728787683ae5a97eb612b941 ;;
            esac
            printf 'Installing Node.js 24.18.1 for Agent Voice…\n'
            download "https://nodejs.org/dist/v24.18.1/node-v24.18.1-$platform-$arch.tar.gz" "$temp/node.tar.gz"
            if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temp/node.tar.gz");
            elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$temp/node.tar.gz");
            else fail 'sha256sum or shasum is required to verify Node.js.'; fi
            [ "${actual%% *}" = "$sha" ] || fail 'Node.js SHA-256 checksum mismatch.'
            mkdir "$temp/node"
            tar -xzf "$temp/node.tar.gz" -C "$temp/node" --strip-components=1
            (PATH="$temp/node/bin:$PATH"; node_ready) || fail 'The Node.js binary does not run on this system.'
            # Do not overwrite a partial or foreign installation silently.
            [ ! -e "$node_home" ] || fail "An incomplete Node.js installation already exists: $node_home"
            mkdir -p "$(dirname -- "$node_home")"
            mv "$temp/node" "$node_home"
        fi
        node_home=$(CDPATH= cd -- "$node_home" && pwd -P)
        PATH="$node_home/bin:$PATH"
        export PATH
    fi

    node -e 'if (require(process.argv[1]).name !== "agent-voice") process.exit(1)' "$root/package.json" || fail 'This directory does not contain Agent Voice.'
    npm pack "$root" --pack-destination "$temp" --silent </dev/null >/dev/null
    npm install --global --prefix "$prefix" --ignore-scripts --omit=dev --no-audit --no-fund "$temp"/agent-voice-*.tgz </dev/null
    if [ -n "$node_home" ]; then ln -s "$node_home" "$prefix/lib/node_modules/agent-voice/.node-runtime"; fi
    # Let Zsh make the new commands available, without changing which existing
    # programs take precedence in PATH. The line is removed with our own block.
    export AGENT_VOICE_BIN_DIR="$prefix/bin"
    # Check the closed-app requirement before altering Forge/Pi in an all install.
    if [ "$target" = gooeypi ] || [ "$target" = all ]; then "$prefix/bin/agent-voice" install gooeypi "$@"; fi
    if [ "$target" = forge ] || [ "$target" = all ]; then "$prefix/bin/agent-voice" install forge "$@"; fi
    if [ "$target" = pi ] || [ "$target" = all ]; then "$prefix/bin/agent-voice" install pi "$@"; fi
    case ":$PATH:" in *":$prefix/bin:"*) ;; *) printf '\nCommands installed in %s/bin.\nIn Zsh, open a new terminal; otherwise use: %s/bin/forge-voice\n' "$prefix" "$prefix" ;; esac
)
main "$@"
