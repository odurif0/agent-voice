# Agent Voice: a ZLE adapter, not a replacement for Forge's shell plugin.
[[ -o interactive ]] || return 0
(( ${+functions[_agent_voice_toggle]} )) && return 0
[[ -z ${AGENT_VOICE_ACTIVE:-} ]] || return 0

typeset -g _agent_voice_root="${${(%):-%N}:A:h:h}"
typeset -ga _agent_voice_keys
typeset -gi _agent_voice_busy=0 _agent_voice_cancelled=0 _agent_voice_result=0
typeset -g _agent_voice_buffer _agent_voice_keymap _agent_voice_tmp

# Do not put helpers, pipes or one-shot requests inside a PTY. In particular,
# Forge's own plugin calls the binary for completion, history and configuration.
function _agent_voice_forge() {
    if [[ ! -t 0 || ! -t 1 || -n ${AGENT_VOICE_ACTIVE:-} || ( $# -gt 0 && $1 != -* ) ]]; then
        command forge "$@"
    elif [[ ( -n ${commands[node]:-} || -x "$_agent_voice_root/.node-runtime/bin/node" ) && -f "$_agent_voice_root/bin/launch.sh" ]]; then
        command "$_agent_voice_root/bin/launch.sh" forge-voice "$@"
    else
        command forge "$@"
    fi
}
# Never overwrite a user's existing alias or function.
if (( ! ${+functions[forge]} && ! ${+aliases[forge]} )); then
    functions[forge]='_agent_voice_forge "$@"'
fi

function _agent_voice_ignore() { return 0 }
function _agent_voice_ignore_paste() {
    local discarded
    zle .bracketed-paste discarded
}

function _agent_voice_cleanup() {
    local repaint=${1:-yes}
    if [[ -n ${_agent_voice_read:-} ]]; then
        zle -F "$_agent_voice_read" 2>/dev/null
        exec {_agent_voice_read}<&-
        unset _agent_voice_read
    fi
    if [[ -n ${_agent_voice_write:-} ]]; then
        exec {_agent_voice_write}>&-
        unset _agent_voice_write
    fi
    if [[ -n $_agent_voice_tmp ]]; then
        command rm -f -- "$_agent_voice_tmp/control"
        command rmdir -- "$_agent_voice_tmp" 2>/dev/null
        _agent_voice_tmp=''
    fi
    _agent_voice_busy=0
    if [[ $repaint == yes ]]; then
        zle -K "$_agent_voice_keymap"
        (( _agent_voice_cancelled || _agent_voice_result )) && zle -M ''
        zle -R
    fi
}

function _agent_voice_cancel() {
    (( _agent_voice_busy )) || return 0
    _agent_voice_cancelled=1
    # Keep the temporary keymap until the worker has released the microphone.
    if ! print -r -u "$_agent_voice_write" -- cancel 2>/dev/null; then
        _agent_voice_cleanup
    else
        zle -M 'Voice: cancelling…'
    fi
}

# Ctrl+C is a tty signal in ZLE, not an ordinary key binding. Zsh does not run
# line-finish on an interrupted edit. Cancel its worker on the next line-init
# and restore the frozen buffer there, without changing termios or signal traps.
function _agent_voice_started_line() {
    (( _agent_voice_busy )) || return 0
    _agent_voice_cancelled=1
    print -r -u "$_agent_voice_write" -- cancel 2>/dev/null
    if [[ $CONTEXT == start && -z $BUFFER ]]; then
        BUFFER=$_agent_voice_buffer
        CURSOR=$_agent_voice_cursor
        _agent_voice_cleanup
    else
        # A nested editor or another plugin's prefilled line is not our prompt.
        _agent_voice_cleanup no
    fi
}

function _agent_voice_finished_line() {
    (( _agent_voice_busy )) || return 0
    _agent_voice_cancelled=1
    print -r -u "$_agent_voice_write" -- cancel 2>/dev/null
    _agent_voice_cleanup no
}

# -F -w gives this callback access to ZLE's buffer. Never read the terminal here.
function _agent_voice_event() {
    local event value
    if ! IFS=$'\t' read -r -u "$1" event value; then
        (( _agent_voice_cancelled || _agent_voice_result )) || zle -M 'Voice: worker interrupted.'
        _agent_voice_cleanup
        return
    fi
    case $event in
        status) (( _agent_voice_cancelled )) || zle -M "$value" ;;
        result)
            if (( ! _agent_voice_cancelled && ! _agent_voice_result )) && [[ -n $value && $BUFFER == $_agent_voice_buffer && $CURSOR == $_agent_voice_cursor ]]; then
                if [[ -z $BUFFER ]]; then
                    BUFFER=": $value"
                    CURSOR=${#BUFFER}
                else
                    LBUFFER+="$value"
                fi
                _agent_voice_result=1
                _agent_voice_buffer=$BUFFER
                _agent_voice_cursor=$CURSOR
            fi
            ;;
        done) _agent_voice_cleanup; return ;;
        *) zle -M 'Voice: invalid worker response.'; _agent_voice_cancel; return ;;
    esac
    zle -R
}

function _agent_voice_freeze() {
    local line
    local -a words
    # Preserve each complete key sequence (arrows, custom bindings…), but turn
    # its action into a no-op. This avoids leaking escape suffixes into BUFFER.
    bindkey -N agent-voice-busy "$_agent_voice_keymap"
    for line in "${(@f)$(bindkey -L -M agent-voice-busy)}"; do
        words=("${(@Q)${(z)line}}")
        words[1]=()
        words[-1]=_agent_voice_ignore
        bindkey "${words[@]}"
    done
    local key
    for key in "${_agent_voice_keys[@]}"; do bindkey -M agent-voice-busy "$key" _agent_voice_toggle; done
    # Only in the recording keymap: stop capture, never accept/submit the line.
    bindkey -M agent-voice-busy '^M' _agent_voice_toggle
    bindkey -M agent-voice-busy '^J' _agent_voice_toggle
    bindkey -M agent-voice-busy $'\e' _agent_voice_cancel
    bindkey -M agent-voice-busy '^C' _agent_voice_cancel
    bindkey -M agent-voice-busy '^G' _agent_voice_cancel
    bindkey -M agent-voice-busy '^D' _agent_voice_cancel
    bindkey -M agent-voice-busy $'\e[200~' _agent_voice_ignore_paste
    zle -K agent-voice-busy
}

function _agent_voice_toggle() {
    if (( _agent_voice_busy )); then
        (( _agent_voice_cancelled )) || print -r -u "$_agent_voice_write" -- stop 2>/dev/null
        return
    fi
    if [[ $CONTEXT != start || ( -n $BUFFER && $BUFFER != :* ) ]]; then
        zle -M 'Voice: use an empty line or a Forge request starting with ":".'
        return
    fi
    if (( ! ${+widgets[forge-accept-line]} )); then
        zle -M 'Voice: Forge plugin not loaded.'
        return
    fi
    if [[ -z ${commands[node]:-} && ! -x "$_agent_voice_root/.node-runtime/bin/node" ]]; then zle -M 'Voice: Node.js not found.'; return; fi
    _agent_voice_buffer=$BUFFER
    typeset -gi _agent_voice_cursor=$CURSOR
    _agent_voice_keymap=$KEYMAP
    _agent_voice_cancelled=0 _agent_voice_result=0
    _agent_voice_tmp=$(command mktemp -d "${TMPDIR:-/tmp}/agent-voice-zsh.XXXXXXXX") || return
    if ! command mkfifo -m 600 -- "$_agent_voice_tmp/control"; then
        _agent_voice_cleanup
        zle -M 'Voice: cannot create the control channel.'
        return
    fi
    _agent_voice_busy=1
    _agent_voice_freeze
    zle -M 'Voice: opening microphone… · Esc: cancel'
    # FIFO carries only stop/cancel, never audio. The output pipe belongs to this
    # take alone, so a late result cannot reach a later editing session.
    exec {_agent_voice_read}< <(command "$_agent_voice_root/bin/launch.sh" agent-voice zsh-session < "$_agent_voice_tmp/control" 2>/dev/null)
    exec {_agent_voice_write}> "$_agent_voice_tmp/control"
    zle -F -w "$_agent_voice_read" _agent_voice_event
}

function _agent_voice_bind_keys() {
    local map key
    for map in emacs viins vicmd main; do
        for key in "${_agent_voice_keys[@]}"; do bindkey -M "$map" "$key" _agent_voice_toggle; done
    done
}

function _agent_voice_init() {
    add-zsh-hook -d precmd _agent_voice_init
    # OMZ is often loaded BEFORE Forge's managed initialization block. Wait for
    # the first prompt; do not edit that block or re-load an existing plugin.
    if (( ! ${+widgets[forge-accept-line]} )) && (( ${+commands[forge]} )); then
        local plugin
        plugin=$(command forge zsh plugin) && eval "$plugin"
    fi
    local keys
    keys=$(command "$_agent_voice_root/bin/launch.sh" agent-voice zsh-keys 2>/dev/null) || {
        print -u2 -- 'Agent Voice: settings unavailable; run agent-voice install forge.'
        return
    }
    _agent_voice_keys=("${(@f)keys}")
    zle -N _agent_voice_toggle
    zle -N _agent_voice_cancel
    zle -N _agent_voice_ignore
    zle -N _agent_voice_ignore_paste
    zle -N _agent_voice_event
    _agent_voice_bind_keys
    # zsh-vi-mode may rebuild its keymaps on its own first precmd.
    typeset -ga zvm_after_init_commands
    (( ${zvm_after_init_commands[(Ie)_agent_voice_bind_keys]} )) || zvm_after_init_commands+=(_agent_voice_bind_keys)
    autoload -Uz add-zle-hook-widget
    add-zle-hook-widget line-finish _agent_voice_finished_line
    add-zle-hook-widget line-init _agent_voice_started_line
    add-zsh-hook zshexit _agent_voice_finished_line
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _agent_voice_init
