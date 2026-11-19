import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuiEngine } from "../../tui/engine.js";
import type { TranscriptRecord } from "../../tui/transcript.js";
import { fixture, fixtureText } from "./fixture.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
// Built from the text quoted in the task; no capture of this dialog exists yet (see dialogs.test.ts).
const CODE_MODE_SCREEN =
  "Code Mode is experimental.\n  ❯ No, start without it \n Yes, turn on Code Mode\n\n  Enter to confirm";

const fake = vi.hoisted(() => {
  // node-pty's IPty, as far as ClaudePty uses it.
  class FakePty {
    readonly pid = 4242;
    readonly written: string[] = [];
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

    kill() {
      this.exit(0);
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
    fake.ptys.length = 0;
    engine = new TuiEngine({
      cwd: root,
      sessionId: SESSION_ID,
      projectsRoot: root,
      quiescenceMs: 50,
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(root, { recursive: true, force: true });
  });

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
    mkdirSync(path.join(root, "-project"));
    writeFileSync(
      path.join(root, "-project", `${SESSION_ID}.jsonl`),
      transcript.map((r) => JSON.stringify(r) + "\n").join(""),
    );
    const records: TranscriptRecord[] = [];
    for await (const record of turn.records) {
      records.push(record);
    }
    expect(records).toEqual(transcript);
    expect(await turn.done).toEqual({ stopReason: "turn_duration", record: transcript.at(-1) });
    await vi.waitFor(() => expect(pty.written).toContain("\r"));

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
    const transcript = fixture("plain-turn");
    mkdirSync(path.join(root, "-project"));
    writeFileSync(
      path.join(root, "-project", `${SESSION_ID}.jsonl`),
      transcript.map((r) => JSON.stringify(r) + "\n").join(""),
    );
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
    engine = new TuiEngine({
      cwd: root,
      sessionId: SESSION_ID,
      projectsRoot: root,
      unknownDialogMs: 300,
    });
    const { turn, pty } = await promptPastStartup("edit it", fixtureText("ready-screen.txt"));
    pty.output("Do you want to make this edit?\n ❯ 1. Yes\n   2. No\n");
    await expect(turn.done).rejects.toThrow(
      /can't answer\.\n\nScreen:\n[\s\S]*Do you want to make this edit\?/,
    );
    expect(pty.written).toContain("\x03");
  });
});
