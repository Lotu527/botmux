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
 *   • and it is provably botmux-spawned (booting argv carries
 *     `-s bmx-…` / `-s bmx-diag-…`, or a descendant pane carries
 *     `BOTMUX_MANAGED_SHELL=1`).
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
 * macOS and Linux (Linux only renames the thread COMM; /proc cmdline keeps the
 * original argv).
 */
export function argvCarriesBotmuxSession(cmd: string): boolean {
  // Require the `new-session` subcommand: a bare `-s` also belongs to grep,
  // tmux's own `kill-session -s`, etc., which must not match.
  return /(?:^|\s)new-session\b.*\s-s\s+bmx(?:-diag)?-[0-9a-f]{8}(?:\s|$)/s.test(cmd);
}

/**
 * Botmux spawns every managed pane with `BOTMUX_MANAGED_SHELL=1` in the pane
 * command (see TmuxPipeBackend.createDetachedSession's wrapper argv). A user's
 * own interactive tmux never carries it.
 */
const MANAGED_SHELL_MARKER = 'BOTMUX_MANAGED_SHELL=1';

export function defaultSocketPath(env: NodeJS.ProcessEnv, uid: number): string {
  const baseDir = env.TMUX_TMPDIR || '/tmp';
  return join(baseDir, `tmux-${uid}`, 'default');
}

/** Set of every pid in `pid`'s descendant tree (not including pid itself). */
export function descendantSet(pid: number, procs: ProcSnapshot[]): Set<number> {
  const byParent = new Map<number, number[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid);
    if (list) list.push(p.pid);
    else byParent.set(p.ppid, [p.pid]);
  }
  const out = new Set<number>();
  const stack = [...(byParent.get(pid) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    stack.push(...(byParent.get(cur) ?? []));
  }
  return out;
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
    : reachableTmuxServerPid();
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
  if (opts.reachableServerPid === undefined) {
    const ownerNow = reachableTmuxServerPid();
    if (ownerNow !== liveOwnerPid) {
      logger.warn(`[tmux-reaper] reachable server changed during reap (${liveOwnerPid} → ${ownerNow}); skipping this pass`);
      return 0;
    }
  }

  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  let reaped = 0;
  for (const pid of candidatePids) {
    const proc = procByPid.get(pid)!;

    // Botmux fingerprint: the booting argv OR a managed pane descendant.
    // Without one, a user's own displaced tmux is left strictly alone.
    const managedDescendant = [...descendantSet(pid, procs)].some(d =>
      procByPid.get(d)?.cmd.includes(MANAGED_SHELL_MARKER),
    );
    if (!argvCarriesBotmuxSession(proc.cmd) && !managedDescendant) continue;

    try {
      // SIGTERM, not SIGKILL: tmux performs an orderly shutdown and closes
      // its panes itself, which releases the managed CLIs' per-session file
      // locks — cold-resumed sessions then recover immediately instead of
      // inheriting a stale lock. Measured: the incident server (743
      // descendants) exited within seconds of SIGTERM.
      kill(pid, 'SIGTERM');
      reaped += 1;
      logger.warn(`[tmux-reaper] reaped orphaned tmux server pid=${pid}: unreachable on ${socketPath} but still hosting botmux sessions (previous daemon generation gone)`);
    } catch (err) {
      // ESRCH: it exited on its own / a peer daemon won the race — fine.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ESRCH') {
        logger.warn(`[tmux-reaper] failed to signal orphaned tmux server pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (reaped > 0) {
    logger.warn(`[tmux-reaper] reaped ${reaped} orphaned tmux server(s) from a previous daemon generation; managed CLI file locks released before session restore.`);
  }
  return reaped;
}
