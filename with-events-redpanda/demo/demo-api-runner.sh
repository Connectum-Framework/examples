#!/usr/bin/env bash
# Runner for tmux-based API demo recording.
# Creates 3-pane layout: API client (left) + Order logs + Inventory logs (right).
# Used by demo-api.tape (VHS).
set -euo pipefail

# Clear old logs
> demo/order-service.log
> demo/inventory-service.log

# Kill any existing demo session
tmux kill-session -t demo 2>/dev/null || true

# ── Create tmux session ──────────────────────────────────

tmux new-session -d -s demo -x 190 -y 50

# Layout:
#  ┌────────────────────┬────────────────────┐
#  │                    │ Order Service Logs  │
#  │   API Client       │    (pane 1)        │
#  │   (pane 0)         ├────────────────────┤
#  │                    │ Inventory Service   │
#  │      (50%)         │  Logs (pane 2)     │
#  │                    │      (50%)         │
#  └────────────────────┴────────────────────┘

# Split vertically: left 50% for API, right 50% for logs
tmux split-window -h -t demo -p 50

# Split right pane horizontally into two log rows
tmux select-pane -t demo:0.1
tmux split-window -v -t demo:0.1

# ── Style tmux ───────────────────────────────────────────

# Pane borders (Dracula colors)
tmux set -g pane-border-style "fg=#6272a4"
tmux set -g pane-active-border-style "fg=#bd93f9"

# Pane border labels
tmux set -g pane-border-status top
tmux set -g pane-border-format " #{?pane_active,#[fg=#50fa7b],#[fg=#6272a4]}#{pane_title} "

# Hide status bar
tmux set -g status off

# Set pane titles
tmux select-pane -t demo:0.0 -T "API Client"
tmux select-pane -t demo:0.1 -T "Order Service Logs"
tmux select-pane -t demo:0.2 -T "Inventory Service Logs"

# ── Start log tailing ────────────────────────────────────

tmux send-keys -t demo:0.1 "tail -f demo/order-service.log 2>/dev/null" Enter
tmux send-keys -t demo:0.2 "tail -f demo/inventory-service.log 2>/dev/null" Enter

sleep 1

# ── Run API script in left pane ──────────────────────────

tmux send-keys -t demo:0.0 "bash demo/demo-api-script.sh" Enter

# Focus left pane
tmux select-pane -t demo:0.0

# Attach to session (VHS records this)
tmux attach -t demo
