#!/bin/sh
set -eu
# npm links both commands to this launcher; Zsh calls it with an explicit name.
case "${0##*/}" in
    agent-voice|forge-voice) entry=${0##*/} ;;
    *) entry=${1:-agent-voice}; if [ "$#" -gt 0 ]; then shift; fi ;;
esac
case "$entry" in agent-voice|forge-voice) ;; *) echo 'Unknown voice command.' >&2; exit 2 ;; esac
self=$0
while [ -L "$self" ]; do
    folder=$(CDPATH= cd -- "$(dirname -- "$self")" && pwd -P)
    link=$(readlink "$self")
    case "$link" in /*) self=$link ;; *) self=$folder/$link ;; esac
done
root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)
if [ -x "$root/.node-runtime/bin/node" ]; then
    PATH="$root/.node-runtime/bin:$PATH"
    export PATH
fi
exec node "$root/bin/$entry.mjs" "$@"
