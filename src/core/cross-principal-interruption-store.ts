import { createHash } from 'node:crypto';
import type {
  CrossPrincipalInterruption,
  CrossPrincipalInterruptionMessage,
  Session,
  TrustedCaller,
} from '../types.js';

/** Logical idempotency key for one rejected inbound message. Worker generation
 * and delivery attempt are deliberately excluded: both may change while the
 * same turnId is retried after a crash or IPC race. */
export function crossPrincipalInterruptionId(sourceSessionId: string, turnId: string): string {
  return `xpi_${createHash('sha256').update(`${sourceSessionId}\0${turnId}`).digest('hex').slice(0, 24)}`;
}

/**
 * How many back-to-back bot-proposer interruptions are tolerated before the
 * acknowledgement prompt is suppressed. Two `mentionMode: always` bots can
 * otherwise ping-pong the "请选择独立任务/建议" card forever: each bot's card
 * @-mentions the other, whose auto-reply is itself a fresh cross-principal
 * message, and so on. A human proposer never counts toward this (and resets
 * it), so ordinary human interruptions are never suppressed. Three leaves room
 * for a legitimate handoff card + one bot follow-up before the breaker trips.
 */
export const CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD = 3;

/**
 * Update the consecutive-bot-interruption counter for a newly staged
 * interruption and decide whether the acknowledgement prompt must be
 * suppressed to break a bot↔bot auto-reply loop.
 *
 * - A human proposer resets the counter to 0 and never suppresses.
 * - A bot proposer increments the counter; once it exceeds the threshold the
 *   prompt is suppressed. The interruption itself is still staged durably — we
 *   only stop the outbound @-mention that keeps the other bot replying.
 *
 * Pure and idempotent per call: callers invoke it exactly once per genuinely
 * new staged interruption (i.e. when `inserted` is true), so a retried/merged
 * duplicate does not advance the counter.
 */
export function noteCrossPrincipalProposer(
  session: Session,
  proposerIsBot: boolean,
): { consecutiveBotInterruptions: number; suppressAckPrompt: boolean } {
  if (!proposerIsBot) {
    session.crossPrincipalConsecutiveBotInterruptions = 0;
    return { consecutiveBotInterruptions: 0, suppressAckPrompt: false };
  }
  const next = (session.crossPrincipalConsecutiveBotInterruptions ?? 0) + 1;
  session.crossPrincipalConsecutiveBotInterruptions = next;
  return {
    consecutiveBotInterruptions: next,
    suppressAckPrompt: next > CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD,
  };
}

export function stageCrossPrincipalInterruptionRecord(args: {
  session: Session;
  ownerTurnId: string;
  owner: TrustedCaller;
  proposer: TrustedCaller;
  message: CrossPrincipalInterruptionMessage;
}): { record: CrossPrincipalInterruption; inserted: boolean } {
  const id = crossPrincipalInterruptionId(args.session.sessionId, args.message.turnId);
  const queue = args.session.crossPrincipalInterruptions
    ?? (args.session.crossPrincipalInterruptions = []);
  const existing = queue.find(item => item.id === id);
  if (existing) return { record: existing, inserted: false };

  const record: CrossPrincipalInterruption = {
    version: 1,
    id,
    ownerTurnId: args.ownerTurnId,
    owner: { ...args.owner },
    proposer: { ...args.proposer },
    // Human and bot proposers follow the same explicit classification protocol.
    // No deadline starts here: the proposer cannot act until the card/protocol
    // is confirmed delivered.
    phase: 'awaiting_classification',
    messages: [{ ...args.message }],
  };
  queue.push(record);
  return { record, inserted: true };
}

export function markCrossPrincipalSuggestionWaiting(
  record: CrossPrincipalInterruption,
  now: number,
  waitMs: number,
): void {
  record.phase = 'awaiting_owner';
  record.ownerWaitDeadlineAt = now + waitMs;
  record.waitDecisionRound = record.waitDecisionRound ?? 0;
}

export function crossPrincipalOwnerWaitDisposition(
  record: CrossPrincipalInterruption,
  activeTurn: boolean,
  now: number,
  waitMs: number,
): 'owner_ready' | 'waiting' | 'proposer_decision' {
  if (!activeTurn) return 'owner_ready';
  record.ownerWaitDeadlineAt ??= now + waitMs;
  return now < record.ownerWaitDeadlineAt ? 'waiting' : 'proposer_decision';
}

export function continueCrossPrincipalOwnerWait(
  record: CrossPrincipalInterruption,
  now: number,
  waitMs: number,
): void {
  record.ownerWaitDeadlineAt = now + waitMs;
  record.waitDecisionRound = (record.waitDecisionRound ?? 0) + 1;
}
