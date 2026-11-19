import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuiEngine } from "../../tui/engine.js";
import type { TranscriptRecord } from "../../tui/transcript.js";
import { fixture, fixtureText } from "./fixture.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

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

  it("answers the trust dialog, sends the prompt and streams the turn to its end", async () => {
    const dialogs: string[] = [];
    engine.on("dialog", (kind) => dialogs.push(kind));
    const { turn, pty } = await promptPastStartup(
      "count lines",
      fixtureText("trust-screen.txt"),
      fixtureText("ready-screen.txt"),
    );
    expect(pty.args).toEqual(["--session-id", SESSION_ID]);
    expect(pty.written[0]).toBe("\x1b[B\r");
    expect(dialogs).toEqual(["trust"]);
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
    pty.output(fixtureText("trust-screen.txt"));
    await expect(turn.done).rejects.toThrow('nothing after the "trust" dialog');
    expect(pty.written.join("")).not.toContain("\x1b[200~");
  });
});
