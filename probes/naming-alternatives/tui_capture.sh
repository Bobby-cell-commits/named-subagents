#!/usr/bin/env bash
# Drive an interactive Claude Code session in a detached tmux pane and capture the screen as text.
# Usage: tui_capture.sh <session> <workdir> <frames_dir> <prompt> [extra claude args...]
# Env: SECS (capture duration, default 60), COLS/ROWS (pane size), PRE_ENV (env assignments)
set -uo pipefail
SES=$1; WD=$2; OUT=$3; PROMPT=$4; shift 4
SECS=${SECS:-60}; COLS=${COLS:-160}; ROWS=${ROWS:-50}
mkdir -p "$OUT"; tmux kill-session -t "$SES" 2>/dev/null
tmux new-session -d -s "$SES" -x "$COLS" -y "$ROWS" -c "$WD"
tmux send-keys -t "$SES" "cd $WD && ${PRE_ENV:-} claude --model haiku --setting-sources project,local $*" Enter
sleep 8
tmux capture-pane -p -t "$SES" > "$OUT/boot.txt"
if grep -qi "trust this folder" "$OUT/boot.txt"; then tmux send-keys -t "$SES" Down; sleep 0.5; tmux send-keys -t "$SES" Enter; sleep 6; fi
tmux capture-pane -p -t "$SES" > "$OUT/ready.txt"
tmux send-keys -t "$SES" -l "$PROMPT"; sleep 1; tmux send-keys -t "$SES" Enter
for i in $(seq -w 1 "$SECS"); do sleep 1; tmux capture-pane -p -t "$SES" > "$OUT/f$i.txt"; done
tmux kill-session -t "$SES" 2>/dev/null
