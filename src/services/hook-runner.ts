import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export const HOOK_EVENTS = [
  'topic.new',
  'thread.reply',
  'outbound.send',
  'outbound.reply',
  'schedule.fired',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

export type HookFilter = {
  chatId?: string | string[];
  senderOpenId?: string | string[];
  sender_open_id?: string | string[];
};

export type HookConfig = {
  event: HookEvent;
  command: string;
  timeoutMs?: number;
  filter?: HookFilter;
};

export type HookPayload = Record<string, unknown> & {
  event: HookEvent;
  chatId?: string;
  senderOpenId?: string;
  sender_open_id?: string;
};

export type ParsedHookCommand = {
  file: string;
  args: string[];
};

export type HookRunResult = {
  ok: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  error?: string;
};

const DEFAULT_TIMEOUT_MS = 5_000;

function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function normalizeHookConfig(raw: unknown): HookConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (!isHookEvent(rec.event)) return null;
  if (typeof rec.command !== 'string' || rec.command.trim().length === 0) return null;

  const hook: HookConfig = {
    event: rec.event,
    command: rec.command,
  };
  if (typeof rec.timeoutMs === 'number' && Number.isFinite(rec.timeoutMs)) {
    hook.timeoutMs = rec.timeoutMs;
  }
  if (rec.filter && typeof rec.filter === 'object') {
    const filterRec = rec.filter as Record<string, unknown>;
    const filter: HookFilter = {};
    const chatId = normalizeStringList(filterRec.chatId);
    const senderOpenId = normalizeStringList(filterRec.senderOpenId ?? filterRec.sender_open_id);
    if (chatId) filter.chatId = chatId;
    if (senderOpenId) filter.senderOpenId = senderOpenId;
    if (filter.chatId || filter.senderOpenId) hook.filter = filter;
  }
  return hook;
}

function readJsonHookArray(raw: string): HookConfig[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeHookConfig).filter((h): h is HookConfig => !!h);
}

export function loadHookConfigs(opts: {
  dataDir?: string;
  env?: Pick<NodeJS.ProcessEnv, 'BOTMUX_HOOKS_JSON' | 'BOTMUX_HOOKS_FILE'>;
} = {}): HookConfig[] {
  const env = opts.env ?? process.env;
  try {
    if (env.BOTMUX_HOOKS_JSON) {
      return readJsonHookArray(env.BOTMUX_HOOKS_JSON);
    }

    const hooksPath = env.BOTMUX_HOOKS_FILE || join(opts.dataDir ?? config.session.dataDir, 'hooks.json');
    if (!existsSync(hooksPath)) return [];
    return readJsonHookArray(readFileSync(hooksPath, 'utf-8'));
  } catch (err: any) {
    logger.warn(`[hooks] Failed to load hook config: ${err?.message ?? String(err)}`);
    return [];
  }
}

export function parseHookCommand(command: string): ParsedHookCommand {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of command.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (quote) throw new Error('Unterminated quote in hook command');
  if (current) tokens.push(current);
  if (tokens.length === 0) throw new Error('Empty hook command');
  const [file, ...args] = tokens;
  return { file, args };
}

function valueMatchesFilter(allowed: string | string[] | undefined, actual: string | undefined): boolean {
  if (!allowed) return true;
  if (!actual) return false;
  const list = Array.isArray(allowed) ? allowed : [allowed];
  return list.includes(actual);
}

export function filterMatches(filter: HookFilter | undefined, payload: HookPayload): boolean {
  if (!filter) return true;
  const senderOpenId = payload.senderOpenId ?? payload.sender_open_id;
  return valueMatchesFilter(filter.chatId, payload.chatId)
    && valueMatchesFilter(filter.senderOpenId ?? filter.sender_open_id, senderOpenId);
}

function timeoutFor(hook: HookConfig): number {
  if (typeof hook.timeoutMs === 'number' && hook.timeoutMs >= 0) return hook.timeoutMs;
  return DEFAULT_TIMEOUT_MS;
}

async function runHookCommand(hook: HookConfig, payload: HookPayload): Promise<HookRunResult> {
  let parsed: ParsedHookCommand;
  try {
    parsed = parseHookCommand(hook.command);
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }

  return new Promise<HookRunResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let stderr = '';
    const child = spawn(parsed.file, parsed.args, {
      shell: false,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        BOTMUX_HOOK_EVENT: payload.event,
      },
    });

    const settle = (result: HookRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 250).unref();
      } catch { /* process may already be gone */ }
    }, timeoutFor(hook));
    timer.unref();

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 2_000) stderr = stderr.slice(-2_000);
    });

    child.on('error', (err) => {
      settle({ ok: false, timedOut, error: err.message });
    });

    child.on('close', (code, signal) => {
      settle({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        error: code === 0 && !timedOut ? undefined : (stderr.trim() || `hook exited code=${code} signal=${signal ?? 'none'}`),
      });
    });

    child.stdin?.end(JSON.stringify(payload));
  });
}

export function emitHookEvent(event: HookEvent, body: Record<string, unknown> = {}): void {
  try {
    const payload: HookPayload = {
      ...body,
      event,
      emittedAt: new Date().toISOString(),
    };
    const hooks = loadHookConfigs().filter(hook => hook.event === event && filterMatches(hook.filter, payload));
    if (hooks.length === 0) return;

    for (const hook of hooks) {
      void runHookCommand(hook, payload).then(result => {
        if (!result.ok) {
          logger.warn(`[hooks] ${event} hook failed: ${result.error ?? `code=${result.code} signal=${result.signal ?? 'none'}`}`);
        } else {
          logger.debug(`[hooks] ${event} hook completed`);
        }
      }).catch((err: any) => {
        logger.warn(`[hooks] ${event} hook crashed: ${err?.message ?? String(err)}`);
      });
    }
  } catch (err: any) {
    logger.warn(`[hooks] Failed to emit ${event}: ${err?.message ?? String(err)}`);
  }
}

export function runHookCommandForTest(hook: HookConfig, payload: HookPayload): Promise<HookRunResult> {
  return runHookCommand(hook, payload);
}
