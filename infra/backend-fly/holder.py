#!/usr/bin/env python3
"""The backend's socket holder on Fly (note #1032, stage 4).

On ia-backend, systemd held the backend's listening socket
(infinite-agents-backend.socket) and restarted only Node behind it, so a
deploy or an image repoint made requests wait in the kernel backlog for about
a second instead of failing. A Fly machine has no systemd, so this process
does the same job:

  * it binds [::]:3001 (both IPv4 and IPv6, backlog 4096) and never accepts
    on it itself;
  * it runs the release under /opt/infinite-agents/current with that socket
    as fd 3 and the systemd activation contract (LISTEN_FDS=1, LISTEN_PID,
    LISTEN_FDNAMES=backend-http), which services/systemd-listen.ts consumes;
  * it reads /etc/infinite-agents/backend.env before every start, exactly as
    the unit's EnvironmentFile did, so set-machine-image keeps working;
  * it restarts Node on failure after 5 s (Restart=on-failure, RestartSec=5)
    and gives it 30 s to drain on stop (TimeoutStopSec=30).

`enabled` survives a machine restart (a file on the volume), and a machine
that boots with it off holds no socket and runs nothing: that is how the new
backend waits, created and reachable over SSH, until the cutover turns it on.
Two backends must never run at once.

It is driven through /run/ia-backend/control.sock by the `systemctl` shim in
this image, which speaks for the two units deploy-prod, ia-rollback and
set-machine-image know (infinite-agents-backend.service and .socket).
"""

import json
import os
import signal
import socket
import sys
import threading
import time

PORT = int(os.environ.get('HOLDER_PORT', '3001'))
ENV_FILE = os.environ.get('HOLDER_ENV_FILE', '/etc/infinite-agents/backend.env')
RELEASE = os.environ.get('HOLDER_RELEASE', '/opt/infinite-agents/current')
STATE_DIR = os.environ.get('HOLDER_STATE_DIR', '/data/state')
ENABLED_FILE = os.path.join(STATE_DIR, 'backend.enabled')
CONTROL = os.environ.get('HOLDER_CONTROL', '/run/ia-backend/control.sock')
LOG_FILE = os.environ.get('HOLDER_LOG', '/data/log/backend.log')
LOG_MAX = 100 * 1024 * 1024
LOG_KEEP = 5
STOP_TIMEOUT = 30
RESTART_SEC = 5
NODE = os.environ.get('HOLDER_NODE', '/usr/bin/node')
# Variables of the holder's own that the backend must not inherit.
OWN_ENV = {'HOLDER_PORT', 'HOLDER_ENV_FILE', 'HOLDER_RELEASE', 'HOLDER_STATE_DIR',
           'HOLDER_CONTROL', 'HOLDER_LOG', 'HOLDER_NODE', 'DEPLOY_AUTHORIZED_KEYS'}

lock = threading.RLock()
listener = None          # the held socket
child = None             # pid of the running backend, or None
want_running = False     # service "active" as systemd would say it
log_fh = None


def say(line):
    msg = f'[holder] {line}\n'
    sys.stdout.write(msg)
    sys.stdout.flush()
    write_log(msg.encode())


def write_log(data):
    global log_fh
    try:
        if log_fh is None:
            os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
            log_fh = open(LOG_FILE, 'ab')
        log_fh.write(data)
        log_fh.flush()
        if log_fh.tell() > LOG_MAX:
            log_fh.close()
            log_fh = None
            for i in range(LOG_KEEP - 1, 0, -1):
                src = f'{LOG_FILE}.{i}'
                if os.path.exists(src):
                    os.replace(src, f'{LOG_FILE}.{i + 1}')
            os.replace(LOG_FILE, f'{LOG_FILE}.1')
    except OSError:
        log_fh = None


def parse_env_file(path):
    """systemd EnvironmentFile= semantics, for the shapes backend.env uses.

    KEY=value, blank lines and # or ; comments; a value in double quotes
    keeps everything inside and unescapes only \\\\ \\" \\$ \\` (so a key
    written with literal \\n stays that way, as systemd leaves it); single
    quotes are literal; an unquoted value loses trailing whitespace.
    """
    env = {}
    with open(path, encoding='utf-8') as fh:
        for raw in fh:
            line = raw.rstrip('\n').strip()
            if not line or line[0] in '#;':
                continue
            if line.startswith('export '):
                line = line[len('export '):].lstrip()
            key, sep, value = line.partition('=')
            key = key.strip()
            if not sep or not key.replace('_', 'a').isalnum() or key[0].isdigit():
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] == '"':
                inner = value[1:-1]
                out = []
                i = 0
                while i < len(inner):
                    c = inner[i]
                    if c == '\\' and i + 1 < len(inner) and inner[i + 1] in '\\"$`':
                        out.append(inner[i + 1])
                        i += 2
                        continue
                    out.append(c)
                    i += 1
                value = ''.join(out)
            elif len(value) >= 2 and value[0] == value[-1] == "'":
                value = value[1:-1]
            env[key] = value
    return env


def enabled():
    return os.path.exists(ENABLED_FILE)


def set_enabled(on):
    os.makedirs(STATE_DIR, exist_ok=True)
    if on:
        with open(ENABLED_FILE, 'w') as fh:
            fh.write(time.strftime('%Y-%m-%dT%H:%M:%SZ\n', time.gmtime()))
    elif os.path.exists(ENABLED_FILE):
        os.remove(ENABLED_FILE)


def bind():
    global listener
    if listener is not None:
        return
    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    s.bind(('::', PORT))
    s.listen(4096)
    listener = s
    say(f'socket held on [::]:{PORT}')


def unbind():
    global listener
    if listener is None:
        return
    listener.close()
    listener = None
    say('socket released')


def pump(fd):
    """Copy the backend's output to Fly's log and to the log on the volume."""
    with os.fdopen(fd, 'rb', buffering=0) as pipe:
        while True:
            try:
                chunk = pipe.read(65536)
            except OSError:
                break
            if not chunk:
                break
            try:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            except OSError:
                pass
            write_log(chunk)


def spawn():
    global child
    if child is not None:
        return
    bind()
    try:
        cwd = os.path.realpath(RELEASE)
        file_env = parse_env_file(ENV_FILE)
    except OSError as error:
        say(f'cannot start: {error}')
        return
    env = {k: v for k, v in os.environ.items() if k not in OWN_ENV}
    env.update(file_env)
    env['LISTEN_FDS'] = '1'
    env['LISTEN_FDNAMES'] = 'backend-http'
    env.pop('LISTEN_PID', None)
    rd, wr = os.pipe()
    pid = os.fork()
    if pid == 0:  # the backend
        try:
            os.setsid()
            os.chdir(cwd)
            fd = listener.fileno()
            if fd != 3:
                os.dup2(fd, 3)
            os.set_inheritable(3, True)
            os.dup2(wr, 1)
            os.dup2(wr, 2)
            null = os.open('/dev/null', os.O_RDONLY)
            os.dup2(null, 0)
            os.closerange(4, 65536)
            # LISTEN_PID must be the pid that ends up running Node: the
            # shell's own, kept by exec.
            os.execve('/bin/sh', ['sh', '-c', 'LISTEN_PID=$$; export LISTEN_PID; exec "$0" dist/index.js', NODE], env)
        finally:
            os._exit(127)
    os.close(wr)
    threading.Thread(target=pump, args=(rd,), daemon=True).start()
    child = pid
    say(f'backend started, pid {pid}, release {os.path.basename(cwd)}')


def stop_child():
    global child
    pid = child
    if pid is None:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.time() + STOP_TIMEOUT
    while time.time() < deadline:
        with lock:
            if child != pid:
                return
        time.sleep(0.1)
    say(f'backend pid {pid} ignored SIGTERM for {STOP_TIMEOUT}s, killing it')
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    while True:
        with lock:
            if child != pid:
                return
        time.sleep(0.1)


def reaper():
    """Reap the backend; restart it after RESTART_SEC if it died on its own."""
    global child
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except ChildProcessError:
            time.sleep(0.2)
            continue
        with lock:
            if pid != child:
                continue
            child = None
            code = os.waitstatus_to_exitcode(status)
            say(f'backend pid {pid} exited ({code})')
            if want_running:
                threading.Thread(target=restart_later, args=(pid,), daemon=True).start()


def restart_later(dead_pid):
    time.sleep(RESTART_SEC)
    with lock:
        if want_running and child is None:
            say(f'restarting after pid {dead_pid} failed')
            spawn()


def status():
    return {
        'enabled': enabled(),
        'socket': listener is not None,
        'service': child is not None,
        'pid': child,
        'release': os.path.basename(os.path.realpath(RELEASE)),
    }


def command(cmd):
    global want_running
    if cmd == 'status':
        return status()
    if cmd == 'enable':
        set_enabled(True)
    elif cmd == 'disable':
        set_enabled(False)
    elif cmd == 'start-socket':
        with lock:
            bind()
    elif cmd == 'stop-socket':
        with lock:
            want_running = False
        stop_child()
        with lock:
            unbind()
    elif cmd == 'start':
        with lock:
            want_running = True
            spawn()
    elif cmd == 'stop':
        with lock:
            want_running = False
        stop_child()
    elif cmd == 'restart':
        with lock:
            want_running = False
        stop_child()
        with lock:
            want_running = True
            spawn()
    else:
        return {'error': f'unknown command {cmd}'}
    return status()


def serve_control():
    os.makedirs(os.path.dirname(CONTROL), exist_ok=True)
    if os.path.exists(CONTROL):
        os.remove(CONTROL)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(CONTROL)
    os.chmod(CONTROL, 0o600)
    srv.listen(16)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


def handle(conn):
    with conn:
        try:
            cmd = conn.makefile('r').readline().strip()
            result = command(cmd)
            if cmd != 'status':
                say(f'control: {cmd} -> {json.dumps(result)}')
            conn.sendall((json.dumps(result) + '\n').encode())
        except Exception as error:  # a broken client must not take the holder down
            try:
                conn.sendall((json.dumps({'error': str(error)}) + '\n').encode())
            except OSError:
                pass


def shutdown(signum, _frame):
    global want_running
    say(f'signal {signum}: stopping the backend')
    with lock:
        want_running = False
    stop_child()
    os._exit(0)


def main():
    global want_running
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    threading.Thread(target=reaper, daemon=True).start()
    if enabled():
        with lock:
            want_running = True
            spawn()
    else:
        say('backend is not enabled on this machine: holding nothing, running nothing')
    serve_control()


if __name__ == '__main__':
    main()
