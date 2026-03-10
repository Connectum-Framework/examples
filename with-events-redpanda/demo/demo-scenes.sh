#!/usr/bin/env bash
# Scene helpers for VHS walkthrough tape.
# Sourced inside VHS Docker container.

export BAT_PAGER=''
export COLORTERM=truecolor

# Display a colored section header
header() {
    echo -e "\n  \033[1;36m▸ $1\033[0m\n"
}

# Show a file with bat (syntax highlighting)
# Usage: show <file> [line-range]
show() {
    local file="$1"
    local range="${2:-}"
    local args=(--paging=never --theme=Dracula --style=header,grid,numbers --color=always)
    if [ -n "$range" ]; then
        args+=(-r "$range")
    fi
    bat "${args[@]}" "$file"
}

# Scene: Title screen
scene_title() {
    clear
    printf '\n\n\n\n'
    echo -e "       \033[1;35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
    echo ""
    echo -e "         \033[1;37mConnectum EventBus + Redpanda\033[0m"
    echo -e "         \033[0;36mSaga Pattern · 2 Microservices · Custom Topics\033[0m"
    echo ""
    echo -e "       \033[1;35m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\033[0m"
    printf '\n'
}

# Scene: Quick Start
scene_quickstart() {
    clear
    echo -e "\n  \033[1;32m══════════════════════════════════════════════════\033[0m"
    echo -e "  \033[1;32m  Quick Start\033[0m"
    echo -e "  \033[1;32m══════════════════════════════════════════════════\033[0m"
    echo ""
    echo "    $ pnpm install"
    echo "    $ pnpm run build:proto"
    echo "    $ docker compose up -d redpanda console"
    echo ""
    echo "    $ pnpm run start:order        # terminal 1 — port 5001"
    echo "    $ pnpm run start:inventory    # terminal 2 — port 5002"
    echo ""
    echo -e "    \033[1;34mRedpanda Console: http://localhost:8080\033[0m"
    echo ""
    echo -e "  \033[1;32m══════════════════════════════════════════════════\033[0m"
    echo ""
}
