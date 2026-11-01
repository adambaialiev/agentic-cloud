export const FRESH_SERVER_APT_GUIDANCE =
  [
    'When preparing a fresh Ubuntu cloud server, NEVER run `apt-get upgrade` or `apt upgrade`.',
    'Avoid `apt-get upgrade` on fresh servers - it can trigger kernel updates that hang the reboot on Ubuntu 24.04 machines, making the server unreachable over SSH (often surfacing as ECONNREFUSED).',
    'Run `apt-get update` only to refresh package lists, then install only the specific packages needed, such as `apt-get install -y git curl jq ripgrep tmux unzip`.',
    'After the `apt-get install` step, set up the non-root development SSH user once: `useradd -m agent`, `mkdir -p /home/agent/.ssh`, `cp /root/.ssh/authorized_keys /home/agent/.ssh/`, and `chown -R agent:agent /home/agent/.ssh`.',
    'If a kernel or OS package update is truly necessary, handle it separately with caution and prefer `apt-get install --only-upgrade <specific-package>` over a blanket upgrade; be prepared for a potential forced power-cycle.',
  ].join(' ');
