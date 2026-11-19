/**
 * Runs one session in the interactive CLI: spawns it at the first prompt,
 * answers its Code Mode dialog, sends prompts, and streams each turn's
 * transcript records until the turn ends. Knows nothing of ACP.
 *
 * The trust dialog is never answered: the prompt fails and names the folder.
 * ponytail: no trust handling until the permission gate (chunk 3) can ask the user.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { detectDialog, LINE_BREAK, showsInputBox, type DialogKind } from "./dialogs.js";
import { EndOfTurnDetector, QuietTimer, type TurnEndReason } from "./end-of-turn.js";
import { ClaudePty, type ClaudePtyOptions } from "./pty.js";
import { TranscriptTail, type TranscriptRecord } from "./transcript.js";

/** Output quiet this long with the input box and no dialog on screen means the CLI takes input. */
const READY_QUIET_MS = 1000;
const START_TIMEOUT_MS = 60_000;
const UNKNOWN_DIALOG_MS = 30_000;
/** How long a cancelled turn may keep the session busy when the CLI writes no end. */
const CANCEL_DRAIN_MS = 2000;
/** Answers to startup dialogs before the engine stops answering: the keys are not taking. */
const MAX_DIALOG_ANSWERS = 4;
/** Screen lines an error quotes. */
const ERROR_SCREEN_LINES = 25;

export type TuiEngineOptions = Omit<ClaudePtyOptions, "sessionId"> & {
  /** Default: a new UUID, or `resume` when set. */
  sessionId?: string;
  quiescenceMs?: number;
  stallMs?: number;
  /** Screen and transcript unchanged this long during a turn: `unknown-dialog`, and the turn fails. */
  unknownDialogMs?: number;
  /** The `projects` directory to find the transcript in. Default: `projectsRoot()`. */
  projectsRoot?: string;
};

export type TuiEngineEvents = {
  /** A startup dialog the engine answered "Yes". */
  dialog: [kind: DialogKind];
  /** The CLI waits on a screen the engine can't answer; `screen` is its recent output. */
  "unknown-dialog": [screen: string];
  exit: [exitCode: number];
};

export type TurnResult = { stopReason: TurnEndReason | "cancelled"; record?: TranscriptRecord };

export type TuiTurn = {
  /** The turn's transcript records, in order; ends when the turn does and throws its error. */
  records: AsyncIterable<TranscriptRecord>;
  done: Promise<TurnResult>;
};

type Turn = {
  queue: TranscriptRecord[];
  wake: (() => void) | undefined;
  closed: boolean;
  cancelled: boolean;
  error: Error | undefined;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  done: Promise<TurnResult>;
  /** Resolves once the turn no longer holds the session. */
  cleared: Promise<void>;
  clear: () => void;
};

export class TuiEngine extends EventEmitter<TuiEngineEvents> {
  readonly sessionId: string;
  private pty: ClaudePty | undefined;
  private starting: Promise<void> | undefined;
  private turn: Turn | undefined;
  /** A prompt sent while a cancelled turn settles; it runs once that turn clears. */
  private queued: Turn | undefined;
  private readonly tail: TranscriptTail;
  private readonly detector: EndOfTurnDetector;
  private readonly unknownDialog: QuietTimer;
  private disposed = false;

  constructor(private readonly options: TuiEngineOptions) {
    super();
    this.sessionId = options.sessionId ?? options.resume ?? randomUUID();
    this.tail = new TranscriptTail({
      sessionId: this.sessionId,
      fromEnd: options.resume !== undefined,
      root: options.projectsRoot,
      onRecord: (record) => this.onRecord(record),
      onError: (error) =>
        this.endTurn(
          new Error(`Could not read the session transcript: ${error.message}`, { cause: error }),
        ),
    });
    this.detector = new EndOfTurnDetector({
      quiescenceMs: options.quiescenceMs,
      stallMs: options.stallMs,
      onEnd: ({ reason, record }) => this.endTurn({ stopReason: reason, record }),
      onStall: (error) => this.endTurn(error),
    });
    this.unknownDialog = new QuietTimer(options.unknownDialogMs ?? UNKNOWN_DIALOG_MS, () => {
      const screen = this.pty?.screen() ?? "";
      this.emit("unknown-dialog", screen);
      this.interrupt(
        withScreen("The Claude CLI waits on a screen the adapter can't answer.", screen),
      );
    });
  }

  /** Whether the CLI was stopped or exited; the engine takes no more prompts. */
  get stopped(): boolean {
    return this.disposed;
  }

  /** Spawns the CLI and waits until it takes input. {@link prompt} calls it. */
  start(): Promise<void> {
    this.starting ??= this.spawn().catch((error) => {
      this.endTurn(error);
      this.dispose();
      throw error;
    });
    return this.starting;
  }

  /**
   * Sends `text` as the next turn. Throws while a turn runs. While a
   * cancelled turn settles, the prompt waits for it, then runs.
   */
  prompt(text: string): TuiTurn {
    if ((this.turn && !this.turn.cancelled) || this.queued) {
      throw new Error("A turn is already running in this session. Try again when the turn ends.");
    }
    if (this.disposed) {
      throw new Error("The session's Claude CLI was stopped. Start a new session.");
    }
    const turn = newTurn();
    const settling = this.turn;
    if (settling) {
      this.queued = turn;
      void settling.cleared.then(() => {
        if (this.queued === turn) {
          this.queued = undefined;
          this.run(turn, text);
        }
      });
    } else {
      this.run(turn, text);
    }
    return { records: drain(turn), done: turn.done };
  }

  /**
   * Resolves the running turn, or the one waiting on a cancelled turn, as
   * cancelled and interrupts the CLI. The session stays busy until the CLI
   * ends the turn, at most {@link CANCEL_DRAIN_MS}.
   */
  cancel(): void {
    const queued = this.queued;
    if (queued) {
      this.queued = undefined;
      queued.cancelled = true;
      settle(queued, { stopReason: "cancelled" });
    }
    this.interrupt({ stopReason: "cancelled" });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancel();
    this.detector.stop();
    this.unknownDialog.stop();
    this.tail.stop();
    this.pty?.dispose();
  }

  private run(turn: Turn, text: string): void {
    this.turn = turn;
    if (this.disposed) {
      this.endTurn(new Error("The session's Claude CLI was stopped. Start a new session."));
      return;
    }
    this.start().then(
      () => {
        if (this.pty && this.turn === turn && !turn.cancelled) {
          this.detector.begin();
          this.unknownDialog.start();
          this.pty.sendPrompt(text);
        }
      },
      (error) => this.endTurn(error),
    );
  }

  /** Ends the running turn with `outcome` now and interrupts the CLI, as {@link cancel} says. */
  private interrupt(outcome: TurnResult | Error): void {
    const turn = this.turn;
    if (!turn || turn.cancelled) {
      return;
    }
    turn.cancelled = true;
    settle(turn, outcome);
    this.unknownDialog.stop();
    this.pty?.interrupt(() => this.turn === turn);
    setTimeout(() => {
      if (this.turn === turn) {
        this.detector.stop();
        this.clearTurn(turn);
      }
    }, CANCEL_DRAIN_MS);
  }

  private clearTurn(turn: Turn): void {
    if (this.turn === turn) {
      this.turn = undefined;
      turn.clear();
    }
  }

  private async spawn(): Promise<void> {
    const pty = await ClaudePty.spawn({ ...this.options, sessionId: this.sessionId });
    this.pty = pty;
    if (this.disposed) {
      pty.dispose();
      throw new Error("The session was disposed while its Claude CLI started.");
    }
    pty.onData(() => {
      this.detector.noteActivity();
      this.unknownDialog.poke();
    });
    pty.onExit((exitCode) => {
      this.disposed = true;
      this.tail.stop();
      this.detector.stop();
      this.unknownDialog.stop();
      this.endTurn(new Error(`The Claude CLI exited with code ${exitCode}. Start a new session.`));
      this.emit("exit", exitCode);
    });
    this.tail.start();
    await this.answerStartupDialogs(pty);
  }

  /**
   * Resolves once output stays quiet with the input box and no dialog on
   * screen, answering the Code Mode dialog. Quiet with neither waits for more
   * output, up to {@link START_TIMEOUT_MS}.
   */
  private answerStartupDialogs(pty: ClaudePty): Promise<void> {
    return new Promise((resolve, reject) => {
      let mark = 0;
      let answers = 0;
      let answered: DialogKind | undefined;
      const finish = (error?: Error) => {
        quiet.stop();
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const quiet = new QuietTimer(READY_QUIET_MS, () => {
        // No output after an answer: the keys did not take, and the prompt's Enter would pick "No".
        if (answered && pty.mark() === mark) {
          this.emit("unknown-dialog", pty.screen());
          finish(
            new Error(`The Claude CLI showed nothing after the "${answered}" dialog was answered.`),
          );
          return;
        }
        const screen = pty.screenSince(mark);
        const dialog = detectDialog(screen);
        if (!dialog && showsInputBox(screen)) {
          finish();
        } else if (!dialog) {
          // Not drawn yet: the next output restarts this wait, START_TIMEOUT_MS ends it.
        } else if (dialog.kind === "trust") {
          finish(
            new Error(
              `Claude Code does not trust the folder ${this.options.cwd}. ` +
                `Run \`claude\` once in ${this.options.cwd}, accept the trust dialog, then try again.`,
            ),
          );
        } else if (dialog.keys === undefined || answers >= MAX_DIALOG_ANSWERS) {
          this.emit("unknown-dialog", pty.screen());
          finish(
            withScreen(
              `The Claude CLI shows a "${dialog.kind}" dialog the adapter can't answer.`,
              pty.screen(),
            ),
          );
        } else {
          answers++;
          answered = dialog.kind;
          mark = pty.mark();
          pty.write(dialog.keys);
          this.emit("dialog", dialog.kind);
          quiet.start();
        }
      });
      const timeout = setTimeout(() => {
        this.emit("unknown-dialog", pty.screen());
        finish(
          withScreen(
            `The Claude CLI did not get ready in ${START_TIMEOUT_MS / 1000} s.`,
            pty.screen(),
          ),
        );
      }, START_TIMEOUT_MS);
      pty.onData(() => (quiet.running ? quiet.poke() : quiet.start()));
      pty.onExit((exitCode) =>
        finish(new Error(`The Claude CLI exited with code ${exitCode} at startup.`)),
      );
    });
  }

  private onRecord(record: TranscriptRecord): void {
    this.unknownDialog.poke();
    const turn = this.turn;
    if (turn && !turn.cancelled) {
      turn.queue.push(record);
      turn.wake?.();
    }
    this.detector.observe(record);
  }

  /** Ends the running turn with `result`, or fails it with an error. */
  private endTurn(result: TurnResult | Error): void {
    const turn = this.turn;
    if (!turn) {
      return;
    }
    this.clearTurn(turn);
    this.detector.stop();
    this.unknownDialog.stop();
    settle(turn, result);
  }
}

function newTurn(): Turn {
  let resolve!: (result: TurnResult) => void;
  let reject!: (error: Error) => void;
  let clear!: () => void;
  const done = new Promise<TurnResult>((onResult, onError) => {
    resolve = onResult;
    reject = onError;
  });
  // Callers may read the error from `records` alone; don't crash on an unawaited `done`.
  done.catch(() => {});
  const cleared = new Promise<void>((onClear) => (clear = onClear));
  const turn = { queue: [], wake: undefined, closed: false, cancelled: false, error: undefined };
  return { ...turn, resolve, reject, done, cleared, clear };
}

/** Resolves the turn with `outcome`, or fails it with an error, and closes its records. Once. */
function settle(turn: Turn, outcome: TurnResult | Error): void {
  if (turn.closed) {
    return;
  }
  if (outcome instanceof Error) {
    turn.error = outcome;
    turn.reject(outcome);
  } else {
    turn.resolve(outcome);
  }
  close(turn);
}

/** `message` with the last lines of `screen` (the CLI's recent output) that are not blank. */
function withScreen(message: string, screen: string): Error {
  const lines = screen
    .split(LINE_BREAK)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-ERROR_SCREEN_LINES);
  return new Error(lines.length ? `${message}\n\nScreen:\n${lines.join("\n")}` : message);
}

function close(turn: Turn): void {
  turn.closed = true;
  turn.wake?.();
}

async function* drain(turn: Turn): AsyncGenerator<TranscriptRecord> {
  while (true) {
    const record = turn.queue.shift();
    if (record) {
      yield record;
    } else if (turn.closed) {
      if (turn.error) {
        throw turn.error;
      }
      return;
    } else {
      await new Promise<void>((resolve) => (turn.wake = resolve));
      turn.wake = undefined;
    }
  }
}
