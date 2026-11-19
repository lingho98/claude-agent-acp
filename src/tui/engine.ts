/**
 * Runs one session in the interactive CLI: spawns it at the first prompt,
 * answers its Code Mode dialog, sends prompts, and streams each turn's
 * transcript records until the turn ends. Knows nothing of ACP.
 *
 * Every other dialog `detectDialog` reads (the trust dialog, a tool
 * permission) goes to `askUser`, and the engine picks the option the user
 * chose. Every decline is one Esc ({@link DECLINE}): a "No", a cancel while
 * the user is asked, a failed or cancelled request, and a dialog that differs
 * from the one the user is asked about, which fails the turn. The trust
 * dialog is never answered without the user: declining it, or no `askUser`,
 * fails the prompt and names the folder.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  type ChoiceOption,
  DECLINE,
  detectDialog,
  type Dialog,
  type DialogKind,
  keysFor,
  LINE_BREAK,
  sameDialog,
  showsInputBox,
} from "./dialogs.js";
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
  /** Screen and transcript unchanged this long during a turn: `unknown-dialog`, and the turn fails. */
  unknownDialogMs?: number;
  /**
   * Asks the user to pick one of `dialog`'s options. Resolves `undefined`
   * when the user picked none (the client cancelled the request), and
   * rejects when the request failed. `signal` aborts when the engine stops
   * waiting (a cancel, another dialog); the engine then declines itself.
   */
  askUser?: (dialog: Dialog, signal: AbortSignal) => Promise<ChoiceOption | undefined>;
};

/** The user's answer: `cancelled` when the engine stopped waiting for it meanwhile. */
type Answer = { option?: ChoiceOption; error?: Error; cancelled?: boolean };

export type TuiEngineEvents = {
  /** A dialog the engine answered: "Yes" to Code Mode, or the user's choice. */
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
  /** The dialog the user is asked about; one at a time. */
  private asking: { dialog: Dialog; controller: AbortController } | undefined;
  /** During a turn, after the prompt is sent: output before this mark holds no unanswered dialog. */
  private dialogMark: number | undefined;
  private spawning: Promise<ClaudePty> | undefined;
  private disposed = false;

  constructor(private readonly options: TuiEngineOptions) {
    super();
    this.sessionId = options.sessionId ?? options.resume ?? randomUUID();
    this.tail = new TranscriptTail({
      sessionId: this.sessionId,
      fromEnd: options.resume !== undefined,
      onRecord: (record) => this.onRecord(record),
      onError: (error) => {
        this.endTurn(
          new Error(`Could not read the session transcript: ${error.message}`, { cause: error }),
        );
        // The tail stopped for good: the next prompt starts a new CLI that resumes the session.
        void this.dispose();
      },
    });
    this.detector = new EndOfTurnDetector({
      quiescenceMs: options.quiescenceMs,
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

  /** Cancels the turn and stops the CLI; resolves once its process exited (see `ClaudePty.dispose`). */
  dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.cancel();
      this.detector.stop();
      this.unknownDialog.stop();
      this.tail.stop();
    }
    if (this.pty) {
      return this.pty.dispose();
    }
    // Still spawning: `spawn` disposes the new CLI when it sees `disposed`.
    return (
      this.spawning?.then(
        (pty) => pty.dispose(),
        () => {}, // No CLI to stop; `start` reports the failed spawn.
      ) ?? Promise.resolve()
    );
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
          this.dialogMark = this.pty.mark();
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
    const asking = this.asking;
    if (asking) {
      // The CLI waits on the dialog: a Ctrl+C, then Esc, would land on the input box after it.
      this.asking = undefined;
      asking.controller.abort();
      this.pty?.write(DECLINE);
    } else {
      this.pty?.interrupt(() => this.turn === turn);
    }
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
      this.dialogMark = undefined;
      this.asking?.controller.abort();
      this.asking = undefined;
      turn.clear();
    }
  }

  private async spawn(): Promise<void> {
    const pty = await (this.spawning = ClaudePty.spawn({
      ...this.options,
      sessionId: this.sessionId,
    }));
    this.pty = pty;
    if (this.disposed) {
      void pty.dispose();
      throw new Error("The session was disposed while its Claude CLI started.");
    }
    pty.onData(() => {
      this.detector.noteActivity();
      this.unknownDialog.poke();
      this.relayDialog(pty);
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
   * screen. Answers the Code Mode dialog, and asks the user about any other
   * dialog (the trust dialog). Quiet with neither waits for more output, up
   * to {@link START_TIMEOUT_MS}; the wait for the user's answer doesn't count.
   */
  private answerStartupDialogs(pty: ClaudePty): Promise<void> {
    const askUser = this.options.askUser;
    return new Promise((resolve, reject) => {
      let settled = false;
      let mark = 0;
      let answers = 0;
      let answered: DialogKind | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        settled = true;
        quiet.stop();
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const answer = (dialog: Dialog, option: ChoiceOption) => {
        answers++;
        answered = dialog.kind;
        mark = pty.mark();
        // The cursor was read; no keys only if it wasn't, and the quiet check above then fails startup.
        pty.write(keysFor(dialog, option) ?? "");
        this.emit("dialog", dialog.kind);
        quiet.start();
      };
      const armTimeout = () => {
        timeout = setTimeout(() => {
          this.emit("unknown-dialog", pty.screen());
          finish(
            withScreen(
              `The Claude CLI did not get ready in ${START_TIMEOUT_MS / 1000} s.`,
              pty.screen(),
            ),
          );
        }, START_TIMEOUT_MS);
      };
      const quiet = new QuietTimer(READY_QUIET_MS, () => {
        // No output after an answer: the keys did not take, and the prompt's Enter would pick another option.
        if (answered && pty.mark() === mark) {
          this.emit("unknown-dialog", pty.screen());
          finish(
            new Error(`The Claude CLI showed nothing after the "${answered}" dialog was answered.`),
          );
          return;
        }
        const screen = pty.screenSince(mark);
        const dialog = detectDialog(screen);
        const yes = dialog?.options.find(({ kind }) => kind !== "reject_once");
        if (!dialog && showsInputBox(screen)) {
          finish();
        } else if (!dialog) {
          // Not drawn yet: the next output restarts this wait, START_TIMEOUT_MS ends it.
        } else if (dialog.kind === "trust" && !askUser) {
          finish(
            new Error(
              `Claude Code does not trust the folder ${this.options.cwd}. ` +
                `Run \`claude\` once in ${this.options.cwd}, accept the trust dialog, then try again.`,
            ),
          );
        } else if (
          dialog.cursor === undefined ||
          !yes ||
          answers >= MAX_DIALOG_ANSWERS ||
          (dialog.kind !== "code-mode" && !askUser)
        ) {
          this.emit("unknown-dialog", pty.screen());
          finish(
            withScreen(
              `The Claude CLI shows a "${dialog.kind}" dialog the adapter can't answer.`,
              pty.screen(),
            ),
          );
        } else if (dialog.kind !== "code-mode" && askUser) {
          clearTimeout(timeout);
          void this.ask(dialog, askUser).then(({ option, error, cancelled }) => {
            if (!cancelled && !error && !option) {
              // The client cancelled the request: a cancel of the prompt, which declines while `asking` is set.
              this.cancel();
            } else if (!cancelled) {
              this.asking = undefined;
            }
            if (settled) {
              return;
            }
            if (cancelled || (!error && !option)) {
              // `interrupt` or the other-dialog check declined it.
              finish(new Error("The prompt was cancelled while Claude Code asked about a dialog."));
            } else if (error || option?.kind === "reject_once") {
              pty.write(DECLINE);
              // Settled before the CLI's exit: its "exited with code" error must not win.
              finish(error ?? declined(dialog, this.options.cwd));
            } else if (option) {
              armTimeout();
              answer(dialog, option);
            }
          });
        } else {
          // The Code Mode dialog.
          answer(dialog, yes);
        }
      });
      armTimeout();
      pty.onData(() => {
        if (settled) {
          return;
        }
        const asking = this.asking;
        if (asking) {
          const shown = detectDialog(pty.screenSince(mark));
          if (shown && !sameDialog(shown, asking.dialog)) {
            this.asking = undefined;
            asking.controller.abort();
            pty.write(DECLINE);
            this.emit("unknown-dialog", pty.screen());
            finish(otherDialog(asking.dialog, pty.screen()));
          }
          return;
        }
        if (quiet.running) {
          quiet.poke();
        } else {
          quiet.start();
        }
      });
      pty.onExit((exitCode) =>
        finish(new Error(`The Claude CLI exited with code ${exitCode} at startup.`)),
      );
    });
  }

  /**
   * Asks the user about a dialog the CLI shows mid-turn, and answers it. The
   * unknown-dialog and stall watchdogs wait while the user decides. No choice
   * cancels the turn, and a failed request fails it, both declining (see
   * {@link interrupt}). Another dialog while the user is asked fails the turn:
   * the asked one is gone, or was never a dialog (model output that quotes one).
   */
  private relayDialog(pty: ClaudePty): void {
    const turn = this.turn;
    if (!turn || turn.cancelled || this.dialogMark === undefined) {
      return;
    }
    const dialog = detectDialog(pty.screenSince(this.dialogMark));
    if (!dialog) {
      return;
    }
    const asking = this.asking;
    if (asking) {
      if (!sameDialog(dialog, asking.dialog)) {
        this.emit("unknown-dialog", pty.screen());
        this.interrupt(otherDialog(asking.dialog, pty.screen()));
      }
      return;
    }
    this.dialogMark = pty.mark();
    const askUser = this.options.askUser;
    if (dialog.cursor === undefined || !askUser) {
      this.emit("unknown-dialog", pty.screen());
      this.interrupt(
        withScreen(
          `The Claude CLI shows a "${dialog.kind}" dialog the adapter can't answer.`,
          pty.screen(),
        ),
      );
      return;
    }
    this.unknownDialog.stop();
    this.detector.waitOnUser({ waiting: true });
    void this.ask(dialog, askUser).then(({ option, error, cancelled }) => {
      if (cancelled || this.turn !== turn) {
        return;
      }
      if (error) {
        // While `asking` is set, `interrupt` declines the dialog.
        this.interrupt(error);
        return;
      }
      if (!option) {
        this.cancel();
        return;
      }
      this.asking = undefined;
      this.dialogMark = pty.mark();
      // The cursor was read above. A "No" ends the turn: the CLI writes its interruption row.
      pty.write(option.kind === "reject_once" ? DECLINE : (keysFor(dialog, option) ?? ""));
      this.emit("dialog", dialog.kind);
      this.detector.waitOnUser({ waiting: false });
      this.unknownDialog.start();
    });
  }

  /**
   * Asks `askUser` about `dialog`, kept in {@link asking} until the caller
   * clears it. `cancelled`: {@link interrupt}, the other-dialog check or the
   * turn's end declined or dropped the dialog meanwhile, so a late answer,
   * or the failure the abort caused, is not the user's.
   */
  private async ask(
    dialog: Dialog,
    askUser: NonNullable<TuiEngineOptions["askUser"]>,
  ): Promise<Answer> {
    const asking = { dialog, controller: new AbortController() };
    this.asking = asking;
    try {
      const option = await askUser(dialog, asking.controller.signal);
      return this.asking === asking ? { option } : { cancelled: true };
    } catch (error) {
      if (this.asking !== asking) {
        return { cancelled: true };
      }
      const message = `The permission request for "${dialog.question}" failed: ${(error as Error).message}`;
      return { error: new Error(message, { cause: error }) };
    }
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

/** The startup error of a dialog the user declined. */
function declined(dialog: Dialog, cwd: string): Error {
  return dialog.kind === "trust"
    ? new Error(
        `You declined to trust the folder ${cwd}, so Claude Code can't work in it. ` +
          "Send a prompt again to be asked again.",
      )
    : new Error(`You declined "${dialog.question}" as the Claude CLI started.`);
}

/** The error of a dialog that replaced the one the user was asked about. */
function otherDialog(asked: Dialog, screen: string): Error {
  return withScreen(
    `The Claude CLI showed another dialog while you were asked "${asked.question}", ` +
      "so the adapter declined it. Send the prompt again.",
    screen,
  );
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
