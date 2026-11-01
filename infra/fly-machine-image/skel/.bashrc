# Seeded into the agent home on first boot. First-boot seeding uses
# rsync --ignore-existing, so anything the user later changes here survives
# image rolls.

# Global npm CLIs (claude, codex) live under /usr; keep local bins ahead.
export PATH="${HOME}/.local/bin:${HOME}/bin:${PATH}"

# UTF-8 everywhere so tmux and the CLI TUIs render box-drawing correctly.
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# A sensible default TERM when one is not inherited from the SSH pty.
export TERM="${TERM:-xterm-256color}"

# Interactive niceties only below this line.
case $- in
  *i*) ;;
    *) return;;
esac

export HISTSIZE=10000
export HISTFILESIZE=20000
export HISTCONTROL=ignoreboth
shopt -s histappend checkwinsize

alias ll='ls -alF'
alias la='ls -A'
