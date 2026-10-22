import { describe, it, expect } from 'vitest';
import {
  reapOrphanTmuxServers,
  parseLsofSocketBindings,
  argvCarriesBotmuxSession,
  defaultSocketPath,
  descendantSet,
  type SocketBinding,
} from '../src/core/orphan-tmux-reaper.js';
import type { ProcSnapshot } from '../src/core/worker-pool.js';

const SOCK = defaultSocketPath({}, process.getuid());

const tmuxServer = (pid: number, ppid = 1, extra = ''): ProcSnapshot => ({
  pid,
  ppid,
  cmd: `tmux new-session -d -P -F #{pid} #{session_id} -s bmx-deadbeef -x 160 -y 50${extra} -- /bin/zsh`,
});

describe('reapOrphanTmuxServers', () => {
  it('reaps a botmux tmux server displaced from the default socket', () => {
    const killed: number[] = [];
    const procs = [
      tmuxServer(100),                       // reachable, owns the socket — spared
      tmuxServer(200),                       // displaced orphan — reaped
      { pid: 201, ppid: 200, cmd: 'zsh -l BOTMUX_MANAGED_SHELL=1' },
    ];
    const bindings: SocketBinding[] = [
      { pid: 100, path: SOCK },
      { pid: 200, path: SOCK },
    ];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (pid) => killed.push(pid),
    });
    expect(n).toBe(1);
    expect(killed).toEqual([200]);
  });

  it('reaps when the fingerprint is only a managed-sheet descendant', () => {
    const killed: number[] = [];
    // An argv without -s (e.g. a server shown as "tmux: server" would never
    // appear here, but cover the descendant-marker branch explicitly).
    const procs: ProcSnapshot[] = [
      { pid: 100, ppid: 1, cmd: 'tmux' },
      { pid: 200, ppid: 1, cmd: 'tmux' },
      { pid: 201, ppid: 200, cmd: '/bin/zsh DISABLE_AUTO_UPDATE=true BOTMUX_MANAGED_SHELL=1 -l' },
    ];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
    });
    expect(n).toBe(1);
    expect(killed).toEqual([200]);
  });

  it('never reaps when no reachable server can be identified (busy/unknown = keep)', () => {
    const killed: number[] = [];
    const procs = [tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: null,
      kill: (p) => killed.push(p),
    });
    expect(n).toBe(0);
    expect(killed).toEqual([]);
  });

  it('reaps nothing on a healthy single server (it IS the reachable owner)', () => {
    const killed: number[] = [];
    const procs = [tmuxServer(100)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
    });
    expect(n).toBe(0);
  });

  it('spares a displaced server that is NOT botmux-owned (user interactive tmux)', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      tmuxServer(100),
      { pid: 200, ppid: 1, cmd: 'tmux new-session -d -s work -x 160 -y 50 -- /bin/zsh' },
      { pid: 201, ppid: 200, cmd: '/bin/zsh -l' },
    ];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
    });
    expect(n).toBe(0);
  });

  it('ignores bindings on other socket paths and non-tmux processes', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      tmuxServer(100),
      { pid: 200, ppid: 1, cmd: 'tmux new-session -s bmx-11111111' },
      { pid: 300, ppid: 1, cmd: 'node /opt/app/server.js' },
    ];
    const bindings: SocketBinding[] = [
      { pid: 100, path: SOCK },
      { pid: 200, path: `${SOCK}.probe-tmp` },   // a -L probe socket, not default
      { pid: 300, path: SOCK },                  // node holding something on the path
    ];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
    });
    expect(n).toBe(0);
  });

  it('honours BOTMUX_DISABLE_ORPHAN_TMUX_REAP=1', () => {
    let killed = false;
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      env: { BOTMUX_DISABLE_ORPHAN_TMUX_REAP: '1' },
      kill: () => { killed = true; },
    });
    expect(n).toBe(0);
    expect(killed).toBe(false);
  });

  it('does not count a kill that throws ESRCH (lost the race)', () => {
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); },
    });
    expect(n).toBe(0);
  });

  it('is a no-op off linux/darwin and without getuid', () => {
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    expect(reapOrphanTmuxServers({
      procs, socketBindings: bindings, reachableServerPid: 100,
      platform: 'win32', uid: 1, kill: () => { throw new Error('must not kill'); },
    })).toBe(0);
    expect(reapOrphanTmuxServers({
      procs, socketBindings: bindings, reachableServerPid: 100,
      platform: 'darwin', uid: -1, kill: () => { throw new Error('must not kill'); },
    })).toBe(0);
  });
});

describe('orphan tmux reaper helpers', () => {
  it('argvCarriesBotmuxSession matches botmux session names only', () => {
    expect(argvCarriesBotmuxSession('tmux new-session -d -s bmx-1a2b3c4d -x 160')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -s bmx-diag-1a2b3c4d')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -s work')).toBe(false);
    expect(argvCarriesBotmuxSession('tmux new-session -s bmx-short')).toBe(false);
    expect(argvCarriesBotmuxSession('grep -s bmx-1a2b3c4d')).toBe(false); // no -s flag
  });

  it('parseLsofSocketBindings extracts pathname-bound sockets per pid', () => {
    const dump = [
      'p100', 'ctmux',
      'f6', 'tunix', 'n/private/tmp/tmux-501/default',
      'f9', 'tunix', 'n->0x1234',                                   // client end
      'p200', 'ctmux',
      'f3', 'tunix', 'n/private/tmp/tmux-501/default',
    ].join('\n');
    expect(parseLsofSocketBindings(dump)).toEqual([
      { pid: 100, path: '/private/tmp/tmux-501/default' },
      { pid: 200, path: '/private/tmp/tmux-501/default' },
    ]);
  });

  it('descendantSet walks the full child tree', () => {
    const procs: ProcSnapshot[] = [
      { pid: 1, ppid: 0, cmd: 'init' },
      { pid: 10, ppid: 1, cmd: 'tmux' },
      { pid: 20, ppid: 10, cmd: 'zsh' },
      { pid: 30, ppid: 20, cmd: 'codex' },
      { pid: 40, ppid: 1, cmd: 'other' },
    ];
    expect([...descendantSet(10, procs)].sort((a, b) => a - b)).toEqual([20, 30]);
  });

  it('defaultSocketPath honours TMUX_TMPDIR and uid', () => {
    expect(defaultSocketPath({}, 501)).toBe('/tmp/tmux-501/default');
    expect(defaultSocketPath({ TMUX_TMPDIR: '/var/tmp' }, 42)).toBe('/var/tmp/tmux-42/default');
  });
});
