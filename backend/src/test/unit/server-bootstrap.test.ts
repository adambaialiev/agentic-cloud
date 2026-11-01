import { describe, expect, it } from 'vitest';
import {
  SERVER_BOOTSTRAP_SUMMARY,
  buildServerBootstrapCommand,
} from '../../services/server-bootstrap.js';

describe('server bootstrap', () => {
  it('sets up the non-root agent SSH user after package installation', () => {
    const command = buildServerBootstrapCommand();

    expect(command).toContain('apt_get_with_retry install -y ca-certificates curl unzip jq ripgrep git gh tmux nodejs npm build-essential python3 make g++');
    expect(command).toContain('if ! id -u agent >/dev/null 2>&1; then useradd -m -s /bin/bash agent; fi');
    expect(command).toContain('mkdir -p /home/agent/.ssh');
    expect(command).toContain('cp /root/.ssh/authorized_keys /home/agent/.ssh/authorized_keys');
    expect(command).toContain('chown -R agent:agent /home/agent/.ssh');
    expect(command.indexOf('apt_get_with_retry install -y')).toBeLessThan(command.indexOf('useradd -m -s /bin/bash agent'));
    expect(SERVER_BOOTSTRAP_SUMMARY).toContain('prepared the `agent` SSH user');
  });

  it('gives the agent user a real login shell and a tmux runtime dir so tmux sessions start cleanly', () => {
    const command = buildServerBootstrapCommand();

    // New servers get bash directly; pre-existing agents (created without -s, defaulting to /bin/sh) are repaired.
    expect(command).toContain('useradd -m -s /bin/bash agent');
    expect(command).toContain('usermod -s /bin/bash agent');
    // tmux's default socket dir is /tmp/tmux-<uid>; pre-create it owned by agent.
    expect(command).toContain('install -d -m 700 -o agent -g agent "/tmp/tmux-$(id -u agent)"');
    expect(command.indexOf('useradd -m -s /bin/bash agent')).toBeLessThan(command.indexOf('usermod -s /bin/bash agent'));
  });
});
