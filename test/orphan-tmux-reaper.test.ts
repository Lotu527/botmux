import { describe, it, expect } from 'vitest';
import {
  reapOrphanTmuxServers,
  orphanTmuxReaperEnabled,
  parseLsofSocketBindings,
  argvCarriesBotmuxSession,
  defaultSocketPath,
  type SocketBinding,
} from '../src/core/orphan-tmux-reaper.js';
import type { ProcSnapshot } from '../src/core/worker-pool.js';

// Must honour process.env: the unit project's tmux fence (test/helpers/tmux-fence.ts)
// redirects TMUX_TMPDIR to a private root; a hard-coded {} here computes the host's
// /tmp socket, matches no fixture binding, and silently turns every reap test red
// (or green-for-the-wrong-reason outside the fence).
const SOCK = defaultSocketPath(process.env, process.getuid());

const tmuxServer = (pid: number, ppid = 1, extra = ''): ProcSnapshot => ({
  pid,
  ppid,
  cmd: `tmux new-session -d -P -F #{pid} #{session_id} -s bmx-deadbeef -x 160 -y 50${extra} -- /bin/zsh`,
});

/** Default seam tail: the signal "succeeds" and the server is instantly gone,
 *  so tests never poll real pids or pay the 3 s bounded wait. */
const DEAD_ON_SIGNAL = { isAlive: () => false, sleep: () => {} } as const;

describe('reapOrphanTmuxServers', () => {
  it('reaps a botmux tmux server displaced from the default socket', () => {
    const killed: number[] = [];
    const procs = [
      tmuxServer(100),                       // reachable, owns the socket — spared
      tmuxServer(200),                       // displaced orphan — reaped
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
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(1);
    expect(killed).toEqual([200]);
  });

  it('reaps a displaced server booted by the reaper bootstrap (bmx-reap-bootstrap-<pid>)', () => {
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      tmuxServer(100),
      // The reaper's own bootstrap booted this generation; a later real bmx
      // session attached but the server argv stays the bootstrap's forever.
      { pid: 200, ppid: 1, cmd: 'tmux new-session -d -s bmx-reap-bootstrap-4321 -x 80 -y 24' },
    ];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
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
      ...DEAD_ON_SIGNAL,
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
      ...DEAD_ON_SIGNAL,
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
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
  });

  it('spares a non-tmux process even when its argv text contains new-session -s bmx-*', () => {
    // argvCarriesBotmuxSession deliberately does not require argv[0]=tmux; the
    // isTmuxBinary gate upstream is what separates a real server from, e.g., a
    // node worker whose command line merely mentions the same tokens.
    const killed: number[] = [];
    const procs: ProcSnapshot[] = [
      tmuxServer(100),
      { pid: 200, ppid: 1, cmd: 'node /opt/botmux/worker.js -- new-session -s bmx-12345678' },
    ];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(killed).toEqual([]);
  });

  it('ignores bindings on other socket paths', () => {
    const killed: number[] = [];
    const procs = [
      tmuxServer(100),
      { pid: 200, ppid: 1, cmd: 'tmux new-session -s bmx-11111111' },
    ];
    const bindings: SocketBinding[] = [
      { pid: 100, path: SOCK },
      { pid: 200, path: `${SOCK}.probe-tmp` },   // a -L probe socket, not default
    ];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
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
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(killed).toBe(false);
  });

  it('counts an ESRCH on the signal as reaped (it exited on its own)', () => {
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: () => { throw Object.assign(new Error('No such process'), { code: 'ESRCH' }); },
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(1);
  });

  it('does not count a server still alive after the bounded post-SIGTERM wait', () => {
    const killed: number[] = [];
    const polls: number[] = [];
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      kill: (p) => killed.push(p),
      isAlive: () => true,   // ignores SIGHUP / stuck in teardown
      sleep: (ms) => { polls.push(ms); },
    });
    expect(n).toBe(0);
    expect(killed).toEqual([200]);
    expect(polls.length).toBeGreaterThan(0);
  });

  it('skips the pass when the reachable owner changes between the two probes (TOCTOU)', () => {
    const killed: number[] = [];
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    const n = reapOrphanTmuxServers({
      procs,
      socketBindings: bindings,
      reachableServerPid: 100,
      reProbeReachableServerPid: () => 999,
      kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    });
    expect(n).toBe(0);
    expect(killed).toEqual([]);
  });

  it('is a no-op off linux/darwin and without getuid', () => {
    const procs = [tmuxServer(100), tmuxServer(200)];
    const bindings: SocketBinding[] = [{ pid: 100, path: SOCK }, { pid: 200, path: SOCK }];
    expect(reapOrphanTmuxServers({
      procs, socketBindings: bindings, reachableServerPid: 100,
      platform: 'win32', uid: 1, kill: () => { throw new Error('must not kill'); },
      ...DEAD_ON_SIGNAL,
    })).toBe(0);
    // Recording (not throwing) kill so the uid guard is what must produce 0 —
    // a swallowed signal error would also return 0 and hide a removed guard.
    const killed: number[] = [];
    expect(reapOrphanTmuxServers({
      procs, socketBindings: bindings, reachableServerPid: 100,
      platform: 'darwin', uid: -1, kill: (p) => killed.push(p),
      ...DEAD_ON_SIGNAL,
    })).toBe(0);
    expect(killed).toEqual([]);
  });
});

describe('orphan tmux reaper helpers', () => {
  it('orphanTmuxReaperEnabled requires BOTH the tmux backend and the default-off switch', () => {
    expect(orphanTmuxReaperEnabled('tmux', true)).toBe(true);
    expect(orphanTmuxReaperEnabled('tmux', false)).toBe(false); // default OFF — the whole point
    expect(orphanTmuxReaperEnabled('pty', true)).toBe(false);
    expect(orphanTmuxReaperEnabled('herdr', true)).toBe(false);
  });

  it('argvCarriesBotmuxSession matches botmux session names only', () => {
    expect(argvCarriesBotmuxSession('tmux new-session -d -s bmx-1a2b3c4d -x 160')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -s bmx-diag-1a2b3c4d')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -d -s bmx-reap-bootstrap-4321')).toBe(true);
    expect(argvCarriesBotmuxSession('tmux new-session -s work')).toBe(false);
    expect(argvCarriesBotmuxSession('tmux new-session -s bmx-short')).toBe(false);
    expect(argvCarriesBotmuxSession('grep -s bmx-1a2b3c4d')).toBe(false); // no new-session
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

  it('defaultSocketPath honours TMUX_TMPDIR and uid', () => {
    expect(defaultSocketPath({}, 501)).toBe('/tmp/tmux-501/default');
    expect(defaultSocketPath({ TMUX_TMPDIR: '/var/tmp' }, 42)).toBe('/var/tmp/tmux-42/default');
  });
});
