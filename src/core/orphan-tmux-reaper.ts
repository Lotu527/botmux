/**
 * Reap tmux SERVERS orphaned by a previous daemon generation.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * `reapOrphanWorkers()` (worker-pool.ts) reaps botmux `__worker` processes
 * whose daemon was hard-killed. It does NOT touch the tmux server those
 * workers used — tmux servers survive daemon death by design.
 *
 * Failure mode (measured in production 2026-10-22, botmux 3.48 / tmux 3.6a):
 *   1. daemon dies / is restarted (upgrade, crash, host maintenance). The old
 *      tmux server keeps running with every managed pane in it.
 *   2. the new daemon's tmux traffic fails to reach the old server for any
 *      reason (probe timeout under load, socket path cleaned from /tmp, …)
 *      and a SECOND server is born, rebinding the default socket path. The
 *      old server keeps its unlinked socket and is now unreachable:
 *      `tmux list-sessions` cannot see it, so botmux can never manage or
 *      kill it again.
 *   3. the new daemon cold-resumes the restored sessions. Each managed CLI
 *      (e.g. codex) is a long-lived process inside the OLD server still
 *      holding its per-session file locks. The fresh resume in the NEW server
 *      cannot acquire the lock and parks on the user-visible
 *      "🔒 This conversation is open in another app — Close it there and
 *      press R" screen. Observed: 19/48 sessions blocked at once; the orphan
 *      tree leaked ~13 GB RSS and a few CLIs kept spinning on forked
 *      sub-threads.
 *
 * Because the old server is invisible on the socket, it is identified the
 * same way the incident was diagnosed live:
 *   • tmux list-sessions REACHES a live server — its pid is obtained from
 *     `tmux display-message -p '#{pid}'`;
 *   • a DIFFERENT tmux process still holds a unix socket bound to the
 *     default socket pathname (kernel census: /proc/net/unix on Linux,
 *     lsof -U on macOS) — that is a displaced, unreachable server;
 *   • and it is provably botmux-spawned: the server process's booting argv
 *     carries `new-session -s bmx-…` / `bmx-diag-…` / `bmx-reap-bootstrap-…`
 *     (Linux /proc/<pid>/cmdline and macOS `ps` both keep the first client's
 *     argv for the server's whole lifetime). A server whose booting argv is a
 *     user's own interactive session is never reaped even when botmux panes
 *     later attach to it: on the shared default server its user sessions die
 *     too, so the conservative choice is to leave it.
 *
 * Conservatism, matching reapOrphanWorkers():
 *   • Never reaps while the reachable server itself cannot be identified
 *     (probe timeout / spawn failure / connection-level errors). A busy
 *     server whose accept backlog momentarily overflows answers ECONNREFUSED;
 *     "can't tell" must never escalate into killing a live server, so the
 *     no-reachable-server branch reaps NOTHING.
 *   • Never reaps a process without a botmux fingerprint — a user's own
 *     interactive tmux is left strictly alone.
 *   • Cross-daemon safe: several per-bot daemons share one host/tmux socket;
 *     a racing peer simply gets ESRCH on the kill.
 *   • Default OFF: daemon.ts invokes this only when the machine-wide
 *     experimental Dashboard switch is enabled. BOTMUX_DISABLE_ORPHAN_TMUX_REAP=1
 *     remains as an emergency kill-switch on top of that.
 *   • SIGTERM is followed by a bounded liveness wait so restore cold-resumes
 *     only after tmux's orderly pane teardown (which releases managed CLIs'
 *     file locks); a server still alive at the deadline is left and reported,
 *     never escalated to SIGKILL (the session-scope teardown on the recovery
 *     path handles stragglers independently).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, readlinkSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { ProcSnapshot } from './worker-pool.js';
import { listProcesses } from './worker-pool.js';
import { tmuxEnv } from '../setup/ensure-tmux.js';
import { logger } from '../utils/logger.js';

/** A pid holding a unix socket bound to a pathname. */
export interface SocketBinding {
  pid: number;
  /** Bound socket pathname (server listeners only — client ends have none). */
  path: string;
}

interface ReaperSeam {
  /** Live process table. Defaults to the shared {@link listProcesses}. */
  procs?: ProcSnapshot[];
  /** Pid → bound unix-socket pathnames. Defaults: /proc/net/unix, lsof. */
  socketBindings?: SocketBinding[];
  /**
   * Pid of the tmux server answering on the default socket, or null when no
   * reachable server can be identified (timeout / spawn failure).
   */
  reachableServerPid?: number | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Liveness probe used for the bounded post-SIGTERM wait. Defaults to kill -0. */
  isAlive?: (pid: number) => boolean;
  /** Wait used by the post-SIGTERM bounded wait. Defaults to a synchronous sleep. */
  sleep?: (ms: number) => void;
  /** Second owner-pid probe for the TOCTOU guard. Tests inject it; defaults to a
   *  fresh `tmux display-message` probe. */
  reProbeReachableServerPid?: () => number | null;
  /** First owner-pid probe. Tests inject it; defaults to a live tmux probe. */
  probeReachableServerPid?: () => number | null;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  platform?: NodeJS.Platform;
}

/** argv[0] of a process is the tmux binary. */
function isTmuxBinary(cmd: string): boolean {
  return basename(cmd.split(/\s+/, 1)[0] ?? '') === 'tmux';
}

/**
 * The booting session of every botmux tmux server is named `bmx-<id>` /
 * `bmx-diag-<id>` (TmuxBackend.sessionName / diagnosticSessionName) and the
 * server inherits the first `tmux new-session -s bmx-…` client's argv on both
 * macOS and Linux for its whole lifetime (Linux only renames the thread COMM;
 * /proc cmdline keeps the original argv). The reaper's own one-shot bootstrap
 * session (`ensureServerThenReapOrphanTmuxServers`) is included: it can itself
 * boot a fresh server whose argv stays `bmx-reap-bootstrap-<pid>` forever
 * (later real sessions attach, they do not change the server argv), so
 * without this alternative a server the reaper booted would be unreapable
 * after the next socket displacement.
 */
export function argvCarriesBotmuxSession(cmd: string): boolean {
  // Require the `new-session` subcommand: a bare `-s` also belongs to grep,
  // tmux's own `kill-session -s`, etc., which must not match.
  return /(?:^|\s)new-session\b.*\s-s\s+(?:bmx(?:-diag)?-[0-9a-f]{8}|bmx-reap-bootstrap-\d+)(?:\s|$)/s.test(cmd);
}

export function defaultSocketPath(env: NodeJS.ProcessEnv, uid: number): string {
  const baseDir = env.TMUX_TMPDIR || '/tmp';
  return join(baseDir, `tmux-${uid}`, 'default');
}

/**
 * Linux: map pids to unix socket PATHNAMES they LISTEN on, via
 * /proc/net/unix (inode → pathname) + /proc/<pid>/fd/* (pid → inode).
 * Connected client endpoints have an empty Path column and never appear.
 */
function linuxSocketBindings(): SocketBinding[] {
  const rows = readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1);
  const inodeToPath = new Map<string, string>();
  for (const line of rows) {
    const cols = line.trimStart().split(/\s+/);
    // Num RefCount Protocol Flags Type St Inode Path
    const path = cols[7];
    const inode = cols[6];
    if (path && inode) inodeToPath.set(inode, path);
  }
  const bindings: SocketBinding[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let fds: string[];
    try { fds = readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (!m) continue;
      const path = inodeToPath.get(m[1]);
      if (path) bindings.push({ pid, path });
    }
  }
  return bindings;
}

/**
 * macOS / other Unix: parse one `lsof -U -F pcn` dump. Records are `p<pid>`
 * then per-open-file lines (`f…`, `t…`, `n<name>`). A bound unix server
 * socket renders its absolute pathname; a connected client end renders
 * `->0x…`, which is filtered out.
 */
export function parseLsofSocketBindings(stdout: string): SocketBinding[] {
  const bindings: SocketBinding[] = [];
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid !== null) {
      const path = line.slice(1);
      if (path.startsWith('/')) bindings.push({ pid, path });
    }
  }
  return bindings;
}

function macSocketBindings(): SocketBinding[] {
  // lsof ships at /usr/sbin on macOS and is not present in some minimal Linux
  // images; it is only invoked on darwin here. Bound the call so a wedged
  // lsof can never block daemon startup (fail closed → reap nothing).
  const r = spawnSync('lsof', ['-U', '-F', 'pcn'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0 || !r.stdout) return [];
  return parseLsofSocketBindings(r.stdout);
}

function defaultSocketBindings(platform: NodeJS.Platform): SocketBinding[] {
  try {
    if (platform === 'linux') return linuxSocketBindings();
    if (platform === 'darwin') return macSocketBindings();
  } catch (err) {
    logger.warn(`[tmux-reaper] socket census failed, skipping reap: ${err instanceof Error ? err.message : String(err)}`);
  }
  return [];
}

/**
 * Identify the tmux server currently answering on the default socket.
 *
 * Returns its pid on a clean answer, or null when no reachable server can be
 * AUTHORITATIVELY identified — including a connection-level failure. tmux
 * returns an instant ECONNREFUSED when a healthy server's accept backlog
 * overflows; treating that as "down" would risk killing the live server, so
 * such states deliberately yield null (reap nothing).
 */
function reachableTmuxServerPid(): number | null {
  let out: string;
  try {
    out = execFileSync('tmux', ['display-message', '-p', '#{pid}'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: tmuxEnv(),
      timeout: 3000,
    });
  } catch {
    return null;
  }
  const pid = Number(out.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Daemon-startup gate. The reaper performs automatic process kills, so it runs
 * only for the tmux backend AND the machine-wide experimental Dashboard switch
 * (default OFF). The env kill-switch inside {@link reapOrphanTmuxServers} is a
 * separate, independent layer.
 */
export function orphanTmuxReaperEnabled(backendType: string, featureEnabled: boolean): boolean {
  return backendType === 'tmux' && featureEnabled;
}

/**
 * Ensure a reachable tmux server exists, then reap displaced botmux servers.
 *
 * At daemon startup no reachable server may exist (fresh reboot, or the
 * previous generation's server lost its socket). A bare `tmux start-server`
 * cannot establish one durably: with the default `exit-empty on` the server
 * exits the moment the start-server client disconnects (zero sessions). A
 * disposable BOOTSTRAP session keeps it alive instead:
 *   • healthy existing server (graceful restart, socket intact): the
 *     `new-session` simply attaches to it — reachable pid is that server, no
 *     displaced holder exists, nothing is reaped;
 *   • displaced previous server (socket unlinked): the bootstrap boots a
 *     FRESH server at the default pathname — it becomes the reachable owner
 *     and the old server is now identifiable and reaped.
 *
 * The bootstrap is killed immediately afterwards; the server it pinned either
 * stays up (restored sessions are about to populate it) or exits empty (a
 * later new-session boots another fresh one, after the reap already finished).
 *
 * Returns the number of orphaned servers reaped. Runs synchronously and MUST
 * finish before restore cold-resumes managed CLIs, or those CLIs race the
 * displaced server's file locks and park on "open in another app".
 */
export function ensureServerThenReapOrphanTmuxServers(): number {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return 0;
  // Per-pid unique name: on a shared default socket several per-bot daemons
  // boot concurrently (fleet upgrade) — a fixed name would make all but one
  // get "duplicate session", and sweeping a fixed name could kill a peer's
  // pin mid-reap. A crashed run leaves at most one harmless uniquely-named
  // empty shell, never a collision.
  const bootstrap = `bmx-reap-bootstrap-${process.pid}`;
  let bootstrapped = false;
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', bootstrap, '-x', '80', '-y', '24'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: tmuxEnv(),
      timeout: 5000,
    });
    bootstrapped = true;
  } catch (err) {
    // Can't pin a reachable server (binary wedged, spawn failure, timeout) ⇒
    // identity cannot be established ⇒ skip rather than risk a wrong reap.
    logger.warn(`[tmux-reaper] tmux bootstrap failed, skipping orphan tmux reap: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  let reaped = 0;
  try {
    reaped = reapOrphanTmuxServers();
  } finally {
    if (bootstrapped) {
      try {
        execFileSync('tmux', ['kill-session', '-t', bootstrap], {
          stdio: 'ignore',
          env: tmuxEnv(),
          timeout: 3000,
        });
      } catch { /* server already gone / concurrent cleanup — benign */ }
    }
  }
  return reaped;
}

/**
 * Bounded wait after SIGTERM for tmux's orderly shutdown (pane teardown is what
 * releases managed CLIs' per-session file locks). The signal itself returning
 * proves nothing — the server may still be closing panes when restore starts.
 * A server still alive at the deadline is left running and reported; SIGKILL is
 * deliberately not used because recovery's session-scope teardown handles
 * straggler panes independently.
 */
const SERVER_EXIT_WAIT_TIMEOUT_MS = 3000;
const SERVER_EXIT_WAIT_POLL_MS = 100;

/**
 * Find and terminate botmux-owned tmux servers that no daemon can reach.
 *
 * Returns the number of servers reaped. Runs once at daemon startup (next to
 * {@link import('./worker-pool.js').reapOrphanWorkers}), BEFORE session
 * restore/cold-resume, so the resumed managed CLIs acquire their file locks
 * instead of inheriting the displaced server's. Idempotent and safe for the
 * multi-daemon-per-host layout.
 *
 * Disable with BOTMUX_DISABLE_ORPHAN_TMUX_REAP=1.
 */
export function reapOrphanTmuxServers(opts: ReaperSeam = {}): number {
  const env = opts.env ?? process.env;
  if (env.BOTMUX_DISABLE_ORPHAN_TMUX_REAP === '1') return 0;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'darwin') return 0;
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  if (uid < 0) return 0;

  const liveOwnerPid = opts.reachableServerPid !== undefined
    ? opts.reachableServerPid
    : (opts.probeReachableServerPid ?? reachableTmuxServerPid)();
  // No reachable, positively-identified server ⇒ reap nothing. See the
  // backlog-overflow rationale on reachableTmuxServerPid().
  if (liveOwnerPid === null || liveOwnerPid === undefined) return 0;

  const socketPath = defaultSocketPath(env, uid);
  // macOS /tmp is a symlink to /private/tmp: tmux's bind(2) resolves it, so
  // the kernel census (lsof, /proc/net/unix) reports the REAL path. Canonicalize
  // the parent DIRECTORY (realpath on the socket file itself fails with
  // EOPNOTSUPP on macOS) and compare against both spellings.
  let socketReal: string | null = null;
  try { socketReal = join(realpathSync(dirname(socketPath)), basename(socketPath)); } catch { /* — */ }
  const socketPaths = new Set(socketReal ? [socketPath, socketReal] : [socketPath]);
  const bindings = opts.socketBindings ?? defaultSocketBindings(platform);
  if (bindings.length === 0) return 0;
  const procs = opts.procs ?? listProcesses();
  const procByPid = new Map(procs.map(p => [p.pid, p]));

  // Distinct tmux processes LISTENING on the default socket pathname. The
  // reachable owner is one of them; any other is a displaced orphan.
  const candidatePids = new Set<number>();
  for (const b of bindings) {
    if (!socketPaths.has(b.path)) continue;
    if (b.pid === liveOwnerPid) continue;
    const proc = procByPid.get(b.pid);
    if (proc && isTmuxBinary(proc.cmd)) candidatePids.add(b.pid);
  }
  if (candidatePids.size === 0) return 0;

  // TOCTOU guard: the reachable owner could have died (and a fresh server
  // rebound) between the pid probe and the socket census. If its identity
  // changed, the candidates are no longer trustworthy — leave everything for
  // the next startup rather than risk a wrong kill.
  if (opts.reachableServerPid === undefined || opts.reProbeReachableServerPid !== undefined) {
    const ownerNow = (opts.reProbeReachableServerPid ?? reachableTmuxServerPid)();
    if (ownerNow !== liveOwnerPid) {
      logger.warn(`[tmux-reaper] reachable server changed during reap (${liveOwnerPid} → ${ownerNow}); skipping this pass`);
      return 0;
    }
  }

  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  const isAlive = opts.isAlive ?? ((pid) => {
    try { process.kill(pid, 0); return true; }
    catch (err) {
      // EPERM means alive but not ours to signal — treat as alive (do not reap).
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  });
  const sleep = opts.sleep ?? ((ms: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  });
  let reaped = 0;
  for (const pid of candidatePids) {
    const proc = procByPid.get(pid)!;

    // Botmux fingerprint: the server's booting argv. A user-booted server that
    // later hosts attached bmx panes is deliberately NOT fingerprinted —
    // killing it on the shared default socket would kill the user's sessions
    // too. Without the fingerprint a displaced tmux is left strictly alone.
    if (!argvCarriesBotmuxSession(proc.cmd)) continue;

    let signaled: 'term' | 'esrch' | 'error' = 'term';
    try {
      // SIGTERM, not SIGKILL: tmux performs an orderly shutdown and closes
      // its panes itself, which releases the managed CLIs' per-session file
      // locks — cold-resumed sessions then recover immediately instead of
      // inheriting a stale lock. Measured: the incident server (743
      // descendants) exited within seconds of SIGTERM.
      kill(pid, 'SIGTERM');
    } catch (err) {
      // ESRCH: it exited on its own / a peer daemon won the race — fine.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        signaled = 'esrch';
      } else {
        signaled = 'error';
        logger.warn(`[tmux-reaper] failed to signal orphaned tmux server pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (signaled === 'error') continue;
    if (signaled === 'esrch') {
      reaped += 1;
      continue;
    }

    // Bounded wait for the orderly teardown before restore cold-resumes managed
    // CLIs (a pane ignoring SIGHUP can survive its server, in which case the
    // lock is not released here; recovery's session-scope teardown is the
    // independent backstop).
    let alive = isAlive(pid);
    let waited = 0;
    while (alive && waited < SERVER_EXIT_WAIT_TIMEOUT_MS) {
      sleep(SERVER_EXIT_WAIT_POLL_MS);
      waited += SERVER_EXIT_WAIT_POLL_MS;
      alive = isAlive(pid);
    }
    if (alive) {
      logger.warn(`[tmux-reaper] orphaned tmux server pid=${pid} still alive ${SERVER_EXIT_WAIT_TIMEOUT_MS}ms after SIGTERM; leaving it for this pass (restore may contend on its CLI locks; session-scope teardown is the backstop)`);
      continue;
    }
    reaped += 1;
    logger.warn(`[tmux-reaper] reaped orphaned tmux server pid=${pid}: unreachable on ${socketPath} but still hosting botmux sessions (previous daemon generation gone)`);
  }
  if (reaped > 0) {
    logger.warn(`[tmux-reaper] reaped ${reaped} orphaned tmux server(s) from a previous daemon generation; managed CLI file locks released before session restore.`);
  }
  return reaped;
}
