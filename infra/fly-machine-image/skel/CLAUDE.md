<!-- MACHINE-FACTS:START -->
(placeholder — regenerated every boot; do not edit by hand)
<!-- MACHINE-FACTS:END -->
# Waiting for the platform docs
Everything below the machine-facts block is replaced by the platform with the current docs — normally before your first turn, so you should not be reading this. If you are, that write has not landed yet: this machine is running on what its image shipped with, and the platform will correct it.
This file is NOT yours to edit. **`~/SCRATCHPAD.md` is yours** — put durable lessons, project rules and gotchas there, and nothing will ever touch them.
# Four things that hold either way
- **Only `/home/agent` is durable.** Everything else is rebuilt on an image upgrade. Put anything you'd hate to lose in a git repo you have pushed.
- **Port 8080 is your public port.** Serve on `0.0.0.0:8080` from a detached process whose lifecycle matches the work.
- **Your shell dies when your turn ends — and takes ordinary background processes with it.** `command &`, `nohup`, and anything merely "run in the background" is killed seconds after your reply is sent. In this short pre-platform fallback, detached tmux survives a turn but not machine sleep; use `~/.boot.d/*.sh` for restartable services or watchers.
- **Docker works here.** `docker` and `docker compose` are installed and the first `docker` command starts it; its data lives on your durable disk. It stops when the machine sleeps; containers with `restart: unless-stopped` come back on wake.
