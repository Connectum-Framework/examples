# Connectum EventBus + Redpanda: Live Saga Demo (tmux)
#
# Prerequisites: run `bash demo/demo-setup.sh` first.
# Run from project root: vhs demo/demo-api.tape
# Requires: tmux, curl, jq pre-installed (use Docker entrypoint)
#
# Output: demo-api.gif

Output demo-api.gif

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 17
Set Width 1600
Set Height 900
Set Theme "Dracula+"
Set TypingSpeed 1ms
Set Padding 10

Hide
Type "cd /vhs && bash demo/demo-api-runner.sh"
Enter
Sleep 500ms
Show

Sleep 90s
