import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChoiceOption, Dialog } from "../../tui/dialogs.js";
import { TuiEngine, type TuiEngineOptions } from "../../tui/engine.js";
import { PTY_COLS } from "../../tui/pty.js";
import type { TranscriptRecord } from "../../tui/transcript.js";
import { fixture, fixtureText } from "./fixture.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const DOWN = "\x1b[B";
const ESC = "\x1b";
// Model output that quotes a dialog, e.g. from a file the model read; the CLI does not wait on it.
const QUOTED_DIALOG =
  "\r\n⏺ The README says:\r\n\r\n  Do you want to proceed?\r\n  ❯ 1. Yes\r\n    2. No\r\n\r\n  Esc to cancel\r\n";
// Built from the text quoted in the task; no capture of this dialog exists yet (see dialogs.test.ts).
const CODE_MODE_SCREEN =
  "Code Mode is experimental.\n  ❯ No, start without it \n Yes, turn on Code Mode\n\n  Enter to confirm";

const fake = vi.hoisted(() => {
  // node-pty's IPty, as far as ClaudePty uses it.
  class FakePty {
    readonly pid = 4242;
    readonly written: string[] = [];
    /** The signals `kill` got; `undefined` is node-pty's default, SIGHUP. */
    readonly signals: Array<string | undefined> = [];
    /** Set: the fake CLI exits on SIGKILL only, like one that hangs on SIGHUP. */
    ignoreHangup = false;
    private dataListener: ((chunk: string) => void) | undefined;
    private exitListener: ((event: { exitCode: number }) => void) | undefined;

    constructor(readonly args: string[]) {}

    onData(listener: (chunk: string) => void) {
      this.dataListener = listener;
    }

    onExit(listener: (event: { exitCode: number }) => void) {
      this.exitListener = listener;
    }

    write(data: string) {
      this.written.push(data);
    }

    kill(signal?: string) {
      this.signals.push(signal);
      if (!this.ignoreHangup || signal === "SIGKILL") {
        this.exit(0);
      }
    }

    output(chunk: string) {
      this.dataListener?.(chunk);
    }

    exit(exitCode: number) {
      this.exitListener?.({ exitCode });
    }
  }
  return { FakePty, ptys: [] as FakePty[] };
});

vi.mock("node-pty", () => ({
  spawn: (_file: string, args: string[]) => {
    const pty = new fake.FakePty(args);
    fake.ptys.push(pty);
    return pty;
  },
}));

describe("TuiEngine", () => {
  let root: string;
  let engine: TuiEngine;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "tui-engine-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", root);
    fake.ptys.length = 0;
    engine = new TuiEngine({ cwd: root, sessionId: SESSION_ID, quiescenceMs: 50 });
  });

  afterEach(() => {
    engine.dispose();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /** Replaces the engine with one whose `askUser` is the test's. */
  function engineWith(askUser: NonNullable<TuiEngineOptions["askUser"]>) {
    void engine.dispose();
    engine = new TuiEngine({ cwd: root, sessionId: SESSION_ID, quiescenceMs: 50, askUser });
  }

  /** An `askUser` the test answers: `next()` waits for the next question. */
  function userAsked() {
    const questions: Array<{
      dialog: Dialog;
      signal: AbortSignal;
      choose: (pick: (options: ChoiceOption[]) => ChoiceOption | undefined) => void;
    }> = [];
    const askUser = (dialog: Dialog, signal: AbortSignal) =>
      new Promise<ChoiceOption | undefined>((resolve) =>
        questions.push({ dialog, signal, choose: (pick) => resolve(pick(dialog.options)) }),
      );
    const next = async (count: number) => {
      await vi.waitFor(() => expect(questions).toHaveLength(count), { timeout: 3000 });
      return questions[count - 1];
    };
    return { askUser, questions, next };
  }

  const transcriptFile = () => path.join(root, "projects", "-project", `${SESSION_ID}.jsonl`);

  function writeTranscript(name: string) {
    mkdirSync(path.dirname(transcriptFile()), { recursive: true });
    writeFileSync(
      transcriptFile(),
      fixture(name)
        .map((r) => JSON.stringify(r) + "\n")
        .join(""),
    );
  }

  /** Starts a turn and plays the CLI's startup until the prompt is typed. */
  async function promptPastStartup(text: string, ...screens: string[]) {
    const turn = engine.prompt(text);
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    for (const screen of screens) {
      const writes = pty.written.length;
      pty.output(screen);
      await vi.waitFor(() => expect(pty.written.length).toBeGreaterThan(writes), { timeout: 3000 });
    }
    await vi.waitFor(() => expect(pty.written).toContain(`\x1b[200~${text}\x1b[201~`), {
      timeout: 3000,
    });
    // The Enter that submits it, 200 ms after the paste.
    await vi.waitFor(() => expect(pty.written.at(-1)).toBe("\r"));
    return { turn, pty };
  }

  it("answers the Code Mode dialog, sends the prompt and streams the turn to its end", async () => {
    const dialogs: string[] = [];
    engine.on("dialog", (kind) => dialogs.push(kind));
    const { turn, pty } = await promptPastStartup(
      "count lines",
      CODE_MODE_SCREEN,
      fixtureText("ready-screen.txt"),
    );
    expect(pty.args).toEqual(["--session-id", SESSION_ID]);
    expect(pty.written[0]).toBe("\x1b[B\r");
    expect(dialogs).toEqual(["code-mode"]);
    expect(() => engine.prompt("again")).toThrow("Try again when the turn ends");

    const transcript = fixture("plain-turn");
    writeTranscript("plain-turn");
    const records: TranscriptRecord[] = [];
    for await (const record of turn.records) {
      records.push(record);
    }
    expect(records).toEqual(transcript);
    expect(await turn.done).toEqual({ stopReason: "turn_duration", record: transcript.at(-1) });
    // A turn that ended by itself is not interrupted.
    expect(pty.written).not.toContain("\x03");

    const next = engine.prompt("long task");
    await vi.waitFor(() => expect(pty.written).toContain("\x1b[200~long task\x1b[201~"));
    engine.cancel();
    expect(await next.done).toEqual({ stopReason: "cancelled" });
    expect(pty.written.filter((data) => data === "\x03")).toHaveLength(1);
  });

  it("fails the turn when the CLI exits", async () => {
    const { turn, pty } = await promptPastStartup("hi", fixtureText("ready-screen.txt"));
    pty.exit(1);
    await expect(turn.done).rejects.toThrow("The Claude CLI exited with code 1");
    await expect(turn.records[Symbol.asyncIterator]().next()).rejects.toThrow("exited with code 1");
    expect(() => engine.prompt("again")).toThrow("Start a new session");
  });

  it("fails startup when the CLI shows nothing after a dialog answer", async () => {
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output(CODE_MODE_SCREEN);
    await expect(turn.done).rejects.toThrow('nothing after the "code-mode" dialog');
    expect(pty.written.join("")).not.toContain("\x1b[200~");
  });

  it("refuses the trust dialog and names the folder", async () => {
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output(fixtureText("trust-screen.txt"));
    await expect(turn.done).rejects.toThrow(
      `Claude Code does not trust the folder ${root}. Run \`claude\` once in ${root}`,
    );
    expect(pty.written).toEqual([]);
  });

  it("waits for the input box before it sends the prompt", async () => {
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output("Claude Code v2.1.328\n  Loading…\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(pty.written).toEqual([]);
    pty.output(fixtureText("ready-screen.txt"));
    await vi.waitFor(() => expect(pty.written).toContain("\x1b[200~hi\x1b[201~"), {
      timeout: 3000,
    });
    engine.cancel();
    await turn.done;
  });

  it("runs a prompt sent while a cancelled turn settles once that turn ends", async () => {
    const { turn, pty } = await promptPastStartup("first", fixtureText("ready-screen.txt"));
    engine.cancel();
    expect(await turn.done).toEqual({ stopReason: "cancelled" });
    const next = engine.prompt("second");
    expect(() => engine.prompt("third")).toThrow("Try again when the turn ends");
    expect(pty.written.join("")).not.toContain("second");

    // The cancelled turn's end; its rows stay out of the next turn.
    writeTranscript("plain-turn");
    await vi.waitFor(() => expect(pty.written).toContain("\x1b[200~second\x1b[201~"), {
      timeout: 3000,
    });
    engine.cancel();
    const records: TranscriptRecord[] = [];
    for await (const record of next.records) {
      records.push(record);
    }
    expect(records).toEqual([]);
    expect(await next.done).toEqual({ stopReason: "cancelled" });
  });

  it("fails the turn with the screen when the CLI waits on a screen it can't answer", async () => {
    engine.dispose();
    engine = new TuiEngine({ cwd: root, sessionId: SESSION_ID, unknownDialogMs: 300 });
    const { turn, pty } = await promptPastStartup("edit it", fixtureText("ready-screen.txt"));
    pty.output("Do you want to make this edit?\n ❯ 1. Yes\n   2. No\n");
    await expect(turn.done).rejects.toThrow(
      /can't answer\.\n\nScreen:\n[\s\S]*Do you want to make this edit\?/,
    );
    expect(pty.written).toContain("\x03");
  });
  it("asks the user about the trust dialog and goes on once they trust the folder", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const dialogs: string[] = [];
    engine.on("dialog", (kind) => dialogs.push(kind));
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output(fixtureText("trust-screen.txt"));
    const asked = await user.next(1);
    expect(asked.dialog).toMatchObject({ kind: "trust" });
    expect(pty.written).toEqual([]);

    asked.choose((options) => options.find(({ kind }) => kind === "allow_once"));
    await vi.waitFor(() => expect(pty.written).toEqual([DOWN + "\r"]));
    expect(dialogs).toEqual(["trust"]);
    pty.output(fixtureText("ready-screen.txt"));
    await vi.waitFor(() => expect(pty.written).toContain("\x1b[200~hi\x1b[201~"), {
      timeout: 3000,
    });
    engine.cancel();
    await turn.done;
  });

  it("fails the prompt, naming the folder, when the user declines to trust it", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output(fixtureText("trust-screen.txt"));
    (await user.next(1)).choose((options) => options.find(({ kind }) => kind === "reject_once"));
    await expect(turn.done).rejects.toThrow(`You declined to trust the folder ${root}`);
    expect(pty.written).toEqual([ESC]);
    expect(engine.stopped).toBe(true);
  });

  it("declines the trust dialog with Esc and fails startup when the request fails", async () => {
    engineWith(async () => Promise.reject(new Error("connection closed")));
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output(fixtureText("trust-screen.txt"));
    await expect(turn.done).rejects.toThrow(
      'The permission request for "Quick safety check: Is this a project you created or one you trust?" failed: connection closed',
    );
    expect(pty.written).toEqual([ESC]);
  });

  it("declines the trust dialog and fails startup when another dialog replaces it", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output(fixtureText("trust-screen.txt"));
    const asked = await user.next(1);
    pty.output(fixtureText("tool-bash-screen.txt"));
    await expect(turn.done).rejects.toThrow(/showed another dialog while you were asked/);
    expect(asked.signal.aborted).toBe(true);
    asked.choose((options) => options.find(({ kind }) => kind === "allow_once"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pty.written).toEqual([ESC]);
  });

  it("declines the trust dialog and ends the turn cancelled when the client cancels the request", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const turn = engine.prompt("hi");
    await vi.waitFor(() => expect(fake.ptys).toHaveLength(1));
    const pty = fake.ptys[0];
    pty.output(fixtureText("trust-screen.txt"));
    (await user.next(1)).choose(() => undefined);
    expect(await turn.done).toEqual({ stopReason: "cancelled" });
    expect(pty.written).toEqual([ESC]);
    await vi.waitFor(() => expect(engine.stopped).toBe(true));
  });

  it("relays each tool permission of a turn and answers the user's choice", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const { turn, pty } = await promptPastStartup("make it", fixtureText("ready-screen.txt"));
    const sent = pty.written.length;
    pty.output(fixtureText("tool-bash-screen.txt"));
    const first = await user.next(1);
    expect(first.dialog).toMatchObject({ kind: "permission", question: "Do you want to proceed?" });
    // The spinner keeps drawing under the dialog, and the dialog is drawn again: one question.
    pty.output("  ⏺    \r   4    \r");
    pty.output(fixtureText("tool-bash-screen.txt"));
    first.choose((options) => options.find(({ kind }) => kind === "allow_always"));
    await vi.waitFor(() => expect(pty.written.slice(sent)).toEqual([DOWN + "\r"]));
    expect(user.questions).toHaveLength(1);

    pty.output(fixtureText("tool-bash-screen.txt"));
    (await user.next(2)).choose((options) => options.find(({ kind }) => kind === "reject_once"));
    await vi.waitFor(() => expect(pty.written.slice(sent)).toEqual([DOWN + "\r", ESC]));
    // The CLI ends the turn on "No" with an interruption row and nothing more.
    writeTranscript("rejected-turn");
    expect(await turn.done).toMatchObject({ stopReason: "interrupted" });
    expect(pty.written).not.toContain("\x03");
  });

  it.each([
    ["the prompt is cancelled", "cancel"],
    ["the client cancels the request", "no choice"],
  ])("declines with Esc and ends the turn cancelled when %s", async (_name, how) => {
    const user = userAsked();
    engineWith(user.askUser);
    const { turn, pty } = await promptPastStartup("make it", fixtureText("ready-screen.txt"));
    pty.output(fixtureText("tool-bash-screen.txt"));
    const asked = await user.next(1);
    const sent = pty.written.length;
    if (how === "cancel") {
      engine.cancel();
      expect(asked.signal.aborted).toBe(true);
    } else {
      asked.choose(() => undefined);
    }
    expect(await turn.done).toEqual({ stopReason: "cancelled" });
    await vi.waitFor(() => expect(pty.written.slice(sent)).toEqual([ESC]));
    // A late answer writes nothing, and no Ctrl+C or second Esc lands on the input box.
    asked.choose((options) => options[0]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(pty.written.slice(sent)).toEqual([ESC]);
  });

  it.each([
    ["the user answers the quoted one No", "no"],
    ["the prompt is cancelled", "cancel"],
  ])(
    "declines a real dialog drawn while a quoted one is asked, with Esc alone, when %s",
    async (_name, how) => {
      const user = userAsked();
      engineWith(user.askUser);
      const { turn, pty } = await promptPastStartup("summarize", fixtureText("ready-screen.txt"));
      const sent = pty.written.length;
      pty.output(QUOTED_DIALOG);
      const quoted = await user.next(1);
      expect(quoted.dialog.options.map(({ label }) => label)).toEqual(["Yes", "No"]);

      pty.output(fixtureText("tool-bash-screen.txt"));
      await expect(turn.done).rejects.toThrow(
        /showed another dialog while you were asked "Do you want to proceed\?"[\s\S]*Screen:/,
      );
      expect(quoted.signal.aborted).toBe(true);
      if (how === "no") {
        quoted.choose((options) => options.find(({ kind }) => kind === "reject_once"));
      } else {
        engine.cancel();
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(pty.written.slice(sent)).toEqual([ESC]);
      expect(user.questions).toHaveLength(1);
    },
  );

  it("declines a real dialog with the quoted one's question and options, but another command", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const { turn, pty } = await promptPastStartup("summarize", fixtureText("ready-screen.txt"));
    const sent = pty.written.length;
    pty.output(QUOTED_DIALOG);
    const quoted = await user.next(1);
    pty.output(
      `${"─".repeat(PTY_COLS)}\r\n Bash command\r\n   rm -rf build\r\n Do you want to proceed?\r\n` +
        " ❯ 1. Yes\r\n   2. No\r\n\r\n Esc to cancel · Tab to amend\r\n",
    );
    await expect(turn.done).rejects.toThrow(/showed another dialog/);
    quoted.choose((options) => options.find(({ kind }) => kind === "allow_once"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pty.written.slice(sent)).toEqual([ESC]);
  });

  it.each([
    ["allows", "allow_always"],
    ["declines", "reject_once"],
  ])(
    "sends none of the answer's keys, interrupts the CLI and fails the turn when the user %s after the dialog closed",
    async (_name, kind) => {
      const user = userAsked();
      engineWith(user.askUser);
      const { turn, pty } = await promptPastStartup("make it", fixtureText("ready-screen.txt"));
      const sent = pty.written.length;
      pty.output(fixtureText("tool-bash-screen.txt"));
      const asked = await user.next(1);
      // The dialog is gone: the input box is drawn again, with no dialog after it.
      pty.output(fixtureText("ready-screen.txt"));
      asked.choose((options) => options.find((option) => option.kind === kind));
      await expect(turn.done).rejects.toThrow(
        'The Claude CLI closed the dialog "Do you want to proceed?" before your answer arrived, ' +
          "so your answer was not sent and the CLI's turn was stopped. Send the prompt again.",
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      // Only the interrupt's keys: Ctrl+C, then Esc a second later.
      expect(pty.written.slice(sent)).toEqual(["\x03", ESC]);
    },
  );

  it("sends no Enter onto a dialog the CLI shows after a late answer, before the turn clears", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const { turn, pty } = await promptPastStartup("make it", fixtureText("ready-screen.txt"));
    pty.output(fixtureText("tool-bash-screen.txt"));
    const asked = await user.next(1);
    pty.output(fixtureText("ready-screen.txt"));
    asked.choose((options) => options.find(({ kind }) => kind === "allow_always"));
    await expect(turn.done).rejects.toThrow(/before your answer arrived/);
    // The CLI works on and asks about a Write; the next prompt's Enter would approve it.
    pty.output(fixtureText("tool-write-screen.txt"));
    const sent = pty.written.length;
    const next = engine.prompt("next");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(pty.written.slice(sent)).not.toContain("\r");
    engine.cancel();
    await next.done;
  });

  it("writes the answer's keys when the asked dialog is drawn again after the input box", async () => {
    const user = userAsked();
    engineWith(user.askUser);
    const { turn, pty } = await promptPastStartup("make it", fixtureText("ready-screen.txt"));
    let ended = false;
    const end = () => (ended = true);
    void turn.done.then(end, end);
    const sent = pty.written.length;
    pty.output(fixtureText("tool-bash-screen.txt"));
    const asked = await user.next(1);
    pty.output(fixtureText("ready-screen.txt"));
    pty.output(fixtureText("tool-bash-screen.txt"));
    asked.choose((options) => options.find(({ kind }) => kind === "allow_once"));
    await vi.waitFor(() => expect(pty.written.slice(sent)).toEqual(["\r"]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ended).toBe(false);
  });

  it("declines with Esc and fails the turn when the permission request fails", async () => {
    engineWith(async () => Promise.reject(new Error("connection closed")));
    const { turn, pty } = await promptPastStartup("make it", fixtureText("ready-screen.txt"));
    const sent = pty.written.length;
    pty.output(fixtureText("tool-bash-screen.txt"));
    await expect(turn.done).rejects.toThrow(
      'The permission request for "Do you want to proceed?" failed: connection closed',
    );
    expect(pty.written.slice(sent)).toEqual([ESC]);
  });

  it("fails the turn and stops the CLI when the transcript can't be read", async () => {
    const { turn } = await promptPastStartup("hi", fixtureText("ready-screen.txt"));
    // A directory where the transcript should be: found, but every read fails.
    mkdirSync(transcriptFile(), { recursive: true });
    await expect(turn.done).rejects.toThrow("Could not read the session transcript");
    await vi.waitFor(() => expect(engine.stopped).toBe(true));
    expect(() => engine.prompt("again")).toThrow("Start a new session");
  });

  it("waits for the CLI to exit on dispose and kills it after 3 s", { timeout: 8000 }, async () => {
    const { turn, pty } = await promptPastStartup("hi", fixtureText("ready-screen.txt"));
    pty.ignoreHangup = true;
    let disposed = false;
    const dispose = engine.dispose().then(() => (disposed = true));
    await expect(turn.done).resolves.toEqual({ stopReason: "cancelled" });
    expect(pty.signals).toEqual([undefined]);
    await new Promise((resolve) => setTimeout(resolve, 2800));
    expect(disposed).toBe(false);
    await dispose;
    expect(pty.signals).toEqual([undefined, "SIGKILL"]);
    // Already gone: at once.
    await engine.dispose();
    expect(pty.signals).toHaveLength(2);
  });
});
