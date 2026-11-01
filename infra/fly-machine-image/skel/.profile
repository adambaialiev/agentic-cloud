# Seeded into the agent home on first boot. Login shells (`bash -lc`, tmux
# login windows) read this. Kept minimal; user edits on the volume win because
# first-boot seeding never overwrites an existing file.

# Source .bashrc for interactive login shells so PATH/aliases are consistent.
if [ -n "${BASH_VERSION:-}" ] && [ -f "${HOME}/.bashrc" ]; then
  . "${HOME}/.bashrc"
fi
