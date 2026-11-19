import {
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuiAcpAgent, type TuiEngineLike } from "../../tui/agent.js";
import { detectDialog, type Dialog } from "../../tui/dialogs.js";
import type { TuiEngineOptions, TurnResult } from "../../tui/engine.js";
import type { TranscriptRecord } from "../../tui/transcript.js";
import { fixture, fixtureText } from "./fixture.js";

/** A TuiEngine double: each prompt's turn ends when the test calls `finish`. */
class FakeEngine implements TuiEngineLike {
  stopped = false;
  readonly prompts: string[] = [];
  cancels = 0;
  private finish: ((outcome: TurnResult | Error) => void) | undefined;

  constructor(readonly options: TuiEngineOptions) {}

  prompt(text: string) {
    if (this.stopped) {
      throw new Error("The session's Claude CLI was stopped. Start a new session.");
    }
    this.prompts.push(text);
    let finish!: (outcome: TurnResult | Error) => void;
    const settled = new Promise<TurnResult | Error>((resolve) => (finish = resolve));
    this.finish = finish;
    const done = settled.then((outcome) =>
      outcome instanceof Error ? Promise.reject(outcome) : outcome,
    );
    done.catch(() => {});
    const records = async function* (engine: FakeEngine) {
      const outcome = await settled;
      yield* engine.records;
      if (outcome instanceof Error) {
        throw outcome;
      }
    };
    return {
      records: records(this),
      done,
    };
  }

  /** The records the running turn streams when it ends. */
  records: TranscriptRecord[] = [];

  end(outcome: TurnResult | Error) {
    this.finish?.(outcome);
  }

  cancel() {
    this.cancels++;
    this.end({ stopReason: "cancelled" });
  }

  /** Resolves when the test calls `exited`, as the real CLI's exit. */
  dispose() {
    this.stopped = true;
    return new Promise<void>((resolve) => (this.exited = resolve));
  }

  exited: (() => void) | undefined;
}

describe("TuiAcpAgent", () => {
  let configDir: string;
  let sent: SessionNotification[];
  let engines: FakeEngine[];
  let agent: TuiAcpAgent;
  /** Answers the agent's `session/request_permission`; records each request and its signal. */
  let permissions: Array<{ params: RequestPermissionRequest; signal?: AbortSignal }>;
  let answer: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

  beforeEach(async () => {
    configDir = mkdtempSync(path.join(tmpdir(), "tui-agent-"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    sent = [];
    engines = [];
    permissions = [];
    answer = async () => ({ outcome: { outcome: "cancelled" } });
    agent = new TuiAcpAgent(
      {
        notify: async (_method: string, params: unknown) =>
          void sent.push(params as SessionNotification),
        request: async (
          method: string,
          params: RequestPermissionRequest,
          options?: { cancellationSignal?: AbortSignal },
        ) => {
          expect(method).toBe("session/request_permission");
          permissions.push({ params, signal: options?.cancellationSignal });
          return answer(params);
        },
      } as never,
      console,
      (options) => {
        const engine = new FakeEngine(options);
        engines.push(engine);
        return engine;
      },
    );
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  const prompt = (sessionId: string, text = "hi") =>
    agent.prompt({ sessionId, prompt: [{ type: "text", text }] });

  it("starts no CLI for a new session and offers the auto and default modes", async () => {
    const session = await agent.newSession({ cwd: "/work", mcpServers: [] });
    expect(engines).toEqual([]);
    expect(session.modes).toEqual({
      currentModeId: "auto",
      availableModes: [
        expect.objectContaining({ id: "auto" }),
        expect.objectContaining({ id: "default" }),
      ],
    });
    await expect(
      agent.setSessionMode({ sessionId: session.sessionId, modeId: "acceptEdits" }),
    ).rejects.toThrow('runs the "auto" and "default" modes, not "acceptEdits"');
  });

  it("spawns the CLI in the mode set before the first prompt and refuses a change after", async () => {
    const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] });
    await expect(agent.setSessionMode({ sessionId, modeId: "default" })).resolves.toEqual({});
    const turn = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    expect(engines[0].options.permissionMode).toBe("default");

    await expect(agent.setSessionMode({ sessionId, modeId: "auto" })).rejects.toThrow(
      "a mode change needs a new session",
    );
    await expect(agent.setSessionMode({ sessionId, modeId: "default" })).resolves.toEqual({});
    engines[0].end({ stopReason: "end_turn" });
    await turn;
  });

  it("asks the client about a dialog and resolves the option it chose", async () => {
    const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] });
    const turn = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    const askUser = engines[0].options.askUser;
    const dialog = detectDialog(fixtureText("tool-bash-screen.txt")) as Dialog;

    answer = async () => ({ outcome: { outcome: "selected", optionId: "3" } });
    const signal = new AbortController().signal;
    expect(await askUser?.(dialog, signal)).toEqual({ label: "No", kind: "reject_once", row: 3 });
    const [{ params, signal: sentSignal }] = permissions;
    expect(sentSignal).toBe(signal);
    expect(params).toEqual({
      sessionId,
      toolCall: {
        toolCallId: expect.stringMatching(/^dialog-/),
        title: "Do you want to proceed?",
        kind: "other",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: dialog.excerpt } }],
      },
      options: [
        { optionId: "0", name: "Yes", kind: "allow_once" },
        {
          optionId: "1",
          name: expect.stringMatching(/^Yes, and don't ask again/),
          kind: "allow_always",
        },
        { optionId: "3", name: "No", kind: "reject_once" },
      ],
    });

    answer = async () => ({ outcome: { outcome: "cancelled" } });
    expect(await askUser?.(dialog, signal)).toBeUndefined();
    answer = async () => Promise.reject(new Error("connection closed"));
    expect(await askUser?.(dialog, signal)).toBeUndefined();
    engines[0].end({ stopReason: "end_turn" });
    await turn;
  });

  it("resolves session/close and dispose once the CLI exited", async () => {
    const one = await agent.newSession({ cwd: "/work", mcpServers: [] });
    const two = await agent.newSession({ cwd: "/work", mcpServers: [] });
    for (const { sessionId } of [one, two]) {
      const turn = prompt(sessionId);
      await vi.waitFor(() => expect(engines.at(-1)?.prompts).toEqual(["hi"]));
      engines.at(-1)?.end({ stopReason: "end_turn" });
      await turn;
    }
    let closed = false;
    const close = agent.closeSession({ sessionId: one.sessionId }).then(() => (closed = true));
    await vi.waitFor(() => expect(engines[0].exited).toBeDefined());
    expect(closed).toBe(false);
    engines[0].exited?.();
    await close;

    let disposed = false;
    const dispose = agent.dispose().then(() => (disposed = true));
    await vi.waitFor(() => expect(engines[1].exited).toBeDefined());
    expect(disposed).toBe(false);
    engines[1].exited?.();
    await dispose;
  });

  it("starts the CLI with the model set before the first prompt and refuses a change after", async () => {
    const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] });
    const { configOptions } = await agent.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "claude-haiku-5-5",
    });
    expect(configOptions[0]).toMatchObject({ category: "model", currentValue: "claude-haiku-5-5" });

    const turn = prompt(sessionId, "count lines");
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    expect(engines[0].options).toEqual({
      cwd: "/work",
      sessionId,
      model: "claude-haiku-5-5",
      permissionMode: "auto",
      askUser: expect.any(Function),
    });
    engines[0].end({ stopReason: "turn_duration" });
    expect(await turn).toEqual({ stopReason: "end_turn" });

    await expect(
      agent.setSessionConfigOption({ sessionId, configId: "model", value: "opus" }),
    ).rejects.toThrow("can't change once the session's Claude CLI runs");
  });

  it("fails the prompt with the engine's error and closes the open tool calls", async () => {
    const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] });
    const turn = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    engines[0].records = fixture("code-mode-sonnet").slice(0, 8);
    engines[0].end(
      new Error(
        "The Claude CLI waits on a screen the adapter can't answer.\n\nScreen:\nDo you want to proceed?",
      ),
    );
    const error = await turn.catch((caught) => caught);
    expect(error).toBeInstanceOf(RequestError);
    expect(error.message).toContain("Screen:\nDo you want to proceed?");
    expect(sent.at(-1)?.update).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_01WGxYEgNhS5Zty549XXtNsC",
      status: "failed",
    });
  });

  it("refuses a prompt while a turn runs and runs one sent right after a cancel", async () => {
    const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] });
    const first = prompt(sessionId, "first");
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    await expect(prompt(sessionId, "again")).rejects.toThrow("Try again when the turn ends");

    await agent.cancel({ sessionId });
    const second = prompt(sessionId, "second");
    expect(await first).toEqual({ stopReason: "cancelled" });
    await vi.waitFor(() => expect(engines[0].prompts).toEqual(["first", "second"]));
    engines[0].end({ stopReason: "end_turn" });
    expect(await second).toEqual({ stopReason: "end_turn" });
    expect(engines[0].cancels).toBe(1);
  });

  it("starts another CLI at the prompt after the last one stopped", async () => {
    const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] });
    const first = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    engines[0].stopped = true;
    engines[0].end(new Error("Claude Code does not trust the folder /work."));
    await expect(first).rejects.toThrow("does not trust the folder /work");

    const second = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(2));
    engines[1].end({ stopReason: "end_turn" });
    await second;
  });

  it("starts another CLI when the last one stopped after its cancelled turn returned", async () => {
    const { sessionId } = await agent.newSession({ cwd: "/work", mcpServers: [] });
    const first = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    await agent.cancel({ sessionId });
    expect(await first).toEqual({ stopReason: "cancelled" });
    // As a cancel during the trust question: the CLI exits after the turn returned.
    engines[0].stopped = true;

    const second = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(2));
    engines[1].end({ stopReason: "end_turn" });
    expect(await second).toEqual({ stopReason: "end_turn" });
  });

  it("replays a loaded session's transcript and resumes it at the next prompt", async () => {
    const records = fixture("code-mode-haiku");
    const sessionId = records[0].sessionId as string;
    mkdirSync(path.join(configDir, "projects", "-work"), { recursive: true });
    writeFileSync(
      path.join(configDir, "projects", "-work", `${sessionId}.jsonl`),
      records.map((record) => JSON.stringify(record) + "\n").join(""),
    );

    await agent.loadSession({ sessionId, cwd: "/work", mcpServers: [] });
    expect(engines).toEqual([]);
    const kinds = sent.map(({ update }) => update.sessionUpdate);
    expect(kinds[0]).toBe("user_message_chunk");
    expect(kinds.at(-1)).toBe("agent_message_chunk");
    expect(sent.map(({ update }) => update)).toContainEqual(
      expect.objectContaining({
        toolCallId: "toolu_01BxW3LTQLSWmeoyax9wXD5c",
        status: "completed",
      }),
    );

    const turn = prompt(sessionId);
    await vi.waitFor(() => expect(engines).toHaveLength(1));
    expect(engines[0].options).toMatchObject({ resume: sessionId });
    expect(engines[0].options).not.toHaveProperty("sessionId");
    engines[0].end({ stopReason: "end_turn" });
    await turn;
  });

  it("refuses to load a session Claude Code does not have", async () => {
    await expect(
      agent.loadSession({
        sessionId: "00000000-0000-4000-8000-0000000000ff",
        cwd: "/work",
        mcpServers: [],
      }),
    ).rejects.toThrow("Claude Code has no session");
  });
});
