/**
 * Runs one session in the interactive CLI: spawns it at the first prompt,
 * answers its startup dialogs, sends prompts, and streams each turn's
 * transcript records until the turn ends. Knows nothing of ACP.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { detectDialog, type DialogKind } from "./dialogs.js";
import { EndOfTurnDetector, QuietTimer, type TurnEndReason } from "./end-of-turn.js";
import { ClaudePty, type ClaudePtyOptions } from "./pty.js";
import { TranscriptTail, type TranscriptRecord } from "./transcript.js";

/** Output quiet this long with no dialog on screen means the CLI takes input. */
const READY_QUIET_MS = 1000;
const START_TIMEOUT_MS = 60_000;
const UNKNOWN_DIALOG_MS = 30_000;
/** How long a cancelled turn may keep the session busy when the CLI writes no end. */
const CANCEL_DRAIN_MS = 2000;
/** Answers to startup dialogs before the engine stops answering: the keys are not taking. */
const MAX_DIALOG_ANSWERS = 4;

export type TuiEngineOptions = Omit<ClaudePtyOptions, "sessionId"> & {
  /** Default: a new UUID, or `resume` when set. */
  sessionId?: string;
  quiescenceMs?: number;
  stallMs?: number;
  /** Screen and transcript unchanged this long during a turn: `unknown-dialog`. */
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
};

export class TuiEngine extends EventEmitter<TuiEngineEvents> {
  readonly sessionId: string;
  private pty: ClaudePty | undefined;
  private starting: Promise<void> | undefined;
  private turn: Turn | undefined;
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
    this.unknownDialog = new QuietTimer(options.unknownDialogMs ?? UNKNOWN_DIALOG_MS, () =>
      this.emit("unknown-dialog", this.pty?.screen() ?? ""),
    );
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

  /** Sends `text` as the next turn. Throws while a turn runs. */
  prompt(text: string): TuiTurn {
    if (this.turn) {
      throw new Error("A turn is already running in this session. Try again when the turn ends.");
    }
    if (this.disposed) {
      throw new Error("The session's Claude CLI was stopped. Start a new session.");
    }
    const turn: Turn = {
      queue: [],
      wake: undefined,
      closed: false,
      cancelled: false,
      error: undefined,
      resolve: () => {},
      reject: () => {},
    };
    const done = new Promise<TurnResult>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    // Callers may read the error from `records` alone; don't crash on an unawaited `done`.
    done.catch(() => {});
    this.turn = turn;
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
    return { records: drain(turn), done };
  }

  /**
   * Resolves the running turn as cancelled and interrupts the CLI. The
   * session stays busy until the CLI ends the turn, at most {@link CANCEL_DRAIN_MS}.
   */
  cancel(): void {
    const turn = this.turn;
    if (!turn || turn.cancelled) {
      return;
    }
    turn.cancelled = true;
    close(turn);
    turn.resolve({ stopReason: "cancelled" });
    this.unknownDialog.stop();
    this.pty?.interrupt(() => this.turn === turn);
    setTimeout(() => {
      if (this.turn === turn) {
        this.detector.stop();
        this.turn = undefined;
      }
    }, CANCEL_DRAIN_MS);
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

  /** Resolves once output stays quiet with no dialog on screen, answering the dialogs it knows. */
  private answerStartupDialogs(pty: ClaudePty): Promise<void> {
    return new Promise((resolve, reject) => {
      let mark = 0;
      let answers = 0;
      let answered: DialogKind | undefined;
      const finish = (error?: Error) => {
        settle.stop();
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const settle = new QuietTimer(READY_QUIET_MS, () => {
        // No output after an answer: the keys did not take, and the prompt's Enter would pick "No".
        if (answered && pty.mark() === mark) {
          this.emit("unknown-dialog", pty.screen());
          finish(
            new Error(`The Claude CLI showed nothing after the "${answered}" dialog was answered.`),
          );
          return;
        }
        const dialog = detectDialog(pty.screenSince(mark));
        if (!dialog) {
          finish();
        } else if (dialog.keys === undefined || answers >= MAX_DIALOG_ANSWERS) {
          this.emit("unknown-dialog", pty.screen());
          finish(
            new Error(`The Claude CLI shows a "${dialog.kind}" dialog the adapter can't answer.`),
          );
        } else {
          answers++;
          answered = dialog.kind;
          mark = pty.mark();
          pty.write(dialog.keys);
          this.emit("dialog", dialog.kind);
          settle.start();
        }
      });
      const timeout = setTimeout(
        () =>
          finish(new Error(`The Claude CLI did not get ready in ${START_TIMEOUT_MS / 1000} s.`)),
        START_TIMEOUT_MS,
      );
      pty.onData(() => (settle.running ? settle.poke() : settle.start()));
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
    this.turn = undefined;
    this.detector.stop();
    this.unknownDialog.stop();
    if (result instanceof Error) {
      turn.error = result;
      turn.reject(result);
    } else {
      turn.resolve(result);
    }
    close(turn);
  }
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
