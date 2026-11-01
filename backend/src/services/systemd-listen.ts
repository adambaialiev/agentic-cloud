const SYSTEMD_FD_START = 3;
const BACKEND_FD_NAME = 'backend-http';

type SystemdListenEnv = {
  [name: string]: string | undefined;
  LISTEN_PID?: string;
  LISTEN_FDS?: string;
  LISTEN_FDNAMES?: string;
};

/**
 * Consume the socket-activation contract systemd passes to this process.
 *
 * systemd keeps the listening socket open while the service restarts. The new
 * process inherits a duplicate at fd 3, so requests arriving during startup
 * wait in the kernel backlog instead of Caddy receiving ECONNREFUSED.
 *
 * The environment is cleared exactly as sd_listen_fds(..., true) clears it:
 * this backend launches many child processes, and none of them should mistake
 * our inherited listener for one of their own.
 */
export function consumeSystemdListenFd(
  env: SystemdListenEnv = process.env,
  pid = process.pid,
): number | undefined {
  const rawPid = env.LISTEN_PID;
  const rawFds = env.LISTEN_FDS;
  const rawNames = env.LISTEN_FDNAMES;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;

  if (!rawPid && !rawFds && !rawNames) return undefined;
  if (!/^\d+$/.test(rawPid ?? '') || Number(rawPid) !== pid) return undefined;
  if (!/^\d+$/.test(rawFds ?? '')) {
    throw new Error(`systemd socket activation supplied invalid LISTEN_FDS=${rawFds ?? '(missing)'}`);
  }
  const count = Number(rawFds);
  if (count !== 1) {
    throw new Error(`systemd socket activation expected one listener, received ${count}`);
  }
  if (rawNames && rawNames !== BACKEND_FD_NAME) {
    throw new Error(`systemd socket activation expected ${BACKEND_FD_NAME}, received ${rawNames}`);
  }
  return SYSTEMD_FD_START;
}
