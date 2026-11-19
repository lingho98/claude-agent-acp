// Portions derived from claude-agent-tui (src/end-of-turn.ts), https://github.com/zeo-workspace/claude-agent-tui,
// Copyright 2026 lucascouts, Apache-2.0. Modified: `turn_duration` as the authoritative end, Code Mode
// rules, a later write cancels a candidate end instead of confirming it.

/**
 * Decides from the transcript when the interactive CLI's turn is over. The
 * terminal shows no end marker the adapter can rely on, so the rules below
 * come from the records of real CLI 2.1.328 turns:
 *
 * - `system` / `turn_duration` ends the turn at once. The CLI writes it after
 *   the Stop hooks, and only at the end of a turn.
 * - A model's `end_turn` or `max_tokens` with no `tool_use`, or an API error
 *   the CLI reports as a `<synthetic>` text row (`isApiErrorMessage`), ends
 *   the turn once transcript and screen stay quiet for `quiescenceMs`, in
 *   case no `turn_duration` follows. A later user or assistant row cancels it:
 *   e.g. a Stop hook that blocks makes the model go on.
 * - Never an end: `tool_use` stop reasons, and Code Mode's REPL inner calls,
 *   which the CLI writes as `isVirtual` `<synthetic>` `stop_sequence` rows
 *   that hold a `tool_use`. The model's real `end_turn` follows them, in run
 *   4 1.6 s later.
 * - A user row "[Request interrupted by user…" ends the turn after
 *   quiescence: the CLI writes it, and nothing more, when the user answers a
 *   tool permission "No" or interrupts the turn.
 * - Sidechain (subagent) rows never end the parent turn.
 */

import type { TranscriptRecord } from "./transcript.js";

export const QUIESCENCE_MS = 1500;
export const STALL_MS = 120_000;

export type TurnEndReason =
  "turn_duration" | "end_turn" | "max_tokens" | "api_error" | "interrupted";

export type TurnEnd = { reason: TurnEndReason; record: TranscriptRecord };

const SYNTHETIC_MODEL = "<synthetic>";
const INTERRUPTED = "[Request interrupted by user";

/** Whether `record` is the CLI's "[Request interrupted by user…]" row, as a string or a text block. */
function isInterruption(record: TranscriptRecord): boolean {
  const content = record.message?.content;
  if (typeof content === "string") {
    return content.startsWith(INTERRUPTED);
  }
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.startsWith(INTERRUPTED),
    )
  );
}

function hasToolUse(record: TranscriptRecord): boolean {
  const content = record.message?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) => typeof block === "object" && block !== null && block.type === "tool_use",
    )
  );
}

/**
 * Whether `record` ends the turn by itself (`turn_duration`), ends it after
 * quiescence (the other {@link TurnEndReason}s), or neither (`undefined`).
 */
export function turnEndReason(record: TranscriptRecord): TurnEndReason | undefined {
  if (record.isSidechain === true) {
    return undefined;
  }
  if (record.type === "system") {
    return record.subtype === "turn_duration" ? "turn_duration" : undefined;
  }
  if (record.type === "user") {
    return isInterruption(record) ? "interrupted" : undefined;
  }
  if (record.type !== "assistant" || hasToolUse(record)) {
    return undefined;
  }
  if (record.message?.model === SYNTHETIC_MODEL) {
    return record.isApiErrorMessage === true && record.isVirtual !== true ? "api_error" : undefined;
  }
  const stopReason = record.message?.stop_reason;
  return stopReason === "end_turn" || stopReason === "max_tokens" ? stopReason : undefined;
}

/** Calls `onQuiet` once `ms` pass after {@link start} or the last {@link poke}. */
export class QuietTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ms: number,
    private readonly onQuiet: () => void,
  ) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onQuiet();
    }, this.ms);
  }

  /** Restarts a running timer; a stopped one stays stopped. */
  poke(): void {
    if (this.running) {
      this.start();
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export type EndOfTurnDetectorOptions = {
  onEnd: (end: TurnEnd) => void;
  /** No transcript record and no screen output for `stallMs` during a turn. */
  onStall: (error: Error) => void;
  quiescenceMs?: number;
  stallMs?: number;
};

/** Applies the rules above to one turn at a time, from {@link begin} to the first end. */
export class EndOfTurnDetector {
  private active = false;
  /** Set by this turn's first user or assistant row: a `turn_duration` before it belongs to the last turn. */
  private sawTurnRow = false;
  private candidate: TurnEnd | undefined;
  private readonly quiet: QuietTimer;
  private readonly stall: QuietTimer;

  constructor(private readonly options: EndOfTurnDetectorOptions) {
    this.quiet = new QuietTimer(options.quiescenceMs ?? QUIESCENCE_MS, () => {
      if (this.candidate) {
        this.finish(this.candidate);
      }
    });
    const stallMs = options.stallMs ?? STALL_MS;
    this.stall = new QuietTimer(stallMs, () => {
      this.stop();
      options.onStall(
        new Error(
          `The Claude CLI showed no progress for ${stallMs / 1000} s: no transcript record and no terminal output. ` +
            "Cancel the turn and try again.",
        ),
      );
    });
  }

  begin(): void {
    this.active = true;
    this.sawTurnRow = false;
    this.candidate = undefined;
    this.quiet.stop();
    this.stall.start();
  }

  observe(record: TranscriptRecord): void {
    if (!this.active) {
      return;
    }
    this.noteActivity();
    if (record.isSidechain === true) {
      return;
    }
    const isTurnRow = record.type === "user" || record.type === "assistant";
    const sawTurnRow = this.sawTurnRow;
    this.sawTurnRow ||= isTurnRow;
    if (!this.sawTurnRow) {
      return;
    }
    const reason = turnEndReason(record);
    if (reason === "interrupted" && !sawTurnRow) {
      // The last turn's interruption, written after its cancel; this turn starts with the prompt's row.
      return;
    }
    if (reason === "turn_duration") {
      this.finish({ reason, record });
    } else if (reason) {
      this.candidate = { reason, record };
      this.quiet.start();
    } else if (isTurnRow && this.candidate) {
      this.candidate = undefined;
      this.quiet.stop();
    }
  }

  /** While `waiting`, the turn waits on the user's answer to a dialog: no stall. */
  waitOnUser(waiting: boolean): void {
    if (waiting) {
      this.stall.stop();
    } else if (this.active) {
      this.stall.start();
    }
  }

  /** Terminal output: keeps the stall watchdog and the quiescence wait from firing. */
  noteActivity(): void {
    this.stall.poke();
    this.quiet.poke();
  }

  stop(): void {
    this.active = false;
    this.candidate = undefined;
    this.quiet.stop();
    this.stall.stop();
  }

  private finish(end: TurnEnd): void {
    this.stop();
    this.options.onEnd(end);
  }
}
